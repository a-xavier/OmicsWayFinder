/**
 * IOClient: synchronous access to the selected folder and to remote files, for code that must
 * not await (Emscripten filesystem callbacks).
 *
 * File System Access handles and fetch are asynchronous. IOClient sends each request to the I/O
 * worker (io/worker.ts), then blocks with Atomics.wait until that worker writes the reply into a
 * SharedArrayBuffer. This needs cross-origin isolation (COOP/COEP headers) and must run in a worker.
 *
 * Each tool worker has its own IOClient (its own channel and buffer), so tools running at the same
 * time in a pipeline do not wait for each other. Errors keep the browser's DOMException name
 * (NotFoundError, TypeMismatchError, ...) so tool/folder-fs.ts can map them to errno codes.
 */

import type { RemoteFile, RemoteStats } from "../shared/urls";
import {
  connectionViews,
  CONTROL_LENGTH,
  CONTROL_STATE,
  CONTROL_STATUS,
  DATA_CAPACITY,
  ISOLATION_MESSAGE,
  STATE_IDLE,
  STATE_PENDING,
  STATUS_OK,
  type IOConnection,
  type IOEntry,
  type IOKind,
  type IOOpenRead,
  type IORequest,
  type IOStat,
} from "./protocol";

// Fail instead of hanging forever if the I/O worker stops responding. Generous, because a
// remote read may fetch several MiB over a slow connection.
const REQUEST_TIMEOUT_MS = 120_000;

export class IOClient {
  private port: MessagePort | undefined;
  private control: Int32Array | undefined;
  private data: Uint8Array | undefined;
  /** Set by the owner: a folder is selected, so file calls can succeed. */
  folder = false;

  /** Use a connection from IOHost.connect (or none). */
  connect(connection: IOConnection | undefined): void {
    this.port?.close();
    this.port = connection?.port;
    const views = connection && connectionViews(connection.buffer);
    this.control = views?.control;
    this.data = views?.data;
  }

  get connected(): boolean {
    return this.port !== undefined;
  }

  /** True when synchronous file calls can be made: connected, with a folder selected. */
  get ready(): boolean {
    return this.folder && this.port !== undefined;
  }

  /** File or directory information; "" is the selected folder. */
  stat(path: string): IOStat {
    return this.sendJSON<IOStat>({ type: "stat", path });
  }

  /** Names and kinds of a directory's entries; "" is the selected folder. */
  list(path: string): IOEntry[] {
    return this.sendJSON<IOEntry[]>({ type: "list", path });
  }

  /** Open a file for reading. Reads see the file as it was when opened. Close the handle when done. */
  openRead(path: string): IOOpenRead {
    return this.sendJSON<IOOpenRead>({ type: "openRead", path });
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

  /** abort() after a failure, ignoring a second error: the handle may already be closed, or the I/O worker stopped. */
  abortQuietly(id: number): void {
    try {
      this.abort(id);
    } catch {
      // Keep the first error.
    }
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
  create(path: string, kind: IOKind): void {
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
    const id = this.openWrite(path, false);
    try {
      this.writeAt(id, 0, bytes);
      this.close(id);
    } catch (error) {
      // Discard the temporary file so the original stays untouched.
      this.abortQuietly(id);
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
   * Bytes of a remote file from `offset`: at most `length`, and not past the chunk (REMOTE_CHUNK_SIZE) holding
   * `offset`. `ahead` chunks are fetched at once on a cache miss. Throws an error named ReadError.
   */
  remoteRead(file: RemoteFile, offset: number, length: number, ahead: number): Uint8Array {
    return this.send({ type: "remoteRead", url: file.url, size: file.size, offset, length, ahead });
  }

  /** Range requests made and bytes received for this client since the last call. */
  remoteStats(): RemoteStats {
    return this.sendJSON<RemoteStats>({ type: "remoteStats" });
  }

  private sendJSON<T>(request: IORequest): T {
    return JSON.parse(new TextDecoder().decode(this.send(request))) as T;
  }

  /**
   * Post a request and block this worker until the I/O worker replies.
   * `payload` (at most DATA_CAPACITY bytes) is placed in the shared data area for the I/O worker.
   */
  private send(request: IORequest, payload?: Uint8Array): Uint8Array {
    if (!this.port || !this.control || !this.data) {
      throw new Error(globalThis.crossOriginIsolated ? "Mayo I/O worker is not connected." : ISOLATION_MESSAGE);
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

/**
 * Collects consecutive writes into blocks of up to DATA_CAPACITY, so many small writes cost one
 * round trip to the I/O worker. `send` writes one block at a position (IOClient.writeAt).
 */
export class WriteBuffer {
  private readonly send: (position: number, bytes: Uint8Array) => void;
  private block: Uint8Array | undefined;
  private start = 0;
  private length = 0;

  constructor(send: (position: number, bytes: Uint8Array) => void) {
    this.send = send;
  }

  /** Write bytes at a position. Small writes are copied, so the caller may reuse its buffer. */
  write(position: number, bytes: Uint8Array): void {
    const appends = this.length > 0 && position === this.start + this.length;
    if (appends && this.length + bytes.byteLength <= DATA_CAPACITY) {
      this.block!.set(bytes, this.length);
      this.length += bytes.byteLength;
      return;
    }
    this.flush();
    if (bytes.byteLength >= DATA_CAPACITY) {
      this.send(position, bytes);
      return;
    }
    this.block ??= new Uint8Array(DATA_CAPACITY);
    this.block.set(bytes);
    this.start = position;
    this.length = bytes.byteLength;
  }

  /** Send the collected bytes. They are dropped even if sending fails. */
  flush(): void {
    if (this.length === 0) return;
    const bytes = this.block!.subarray(0, this.length);
    this.length = 0;
    this.send(this.start, bytes);
  }
}

/** Turn the I/O worker's "Name: message" text back into an error with that name. */
function ioError(text: string): Error {
  const match = /^(\w+): ([\s\S]*)$/.exec(text);
  const error = new Error(match ? match[2] : text);
  if (match) error.name = match[1];
  return error;
}
