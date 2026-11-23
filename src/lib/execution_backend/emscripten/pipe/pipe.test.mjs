import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { closePipe, createPipe, PipeClosedError, PipeReader, PipeWriter } from "./pipe.ts";

const PIPE_URL = new URL("./pipe.ts", import.meta.url).href;

/** Run `body` in a worker thread with `pipe` (a SharedArrayBuffer) and PipeWriter/PipeReader in scope. */
function inWorker(body, workerData) {
  const source = `
    import { workerData, parentPort } from "node:worker_threads";
    import { PipeReader, PipeWriter, PipeClosedError } from ${JSON.stringify(PIPE_URL)};
    const { pipe } = workerData;
    try {
      const result = await (async () => { ${body} })();
      parentPort.postMessage({ ok: true, result });
    } catch (error) {
      parentPort.postMessage({ ok: false, name: error.name, message: error.message });
    }
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData });
  return new Promise((resolve, reject) => {
    worker.once("message", message => {
      void worker.terminate();
      resolve(message);
    });
    worker.once("error", reject);
  });
}

function readAll(reader, chunk = 64 * 1024) {
  const hash = createHash("sha256");
  const buffer = new Uint8Array(chunk);
  let total = 0;
  for (;;) {
    const count = reader.read(buffer, 0, buffer.byteLength);
    if (count === 0) return { total, digest: hash.digest("hex") };
    hash.update(buffer.subarray(0, count));
    total += count;
  }
}

test("passes bytes through in order, with end of file after the writer closes", () => {
  const pipe = createPipe(16);
  const writer = new PipeWriter(pipe);
  const reader = new PipeReader(pipe);
  writer.write(new TextEncoder().encode("hello "));
  writer.write(new TextEncoder().encode("pipe"));
  writer.close();
  const target = new Uint8Array(32);
  // Reads return what is buffered, not the full length asked for.
  assert.equal(reader.read(target, 0, 32), 10);
  assert.equal(new TextDecoder().decode(target.subarray(0, 10)), "hello pipe");
  assert.equal(reader.read(target, 0, 32), 0);
});

test("wraps around the end of the buffer and the 32-bit counters", () => {
  const pipe = createPipe(8);
  // Start both counters just below the signed and the unsigned 32-bit limits.
  for (const start of [0x7ffffffc, -3]) {
    const header = new Int32Array(pipe, 0, 8);
    header.fill(0);
    header[0] = start;
    header[1] = start;
    const writer = new PipeWriter(pipe);
    const reader = new PipeReader(pipe);
    const target = new Uint8Array(8);
    for (let round = 0; round < 5; round++) {
      writer.write(Uint8Array.of(round, round + 1, round + 2, round + 3, round + 4, round + 5));
      assert.equal(reader.read(target, 0, 8), 6);
      assert.deepEqual([...target.subarray(0, 6)], [0, 1, 2, 3, 4, 5].map(value => value + round));
    }
  }
});

test("writes into an Int8Array view at an offset, as Emscripten's HEAP8 is", () => {
  const pipe = createPipe(8);
  new PipeWriter(pipe).write(Uint8Array.of(200, 1, 2));
  const heap = new Int8Array(16);
  assert.equal(new PipeReader(pipe).read(heap, 5, 3), 3);
  assert.deepEqual([...heap.subarray(5, 8)], [-56, 1, 2]);
});

test("the writer gets EPIPE once the reader has closed", () => {
  const pipe = createPipe(8);
  const writer = new PipeWriter(pipe);
  new PipeReader(pipe).close();
  assert.throws(() => writer.write(Uint8Array.of(1)), PipeClosedError);
});

test("closePipe ends both sides", () => {
  const pipe = createPipe(8);
  closePipe(pipe);
  assert.equal(new PipeReader(pipe).read(new Uint8Array(4), 0, 4), 0);
  assert.throws(() => new PipeWriter(pipe).write(Uint8Array.of(1)), PipeClosedError);
});

test("rejects capacities that are not powers of two", () => {
  assert.throws(() => createPipe(1000), RangeError);
});

test("streams 64 MiB between threads through a 64 KiB buffer, byte for byte", async () => {
  const pipe = createPipe(64 * 1024);
  const size = 64 * 1024 * 1024;
  // The writer sends a pseudo-random pattern in uneven chunks; the hash proves order and content.
  const sent = inWorker(`
    const { createHash, randomBytes } = await import("node:crypto");
    const writer = new PipeWriter(pipe);
    const hash = createHash("sha256");
    const block = randomBytes(1 << 20);
    let sent = 0;
    while (sent < ${size}) {
      const count = Math.min(${size} - sent, 1 + Math.floor(Math.random() * 300000));
      const offset = Math.floor(Math.random() * (block.length - count + 1));
      const chunk = block.subarray(offset, offset + count);
      writer.write(chunk);
      hash.update(chunk);
      sent += count;
    }
    writer.close();
    return hash.digest("hex");
  `, { pipe });
  // Read in uneven sizes too, on this thread.
  const reader = new PipeReader(pipe);
  const hash = createHash("sha256");
  const buffer = new Uint8Array(100_003);
  let total = 0;
  for (;;) {
    const count = reader.read(buffer, 0, 1 + Math.floor(Math.random() * buffer.length));
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    total += count;
  }
  const result = await sent;
  assert.equal(result.ok, true, result.message);
  assert.equal(total, size);
  assert.equal(hash.digest("hex"), result.result);
});

test("a blocked writer fails with EPIPE when the reader exits early, like `| head`", async () => {
  const pipe = createPipe(1024);
  const writing = inWorker(`
    const writer = new PipeWriter(pipe);
    const chunk = new Uint8Array(4096);
    for (let i = 0; i < 1000; i++) writer.write(chunk);
    return "finished";
  `, { pipe });
  const reader = new PipeReader(pipe);
  assert.equal(reader.read(new Uint8Array(100), 0, 100), 100);
  reader.close();
  const result = await writing;
  assert.equal(result.ok, false);
  assert.equal(result.name, "PipeClosedError");
});

test("a blocked reader sees end of file when the pipe is closed from outside (crash or cancel)", async () => {
  const pipe = createPipe(1024);
  const reading = inWorker(`
    return new PipeReader(pipe).read(new Uint8Array(10), 0, 10);
  `, { pipe });
  // Let the worker start and block.
  await new Promise(resolve => setTimeout(resolve, 200));
  closePipe(pipe);
  assert.deepEqual(await reading, { ok: true, result: 0 });
});

test("a transfer read in odd sizes arrives complete", async () => {
  const pipe = createPipe(4096);
  const data = randomBytes(100_000);
  const writing = inWorker(`
    const writer = new PipeWriter(pipe);
    writer.write(new Uint8Array(workerData.data));
    writer.close();
  `, { pipe, data });
  const { total, digest } = readAll(new PipeReader(pipe), 777);
  await writing;
  assert.equal(total, data.length);
  assert.equal(digest, createHash("sha256").update(data).digest("hex"));
});
