/// <reference lib="webworker" />

import { MayoFS } from "./mayo-fs";
import { MayoTree } from "./mayo-tree";
import type { MayoRequest, MayoResponse, MayoResult } from "./mayo.protocol";

declare const self: DedicatedWorkerGlobalScope;

const tree = new MayoTree();
const fs = new MayoFS();

/** Process one operation at a time so root and snapshot changes cannot race. */
async function execute(request: MayoRequest): Promise<MayoResult> {
  switch (request.type) {
    case "init": {
      // Mount only after the scan succeeds, so a failed init keeps the previous root.
      const snapshot = await tree.init(request.directory);
      await fs.mount(request.directory);
      return { type: "tree", tree: snapshot };
    }
    case "getTree":
      return { type: "tree", tree: tree.getTree() };
    case "refreshTree":
      return { type: "tree", tree: await tree.refreshTree() };
    case "readFile":
      return { type: "bytes", data: fs.readFile(request.path) };
    case "writeFile":
      fs.writeFile(request.path, request.data);
      return { type: "done" };
    case "removeFile":
      fs.removeFile(request.path);
      return { type: "done" };
  }
}

async function respond(request: MayoRequest): Promise<void> {
  let response: MayoResponse;
  try {
    response = { id: request.id, ok: true, result: await execute(request) };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "Error", message: String(error) },
    };
  }
  self.postMessage(response);
}

// Keep requests in arrival order, including when a directory scan awaits browser I/O.
let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<MayoRequest>) => {
  queue = queue.then(() => respond(event.data)).catch((error: unknown) => {
    // A response that cannot be sent is fatal: make the main thread reject pending requests.
    setTimeout(() => { throw error; }, 0);
  });
});
