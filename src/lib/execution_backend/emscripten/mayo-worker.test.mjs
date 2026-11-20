import assert from "node:assert/strict";
import test from "node:test";
import { Mayo } from "./mayo.ts";
import { MayoFilesystem } from "./mayo-filesystem.ts";

test("keeps the previous recursive snapshot if a scan fails", async () => {
  let fail = false;
  const nested = {
    name: "nested",
    kind: "directory",
    async *values() {
      if (fail) throw new Error("permission denied");
      yield { name: "reads.fastq", kind: "file" };
    },
  };
  const root = {
    name: "root",
    kind: "directory",
    async *values() { yield nested; },
  };
  const filesystem = new MayoFilesystem();
  const tree = await filesystem.init(root);
  assert.deepEqual(tree.children[0].children, [{ name: "reads.fastq", kind: "file" }]);
  fail = true;
  await assert.rejects(filesystem.refreshTree(), /permission denied/);
  assert.equal(filesystem.getTree(), tree);
});

test("routes worker responses and rejects pending requests on close", async () => {
  const originalWorker = globalThis.Worker;
  let worker;
  class FakeWorker extends EventTarget {
    messages = [];
    constructor() { super(); worker = this; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    reply(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  }
  globalThis.Worker = FakeWorker;
  try {
    const mayo = new Mayo();
    const tree = { name: "root", kind: "directory", children: [] };
    const first = mayo.getTree();
    const second = mayo.refreshTree();
    worker.reply({ id: worker.messages[1].id, ok: true, result: { type: "tree", tree } });
    worker.reply({ id: worker.messages[0].id, ok: false, error: { name: "NotAllowedError", message: "denied" } });
    assert.deepEqual(await second, tree);
    await assert.rejects(first, { name: "NotAllowedError", message: "denied" });

    const pending = mayo.getTree();
    mayo.close();
    await assert.rejects(pending, /closed/);
    await assert.rejects(mayo.getTree(), /closed/);
    assert.equal(worker.terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test("rejects pending requests if the worker fails", async () => {
  const originalWorker = globalThis.Worker;
  let worker;
  class FakeWorker extends EventTarget {
    constructor() { super(); worker = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  try {
    const mayo = new Mayo();
    const pending = mayo.getTree();
    worker.dispatchEvent(new Event("messageerror"));
    await assert.rejects(pending, /deserialize/);
    assert.equal(worker.terminated, true);
    await assert.rejects(mayo.getTree(), /closed/);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
