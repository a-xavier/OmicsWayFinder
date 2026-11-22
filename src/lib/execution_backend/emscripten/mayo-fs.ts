/**
 * Synchronous file access to the user-selected folder, for Emscripten tools.
 *
 * Emscripten calls filesystem callbacks synchronously, but File System Access handles are
 * asynchronous. MayoFS bridges the two: it sends each request to the I/O worker (see MayoIO),
 * then blocks with Atomics.wait until that worker writes the reply into a SharedArrayBuffer.
 * This requires cross-origin isolation (COOP/COEP headers) and must run in a worker.
 *
 * Each tool worker has its own MayoFS client (its own channel and buffer), so tools running
 * at the same time in a pipeline do not wait for each other's file calls.
 *
 * Tools reach these calls through the MAYOFS Emscripten filesystem (mayo-emscripten-fs.ts).
 * Errors keep the browser's DOMException name (NotFoundError, TypeMismatchError, ...) so
 * MAYOFS can map them to errno codes.
 */

import {
  CONNECTION_BYTES,
  CONTROL_LENGTH,
  CONTROL_STATE,
  CONTROL_STATUS,
  DATA_CAPACITY,
  STATE_IDLE,
  STATE_PENDING,
  STATUS_OK,
  type MayoIOConnection,
  type MayoIOControl,
  type MayoIOEntry,
  type MayoIOEvent,
  type MayoIOKind,
  type MayoIOOpenRead,
  type MayoIORequest,
  type MayoIOStat,
} from "./mayo-io.protocol";
import type { RemoteFile, RemoteStats } from "./mayo-url-fs";

// Fail instead of hanging forever if the I/O worker stops responding. Generous, because a
// remote read may fetch several MiB over a slow connection.
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The coordinator's handle on the I/O worker: starts it, sets the folder, and creates one
 * connection per client. Must run in the coordinator, which never blocks for long.
 */
export class MayoIO {
  private worker: Worker | undefined;
  private starting: Promise<Worker> | undefined;
  private nextClient = 1;

  /** Start the I/O worker if needed. Throws without cross-origin isolation. */
  async start(): Promise<void> {
    await this.ensure();
  }

  /** Use a folder (or none) from now on. Writes in progress are aborted. */
  async setRoot(directory: FileSystemDirectoryHandle | undefined): Promise<void> {
    const worker = await this.ensure();
    await new Promise<void>(resolve => {
      const listener = (event: MessageEvent<MayoIOEvent>) => {
        if (event.data.type !== "rooted") return;
        worker.removeEventListener("message", listener);
        resolve();
      };
      worker.addEventListener("message", listener);
      worker.postMessage({ type: "root", directory } satisfies MayoIOControl);
    });
  }

  /** A new client; send the connection to the worker that will use it (it is transferable). */
  async connect(): Promise<{ client: number; connection: MayoIOConnection }> {
    const worker = await this.ensure();
    const client = this.nextClient++;
    const channel = new MessageChannel();
    const buffer = new SharedArrayBuffer(CONNECTION_BYTES);
    worker.postMessage({ type: "connect", client, port: channel.port1, buffer } satisfies MayoIOControl, [channel.port1]);
    return { client, connection: { port: channel.port2, buffer } };
  }

  /** Forget a client whose worker was stopped; its unfinished writes are discarded. */
  disconnect(client: number): void {
    this.worker?.postMessage({ type: "disconnect", client } satisfies MayoIOControl);
  }

  private ensure(): Promise<Worker> {
    if (!globalThis.crossOriginIsolated) {
      return Promise.reject(new Error("Mayo needs cross-origin isolation (COOP/COEP headers) to run tools and use folders."));
    }
    this.starting ??= new Promise<Worker>((resolve, reject) => {
      const worker = new Worker(new URL("./mayo-io.worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (event: MessageEvent<MayoIOEvent>) => {
        if (event.data.type === "ready") resolve(worker);
      }, { once: true });
      worker.addEventListener("error", () => reject(new Error("Mayo I/O worker failed to start.")), { once: true });
    }).then(worker => (this.worker = worker), error => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }
}

/** A synchronous client of the I/O worker. */
export class MayoFS {
  private port: MessagePort | undefined;
  private control: Int32Array | undefined;
  private data: Uint8Array | undefined;
  /** Set by the owner: a folder is selected, so file calls can succeed. */
  folder = false;

  /** Use a connection from MayoIO.connect (or none). */
  connect(connection: MayoIOConnection | undefined): void {
    this.port?.close();
    this.port = connection?.port;
    this.control = connection ? new Int32Array(connection.buffer, 0, 4) : undefined;
    this.data = connection ? new Uint8Array(connection.buffer, 16) : undefined;
  }

  get connected(): boolean {
    return this.port !== undefined;
  }

  /** True when synchronous file calls can be made: connected, with a folder selected. */
  get ready(): boolean {
    return this.folder && this.port !== undefined;
  }

  /** File or directory information; "" is the selected folder. */
  stat(path: string): MayoIOStat {
    return this.sendJSON<MayoIOStat>({ type: "stat", path });
  }

  /** Names and kinds of a directory's entries; "" is the selected folder. */
  list(path: string): MayoIOEntry[] {
    return this.sendJSON<MayoIOEntry[]>({ type: "list", path });
  }

  /** Open a file for reading. Reads see the file as it was when opened. Close the handle when done. */
  openRead(path: string): MayoIOOpenRead {
    return this.sendJSON<MayoIOOpenRead>({ type: "openRead", path });
  }

  /** Read up to `length` bytes (at most DATA_CAPACITY) at `offset` from an open read handle. */
  read(id: number, offset: number, length: number): Uint8Array {
    return this.send({ type: "read", id, offset, length: Math.min(length, DATA_CAPACITY) });
  }

