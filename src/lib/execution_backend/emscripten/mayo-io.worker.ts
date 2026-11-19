/// <reference lib="webworker" />

/**
 * I/O worker: performs asynchronous File System Access calls on behalf of the tool worker.
 *
 * The tool worker posts a request, then blocks in Atomics.wait. This worker stays free to
 * await browser file APIs, writes the reply into shared memory, and wakes the tool worker.
 */

import {
  CONTROL_LENGTH,
  CONTROL_STATE,
  CONTROL_STATUS,
  STATE_DONE,
  STATUS_ERROR,
  STATUS_OK,
  type MayoIOReady,
  type MayoIORequest,
  type MayoIOSetup,
} from "./mayo-io.protocol";

declare const self: DedicatedWorkerGlobalScope;

let control: Int32Array | undefined;
let data: Uint8Array | undefined;
let root: FileSystemDirectoryHandle | undefined;

/** Resolve a root-relative path, refusing anything that could escape the selected folder. */
async function getFileHandle(path: string): Promise<FileSystemFileHandle> {
  if (!root) throw new Error("No directory is mounted.");
  const parts = path.split("/").filter(part => part !== "");
  if (parts.length === 0 || parts.some(part => part === "." || part === "..")) {
    throw new Error(`Invalid path: ${path}`);
  }
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory.getFileHandle(parts[parts.length - 1]);
}

/** Return the reply bytes for one request; they must fit in the shared data buffer. */
async function handle(request: MayoIORequest): Promise<Uint8Array> {
  switch (request.type) {
    case "stat": {
      const file = await (await getFileHandle(request.path)).getFile();
      return new TextEncoder().encode(JSON.stringify({ size: file.size }));
    }
    case "read": {
      // slice() reads only the requested range, so large files are never fully loaded.
      const file = await (await getFileHandle(request.path)).getFile();
      const end = request.offset + request.length;
      return new Uint8Array(await file.slice(request.offset, end).arrayBuffer());
    }
  }
}

function reply(status: number, bytes: Uint8Array): void {
  if (!control || !data) return;
  const length = Math.min(bytes.byteLength, data.byteLength);
  data.set(bytes.subarray(0, length));
  Atomics.store(control, CONTROL_STATUS, status);
  Atomics.store(control, CONTROL_LENGTH, length);
  Atomics.store(control, CONTROL_STATE, STATE_DONE);
  Atomics.notify(control, CONTROL_STATE);
}

self.addEventListener("message", async (event: MessageEvent<MayoIORequest | MayoIOSetup>) => {
  const message = event.data;
  if (message.type === "setup") {
    control = new Int32Array(message.buffer, 0, 4);
    data = new Uint8Array(message.buffer, 16);
    root = message.directory;
    self.postMessage({ type: "ready" } satisfies MayoIOReady);
    return;
  }
  try {
    reply(STATUS_OK, await handle(message));
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    reply(STATUS_ERROR, new TextEncoder().encode(text));
  }
});
