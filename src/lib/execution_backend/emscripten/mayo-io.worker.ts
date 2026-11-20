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
  type MayoIOEntry,
  type MayoIOOpenRead,
  type MayoIOReady,
  type MayoIORequest,
  type MayoIOSetup,
  type MayoIOStat,
} from "./mayo-io.protocol";

declare const self: DedicatedWorkerGlobalScope;

let control: Int32Array | undefined;
let data: Uint8Array | undefined;
let root: FileSystemDirectoryHandle | undefined;

// Open read handles by id: a File snapshot, so reads don't call getFile() each time.
const readers = new Map<number, File>();
// Open write streams by id. Data goes to a temporary file (<name>.crswap in a real folder)
// and replaces the target only on close.
const writers = new Map<number, FileSystemWritableFileStream>();
let nextId = 1;

function splitPath(path: string): string[] {
  const parts = path.split("/").filter(part => part !== "");
  if (parts.some(part => part === "." || part === "..")) throw new Error(`Invalid path: ${path}`);
  return parts;
}

/**
 * Resolve a root-relative path to its parent folder and final name, refusing anything that
 * could escape the selected folder. Parent directories must already exist.
 */
async function resolveParent(path: string): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
  if (!root) throw new Error("No directory is mounted.");
  const parts = splitPath(path);
  if (parts.length === 0) throw new Error(`Invalid path: ${path}`);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = await parent.getDirectoryHandle(part);
  }
  return { parent, name: parts[parts.length - 1] };
}

/** Get a file handle; `create` only creates the final file, never missing parents. */
async function getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
  const { parent, name } = await resolveParent(path);
  return parent.getFileHandle(name, { create });
}

/** Get a file or directory handle; "" is the selected folder. */
async function getEntry(path: string): Promise<FileSystemFileHandle | FileSystemDirectoryHandle> {
  if (!root) throw new Error("No directory is mounted.");
  if (splitPath(path).length === 0) return root;
  const { parent, name } = await resolveParent(path);
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    // TypeMismatchError: the entry exists but is a directory.
    if (error instanceof DOMException && error.name === "TypeMismatchError") return parent.getDirectoryHandle(name);
    throw error;
  }
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function getReader(id: number): File {
  const reader = readers.get(id);
  if (!reader) throw new Error(`Unknown read handle: ${id}`);
  return reader;
}

function getWriter(id: number): FileSystemWritableFileStream {
  const writer = writers.get(id);
  if (!writer) throw new Error(`Unknown write handle: ${id}`);
  return writer;
}

/** Return the reply bytes for one request; they must fit in the shared data buffer. */
async function handle(request: MayoIORequest): Promise<Uint8Array> {
  switch (request.type) {
    case "stat": {
      const entry = await getEntry(request.path);
      if (entry.kind === "directory") return json({ kind: "directory", size: 0, mtime: 0 } satisfies MayoIOStat);
      const file = await entry.getFile();
      return json({ kind: "file", size: file.size, mtime: file.lastModified } satisfies MayoIOStat);
    }
    case "list": {
      const entry = await getEntry(request.path);
      if (entry.kind !== "directory") throw new DOMException(`Not a directory: ${request.path}`, "TypeMismatchError");
      const entries: MayoIOEntry[] = [];
      for await (const [name, handle] of entry.entries()) entries.push({ name, kind: handle.kind });
      return json(entries);
    }
    case "openRead": {
      const file = await (await getFileHandle(request.path)).getFile();
      const id = nextId++;
      readers.set(id, file);
      return json({ id, size: file.size, mtime: file.lastModified } satisfies MayoIOOpenRead);
    }
    case "read": {
      // slice() reads only the requested range, so large files are never fully loaded.
      // If the file changed on disk since openRead, this fails with NotReadableError.
      const end = request.offset + request.length;
      return new Uint8Array(await getReader(request.id).slice(request.offset, end).arrayBuffer());
    }
    case "openWrite": {
      const handle = await getFileHandle(request.path, true);
      const writer = await handle.createWritable({ keepExistingData: request.keepExistingData ?? false });
      const id = nextId++;
      writers.set(id, writer);
      return json({ id });
    }
    case "write": {
      // slice() copies out of shared memory: file streams reject SharedArrayBuffer views,
      // and the tool worker reuses the buffer for the next chunk.
      const bytes = data!.slice(0, request.length);
      const writer = getWriter(request.id);
      if (request.position === undefined) await writer.write(bytes);
      else await writer.write({ type: "write", position: request.position, data: bytes });
      return new Uint8Array();
    }
    case "truncateHandle": {
      await getWriter(request.id).truncate(request.size);
      return new Uint8Array();
    }
    case "truncate": {
      const handle = await getFileHandle(request.path);
      const writer = await handle.createWritable({ keepExistingData: request.size > 0 });
      try {
        await writer.truncate(request.size);
      } catch (error) {
        await writer.abort();
        throw error;
      }
      await writer.close();
      return new Uint8Array();
    }
    case "create": {
      const { parent, name } = await resolveParent(request.path);
      if (request.kind === "directory") await parent.getDirectoryHandle(name, { create: true });
      else await parent.getFileHandle(name, { create: true });
      return new Uint8Array();
    }
    case "rmdir": {
      // removeEntry without recursive fails on a non-empty directory (InvalidModificationError).
      const { parent, name } = await resolveParent(request.path);
      await parent.getDirectoryHandle(name);
      await parent.removeEntry(name);
      return new Uint8Array();
    }
    case "rename": {
      const entry = await getEntry(request.from);
      if (entry === root) throw new Error(`Invalid path: ${request.from}`);
      // Chrome only implements move() on file handles.
      if (entry.kind === "directory") {
        throw new DOMException(`Renaming folders is not supported: ${request.from}`, "NotSupportedError");
      }
      const { parent, name } = await resolveParent(request.to);
      // move() is not in TypeScript's DOM types yet. Like rename(), replace an existing file.
      const target = await parent.getFileHandle(name).catch(() => undefined);
      if (target && entry.kind === "file" && !(await entry.isSameEntry(target))) await parent.removeEntry(name);
      await (entry as unknown as { move(parent: FileSystemDirectoryHandle, name: string): Promise<void> }).move(parent, name);
      return new Uint8Array();
    }
    case "close": {
      if (readers.delete(request.id)) return new Uint8Array();
      const writer = getWriter(request.id);
      writers.delete(request.id);
      await writer.close();
      return new Uint8Array();
    }
    case "abort": {
      const writer = getWriter(request.id);
      writers.delete(request.id);
      await writer.abort();
      return new Uint8Array();
    }
    case "remove": {
      // Like unlink(): check the entry is a file first, because removeEntry would also
      // remove an empty directory.
      const { parent, name } = await resolveParent(request.path);
      await parent.getFileHandle(name);
      await parent.removeEntry(name);
      return new Uint8Array();
    }
  }
}

function reply(status: number, bytes: Uint8Array): void {
  if (!control || !data) return;
  if (bytes.byteLength > data.byteLength) {
    status = STATUS_ERROR;
    bytes = new TextEncoder().encode(`RangeError: Reply too large for the shared buffer (${bytes.byteLength} bytes).`);
  }
  const length = bytes.byteLength;
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
