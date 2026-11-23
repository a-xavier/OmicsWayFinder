/// <reference lib="webworker" />

/**
 * The coordinator: the worker behind the Mayo class (mayo.ts). It answers the page's requests one
 * at a time: the folder tree, file reads and writes, URLs, loading tools and running commands.
 * It starts the I/O worker and the tool workers, and never runs a tool itself.
 */

import { IOClient } from "../io/client";
import { IOHost } from "../io/host";
import type { MayoMessage, MayoProgress, MayoRequest, MayoResult } from "../protocol";
import { FolderTree } from "./folder-tree";
import { downloadToFolder, linkUrl, RemoteChecker } from "./remote";
import { CommandRunner } from "./runner";
import { ToolRegistry } from "./tools";

declare const self: DedicatedWorkerGlobalScope;

const tree = new FolderTree();
const host = new IOHost();
// The coordinator's own connection, for readFile, writeFile, addUrl and download.
const io = new IOClient();
const checker = new RemoteChecker();
const tools = new ToolRegistry(host);
const runner = new CommandRunner(tools, io, checker);

/** Connect (again, after a timed-out request dropped the connection). */
async function connectFS(): Promise<void> {
  if (io.connected || !globalThis.crossOriginIsolated) return;
  io.connect((await host.connect()).connection);
}

/** Process one operation at a time so root and snapshot changes cannot race. */
async function execute(request: MayoRequest): Promise<MayoResult> {
  if (["readFile", "writeFile", "removeFile", "addUrl", "download"].includes(request.type)) await connectFS();
  switch (request.type) {
    case "init": {
      // Switch folders only after the scan succeeds, so a failed init keeps the previous root.
      const snapshot = await tree.init(request.directory);
      // Without cross-origin isolation the tree still works, but files cannot be read or run.
      if (globalThis.crossOriginIsolated) {
        await host.setRoot(request.directory);
        await connectFS();
        io.folder = true;
      }
      return { type: "tree", tree: snapshot };
    }
    case "getTree":
      return { type: "tree", tree: tree.getTree() };
    case "refreshTree":
      return { type: "tree", tree: await tree.refreshTree() };
    case "readFile":
      return { type: "bytes", data: io.readFile(request.path) };
    case "writeFile":
      io.writeFile(request.path, request.data);
      return { type: "done" };
    case "removeFile":
      io.removeFile(request.path);
      return { type: "done" };
    case "loadTools":
      return { type: "tools", tools: await tools.load(request.tools) };
    case "exec": {
      const onStderr = request.liveStderr
        ? (stage: number, text: string) => self.postMessage({ id: request.id, progress: "stderr", stage, text } satisfies MayoProgress)
        : undefined;
      return { type: "exec", result: await runner.exec(request.pipelines, onStderr) };
    }
    case "cancel":
      runner.cancel();
      return { type: "done" };
    case "addUrl":
      return { type: "added", size: await linkUrl(io, checker, request.url, request.path) };
    case "download":
      return { type: "downloaded", bytes: await downloadToFolder(io, request.url, request.path) };
  }
}

async function respond(request: MayoRequest): Promise<void> {
  let response: MayoMessage;
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

function fatal(error: unknown): void {
  // A response that cannot be sent is fatal: make the main thread reject pending requests.
  setTimeout(() => { throw error; }, 0);
}

// Keep requests in arrival order, including when a directory scan awaits browser I/O.
// Cancel skips the queue: it must reach the exec it stops.
let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<MayoRequest>) => {
  if (event.data.type === "cancel") {
    respond(event.data).catch(fatal);
    return;
  }
  queue = queue.then(() => respond(event.data)).catch(fatal);
});
