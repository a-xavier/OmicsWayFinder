import type {
  MayoDirectory,
  MayoExecResult,
  MayoOperation,
  MayoRedirects,
  MayoResponse,
  MayoResult,
  MayoToolConfig,
  MayoToolInfo,
  MayoToolSpec,
} from "./mayo.protocol";

export type { MayoDirectory, MayoEntry, MayoExecResult, MayoFile, MayoRedirects, MayoToolInfo, MayoToolSpec } from "./mayo.protocol";

/** Default location of tool files, as in Aioli: `<cdn>/<tool>/<version>/<program>.js`. */
export const MAYO_CDN = "https://biowasm.com/cdn/v3";

// Shell operators that are not implemented; rejected rather than passed to the tool as arguments.
const UNSUPPORTED_OPERATORS = new Set(["|", "||", "&&", "&", ";", "<"]);

/**
 * Split a command string on whitespace (no quoting or globs) and take out redirections:
 * `> file`, `>> file`, `2> file`, `2>> file` (also written without the space, as `>file`).
 */
export function parseCommand(command: string): { program: string; args: string[]; redirects: MayoRedirects } {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const args: string[] = [];
  const redirects: MayoRedirects = {};
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (UNSUPPORTED_OPERATORS.has(word)) throw new Error(`The shell operator "${word}" is not supported yet.`);
    const match = /^([12]?)(>>?)(.*)$/.exec(word);
    if (!match) {
      args.push(word);
      continue;
    }
    const [, fd, operator, attached] = match;
    if (attached.startsWith("&")) throw new Error(`"${word}" is not supported yet.`);
    const path = attached || words[++i];
    if (!path || /^[<>|&;]/.test(path)) throw new Error(`Expecting a file name after "${fd}${operator}".`);
    redirects[fd === "2" ? "stderr" : "stdout"] = { path, append: operator === ">>" };
  }
  const [program = "", ...rest] = args;
  return { program, args: rest, redirects };
}

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

  /** Read a whole file from the selected root. */
  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.request({ type: "readFile", path });
    if (result.type !== "bytes") throw new Error("Unexpected Mayo worker response.");
    return result.data;
  }

  /**
   * Create or replace a whole file in the selected root. Parent folders must exist.
   * The previous contents stay intact if the write fails. Call refreshTree() to see the change.
   */
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const result = await this.request({ type: "writeFile", path, data });
    if (result.type !== "done") throw new Error("Unexpected Mayo worker response.");
  }

  /** Remove one file from the selected root. Directories are refused. Call refreshTree() to see the change. */
  async removeFile(path: string): Promise<void> {
    const result = await this.request({ type: "removeFile", path });
    if (result.type !== "done") throw new Error("Unexpected Mayo worker response.");
  }

  /**
   * Download and initialize tools, using Aioli's syntax:
   * `loadTools(["samtools/1.10"])` or
   * `loadTools([{ tool: "samtools", version: "1.21", urlPrefix: "tools/samtools/1.21" }])`.
   * Can be called again to add tools. Returns every loaded tool.
   */
  async loadTools(tools: MayoToolSpec[]): Promise<MayoToolInfo[]> {
    const result = await this.request({ type: "loadTools", tools: tools.map(resolveTool) });
    if (result.type !== "tools") throw new Error("Unexpected Mayo worker response.");
    return result.tools;
  }

  /**
   * Run a loaded program, like Aioli: `exec("samtools view -h file.bam")` splits on whitespace
   * (no quoting, pipes or globs) and supports `>`, `>>`, `2>` and `2>>` (see parseCommand);
   * `exec("samtools", ["view", "-h", "my file.bam"], { stdout: { path: "out.sam", append: false } })`
   * passes arguments and redirections exactly. Resolves with stdout, stderr and the exit code;
   * a redirected stream goes to its file and comes back empty. A non-zero exit code does not reject.
   */
  async exec(command: string, args?: string[], redirects?: MayoRedirects): Promise<MayoExecResult> {
    let program = command.trim();
    if (!args) {
      ({ program, args, redirects } = parseCommand(command));
    }
    if (!program) throw new Error("Expecting a command.");
    const result = await this.request({ type: "exec", program, args, redirects });
    if (result.type !== "exec") throw new Error("Unexpected Mayo worker response.");
    return result.result;
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

/**
 * Apply Aioli's defaults to a tool spec. Runs on the main thread so relative urlPrefix values
 * resolve against the page (including the GitHub Pages base path), not the worker script.
 */
function resolveTool(spec: MayoToolSpec): MayoToolConfig {
  let config: Exclude<MayoToolSpec, string>;
  if (typeof spec === "string") {
    const parts = spec.split("/");
    if (parts.length !== 2 && parts.length !== 3) {
      throw new Error(`Expecting "<tool>/<version>" or "<tool>/<program>/<version>", got "${spec}".`);
    }
    config = { tool: parts[0], program: parts.length === 3 ? parts[1] : undefined, version: parts[parts.length - 1] };
  } else {
    config = spec;
  }
  if (!config.tool || !config.version) throw new Error("Each tool needs a tool name and a version.");

  const prefix = config.urlPrefix ?? `${MAYO_CDN}/${config.tool}/${config.version}`;
  return {
    tool: config.tool,
    version: config.version,
    program: config.program ?? config.tool,
    urlPrefix: new URL(prefix, document.baseURI).href.replace(/\/+$/, ""),
    loading: config.loading ?? "eager",
    reinit: config.reinit ?? false,
  };
}
