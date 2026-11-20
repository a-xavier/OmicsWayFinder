/**
 * Shared filesystem for Emscripten tools, backed by the user-selected directory.
 *
 * Emscripten calls filesystem callbacks synchronously, but File System Access handles are
 * asynchronous. MayoFS bridges the two: it sends each request to a separate I/O worker, then
 * blocks with Atomics.wait until that worker writes the reply into a SharedArrayBuffer.
 * This requires cross-origin isolation (COOP/COEP headers).
 *
 * Tools reach these calls through the MAYOFS Emscripten filesystem (mayo-emscripten-fs.ts).
 * Errors keep the browser's DOMException name (NotFoundError, TypeMismatchError, ...) so
 * MAYOFS can map them to errno codes.
 */

import {
  CONTROL_LENGTH,
  CONTROL_STATE,
  CONTROL_STATUS,
  DATA_CAPACITY,
  STATE_IDLE,
  STATE_PENDING,
  STATUS_OK,
  type MayoIOEntry,
  type MayoIOKind,
  type MayoIOOpenRead,
  type MayoIOReady,
  type MayoIORequest,
  type MayoIOSetup,
  type MayoIOStat,
} from "./mayo-io.protocol";

// Fail instead of hanging forever if the I/O worker stops responding.
const REQUEST_TIMEOUT_MS = 30_000;

export class MayoFS {
  private directory: FileSystemDirectoryHandle | undefined;
  private io: Worker | undefined;
  private control: Int32Array | undefined;
  private data: Uint8Array | undefined;

  /**
   * Use the selected folder as the filesystem root and start a fresh I/O worker for it.
   *
   * This must be async: a nested worker only starts once its parent returns to the event
   * loop, so we wait for its "ready" message here, before any synchronous call can block.
   * Without cross-origin isolation the folder is still recorded, so tree operations keep
   * working, and file calls report the missing isolation.
   */
  async mount(directory: FileSystemDirectoryHandle): Promise<void> {
    this.stopIO();
    this.directory = directory;
    if (!globalThis.crossOriginIsolated) return;

    const buffer = new SharedArrayBuffer(16 + DATA_CAPACITY);
    const io = new Worker(new URL("./mayo-io.worker.ts", import.meta.url), { type: "module" });
    await new Promise<void>((resolve, reject) => {
      io.addEventListener("message", (event: MessageEvent<MayoIOReady>) => {
        if (event.data.type === "ready") resolve();
      }, { once: true });
      io.addEventListener("error", () => reject(new Error("Mayo I/O worker failed to start.")), { once: true });
      io.postMessage({ type: "setup", buffer, directory } satisfies MayoIOSetup);
    }).catch((error: unknown) => {
      io.terminate();
      throw error;
    });

    this.io = io;
    this.control = new Int32Array(buffer, 0, 4);
    this.data = new Uint8Array(buffer, 16);
  }

  /** True when synchronous file calls can be made (a folder is mounted and the I/O worker runs). */
  get ready(): boolean {
    return this.io !== undefined;
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

  private sendJSON<T>(request: MayoIORequest): T {
    return JSON.parse(new TextDecoder().decode(this.send(request))) as T;
  }

  /**
   * Post a request and block this worker until the I/O worker replies.
   * `payload` (at most DATA_CAPACITY bytes) is placed in the shared data area for the I/O worker.
   */
  private send(request: MayoIORequest, payload?: Uint8Array): Uint8Array {
    this.requireRoot();
    if (!this.io || !this.control || !this.data) {
      throw new Error(globalThis.crossOriginIsolated
        ? "Mayo I/O worker is not running; initialize Mayo again."
        : "Mayo file access requires cross-origin isolation (COOP/COEP headers).");
    }
    const control = this.control;
    if (payload) this.data.set(payload);
    // Mark pending before posting so the reply's notify cannot be missed.
    Atomics.store(control, CONTROL_STATE, STATE_PENDING);
    this.io.postMessage(request);
    if (Atomics.wait(control, CONTROL_STATE, STATE_PENDING, REQUEST_TIMEOUT_MS) === "timed-out") {
      this.stopIO();
      throw new Error("Mayo I/O worker did not respond.");
    }

    const bytes = this.data.slice(0, Atomics.load(control, CONTROL_LENGTH));
    const status = Atomics.load(control, CONTROL_STATUS);
    Atomics.store(control, CONTROL_STATE, STATE_IDLE);
    if (status !== STATUS_OK) throw ioError(new TextDecoder().decode(bytes));
    return bytes;
  }

  private stopIO(): void {
    this.io?.terminate();
    this.io = undefined;
    this.control = undefined;
    this.data = undefined;
  }

  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.directory) {
      throw new Error("Mayo must be initialized with a directory first.");
    }
    return this.directory;
  }
}

/** Turn the I/O worker's "Name: message" text back into an error with that name. */
function ioError(text: string): Error {
  const match = /^(\w+): ([\s\S]*)$/.exec(text);
  const error = new Error(match ? match[2] : text);
  if (match) error.name = match[1];
  return error;
}
