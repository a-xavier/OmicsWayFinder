/**
 * The coordinator's side of the I/O worker (io/worker.ts): starts it, sets the selected folder,
 * and creates one connection per client (each tool worker, and the coordinator's own IOClient).
 *
 * A nested worker cannot start while its parent is blocked in Atomics.wait, so the I/O worker is
 * started and awaited here, before any client blocks.
 */

import { CONNECTION_BYTES, ISOLATION_MESSAGE, type IOConnection, type IOControl, type IOEvent } from "./protocol";

/** Must run in the coordinator, which never blocks for long. */
export class IOHost {
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
      const listener = (event: MessageEvent<IOEvent>) => {
        if (event.data.type !== "rooted") return;
        worker.removeEventListener("message", listener);
        resolve();
      };
      worker.addEventListener("message", listener);
      worker.postMessage({ type: "root", directory } satisfies IOControl);
    });
  }

  /** A new client; send the connection to the worker that will use it (it is transferable). */
  async connect(): Promise<{ client: number; connection: IOConnection }> {
    const worker = await this.ensure();
    const client = this.nextClient++;
    const channel = new MessageChannel();
    const buffer = new SharedArrayBuffer(CONNECTION_BYTES);
    worker.postMessage({ type: "connect", client, port: channel.port1, buffer } satisfies IOControl, [channel.port1]);
    return { client, connection: { port: channel.port2, buffer } };
  }

  /** Forget a client whose worker was stopped; its unfinished writes are discarded. */
  disconnect(client: number): void {
    this.worker?.postMessage({ type: "disconnect", client } satisfies IOControl);
  }

  private ensure(): Promise<Worker> {
    if (!globalThis.crossOriginIsolated) {
      return Promise.reject(new Error(ISOLATION_MESSAGE));
    }
    this.starting ??= new Promise<Worker>((resolve, reject) => {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (event: MessageEvent<IOEvent>) => {
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
