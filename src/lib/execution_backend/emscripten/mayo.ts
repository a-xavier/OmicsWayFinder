import type { MayoDirectory, MayoOperation, MayoResponse, MayoResult } from "./mayo.protocol";

export type { MayoDirectory, MayoEntry, MayoFile } from "./mayo.protocol";

type PendingRequest = {
  resolve: (result: MayoResult) => void;
  reject: (error: Error) => void;
};

/** Main-thread API; each instance owns one worker and runs its operations sequentially. */
export class Mayo {
  private readonly worker = new Worker(new URL("./mayo.worker.ts", import.meta.url), {
    type: "module",
  });
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private closed = false;

  constructor() {
    this.worker.addEventListener("message", (event: MessageEvent<MayoResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) {
        request.resolve(event.data.result);
      } else {
        const error = new Error(event.data.error.message);
        error.name = event.data.error.name;
        request.reject(error);
      }
    });
    this.worker.addEventListener("error", (event) => {
      this.stop(new Error(`Mayo worker failed: ${event.message}`));
    });
    this.worker.addEventListener("messageerror", () => {
      this.stop(new Error("Mayo could not deserialize a worker response."));
    });
  }

  /** Send a user-selected directory to the worker and return its first tree snapshot. */
  async init(directory: FileSystemDirectoryHandle): Promise<MayoDirectory> {
    return this.requestTree({ type: "init", directory });
  }

  /** Retrieve the worker's last successful snapshot without rescanning. */
  async getTree(): Promise<MayoDirectory> {
    return this.requestTree({ type: "getTree" });
  }

  /** Rescan the selected directory in the worker. */
  async refreshTree(): Promise<MayoDirectory> {
    return this.requestTree({ type: "refreshTree" });
  }

  /** Placeholder for reading a file from the selected root. */
  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.request({ type: "readFile", path });
    if (result.type !== "bytes") throw new Error("Unexpected Mayo worker response.");
    return result.data;
  }

  /** Placeholder for writing a file to the selected root. */
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const result = await this.request({ type: "writeFile", path, data });
    if (result.type !== "done") throw new Error("Unexpected Mayo worker response.");
  }

  /** Placeholder for removing a file from the selected root. */
  async removeFile(path: string): Promise<void> {
    const result = await this.request({ type: "removeFile", path });
    if (result.type !== "done") throw new Error("Unexpected Mayo worker response.");
  }

  /** Stop the worker and reject requests that have not completed. */
  close(): void {
    this.stop(new Error("Mayo has been closed."));
  }

  private async requestTree(operation: MayoOperation): Promise<MayoDirectory> {
    const result = await this.request(operation);
    if (result.type !== "tree") throw new Error("Unexpected Mayo worker response.");
    return result.tree;
  }

  private request(operation: MayoOperation): Promise<MayoResult> {
    if (this.closed) return Promise.reject(new Error("Mayo has been closed."));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...operation, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private stop(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
