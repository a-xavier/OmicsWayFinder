/**
 * Shared filesystem for Emscripten tools, backed by the user-selected directory.
 *
 * Emscripten calls filesystem callbacks synchronously, but File System Access handles are
 * asynchronous. MayoFS bridges the two: it sends each request to a separate I/O worker, then
 * blocks with Atomics.wait until that worker writes the reply into a SharedArrayBuffer.
 * This requires cross-origin isolation (COOP/COEP headers).
 *
 * Planned next step: expose these synchronous calls as a custom Emscripten filesystem
 * mounted with `FS.mount(MAYOFS, { directory }, "/shared")`.
 */

import {
  CONTROL_LENGTH,
  CONTROL_STATE,
  CONTROL_STATUS,
  DATA_CAPACITY,
  STATE_IDLE,
  STATE_PENDING,
  STATUS_OK,
  type MayoIOReady,
  type MayoIORequest,
  type MayoIOSetup,
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

  /** Read a whole file synchronously, in chunks, through the I/O worker. */
  readFile(path: string): Uint8Array {
    const stat = JSON.parse(new TextDecoder().decode(this.send({ type: "stat", path }))) as { size: number };
    const result = new Uint8Array(stat.size);
    for (let offset = 0; offset < stat.size; offset += DATA_CAPACITY) {
      const length = Math.min(DATA_CAPACITY, stat.size - offset);
      result.set(this.send({ type: "read", path, offset, length }), offset);
    }
    return result;
  }

  /** Placeholder for writing a file relative to the root. */
  writeFile(_path: string, _data: Uint8Array): void {
    this.requireRoot();
    throw new Error("Mayo file writing is not implemented.");
  }

  /** Placeholder for removing a file relative to the root. */
  removeFile(_path: string): void {
    this.requireRoot();
    throw new Error("Mayo file removal is not implemented.");
  }

  /** Post a request and block this worker until the I/O worker replies. */
  private send(request: MayoIORequest): Uint8Array {
    this.requireRoot();
    if (!this.io || !this.control || !this.data) {
      throw new Error(globalThis.crossOriginIsolated
        ? "Mayo I/O worker is not running; initialize Mayo again."
        : "Mayo file access requires cross-origin isolation (COOP/COEP headers).");
    }
    const control = this.control;
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
    if (status !== STATUS_OK) throw new Error(new TextDecoder().decode(bytes));
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