  /** Close a read handle, or a write handle (which saves the file). */
  close(id: number): void {
    this.send({ type: "close", id });
  }

  /**
   * Open a write handle (creating the file if needed). Writes go to a temporary copy, which
   * replaces the file on close(). keepExistingData starts the copy from the current contents.
   */
  openWrite(path: string, keepExistingData: boolean): number {
    return this.sendJSON<{ id: number }>({ type: "openWrite", path, keepExistingData }).id;
  }

  /** Write bytes at a position through a write handle, in chunks of at most DATA_CAPACITY. */
  writeAt(id: number, position: number, bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.byteLength; offset += DATA_CAPACITY) {
      const chunk = bytes.subarray(offset, offset + DATA_CAPACITY);
      this.send({ type: "write", id, length: chunk.byteLength, position: position + offset }, chunk);
    }
  }

  /** Discard a write handle's temporary copy, leaving the file unchanged. */
  abort(id: number): void {
    this.send({ type: "abort", id });
  }

  /** Resize the temporary copy of a write handle. */
  truncateHandle(id: number, size: number): void {
    this.send({ type: "truncateHandle", id, size });
  }

  /** Resize a file that is not open for writing. */
  truncate(path: string, size: number): void {
    this.send({ type: "truncate", path, size });
  }

  /** Create an empty file or a directory; parent folders must exist. */
  create(path: string, kind: MayoIOKind): void {
    this.send({ type: "create", path, kind });
  }

  /** Remove an empty directory, like rmdir(). */
  removeDirectory(path: string): void {
    this.send({ type: "rmdir", path });
  }

  /** Move a file or directory, replacing an existing file at the target, like rename(). */
  rename(from: string, to: string): void {
    this.send({ type: "rename", from, to });
  }

  /** Read a whole file synchronously, in chunks, through the I/O worker. */
  readFile(path: string): Uint8Array {
    const { id, size } = this.openRead(path);
    try {
      const result = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += DATA_CAPACITY) {
        result.set(this.read(id, offset, size - offset), offset);
      }
      return result;
    } finally {
      this.close(id);
    }
  }

  /**
   * Replace a whole file synchronously. The bytes are streamed in chunks to a temporary file,
   * which replaces the target only when every chunk is written. Parent folders must exist.
   */
  writeFile(path: string, bytes: Uint8Array): void {
    const { id } = this.sendJSON<{ id: number }>({ type: "openWrite", path });
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += DATA_CAPACITY) {
        const chunk = bytes.subarray(offset, offset + DATA_CAPACITY);
        this.send({ type: "write", id, length: chunk.byteLength }, chunk);
      }
      this.send({ type: "close", id });
    } catch (error) {
      // Discard the temporary file so the original stays untouched; keep the first error.
      try {
        this.abort(id);
      } catch {
        // The stream may already be closed, or the I/O worker may have been stopped.
      }
      throw error;
    }
  }

  /** Remove one file synchronously, like unlink(). Directories are refused. */
  removeFile(path: string): void {
    this.send({ type: "remove", path });
  }

  /** Size and date of a remote file, or null if it does not exist or cannot be read. */
  remoteStat(url: string): RemoteFile | null {
    return this.sendJSON<RemoteFile | null>({ type: "remoteStat", url });
  }

  /**
   * Bytes of a remote file from `offset`: at most `length`, and not past the 1 MiB chunk holding
   * `offset`. `ahead` chunks are fetched at once on a cache miss. Throws an error named ReadError.
   */
  remoteRead(file: RemoteFile, offset: number, length: number, ahead: number): Uint8Array {
    return this.send({ type: "remoteRead", url: file.url, size: file.size, offset, length, ahead });
  }

  /** Range requests made and bytes received for this client since the last call. */
  remoteStats(): RemoteStats {
    return this.sendJSON<RemoteStats>({ type: "remoteStats" });
  }

  private sendJSON<T>(request: MayoIORequest): T {
    return JSON.parse(new TextDecoder().decode(this.send(request))) as T;
  }

  /**
   * Post a request and block this worker until the I/O worker replies.
   * `payload` (at most DATA_CAPACITY bytes) is placed in the shared data area for the I/O worker.
   */
  private send(request: MayoIORequest, payload?: Uint8Array): Uint8Array {
    if (!this.port || !this.control || !this.data) {
      throw new Error(globalThis.crossOriginIsolated
        ? "Mayo I/O worker is not connected."
        : "Mayo file access requires cross-origin isolation (COOP/COEP headers).");
    }
    const control = this.control;
    if (payload) this.data.set(payload);
    // Mark pending before posting so the reply's notify cannot be missed.
    Atomics.store(control, CONTROL_STATE, STATE_PENDING);
    this.port.postMessage(request);
    if (Atomics.wait(control, CONTROL_STATE, STATE_PENDING, REQUEST_TIMEOUT_MS) === "timed-out") {
      this.connect(undefined);
      throw new Error("Mayo I/O worker did not respond.");
    }

    const bytes = this.data.slice(0, Atomics.load(control, CONTROL_LENGTH));
    const status = Atomics.load(control, CONTROL_STATUS);
    Atomics.store(control, CONTROL_STATE, STATE_IDLE);
    if (status !== STATUS_OK) throw ioError(new TextDecoder().decode(bytes));
    return bytes;
  }
}

/** Turn the I/O worker's "Name: message" text back into an error with that name. */
function ioError(text: string): Error {
  const match = /^(\w+): ([\s\S]*)$/.exec(text);
  const error = new Error(match ? match[2] : text);
  if (match) error.name = match[1];
  return error;
}
