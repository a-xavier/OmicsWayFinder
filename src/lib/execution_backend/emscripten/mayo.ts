import type {
  MayoDirectory,
  MayoExecResult,
  MayoMessage,
  MayoOperation,
  MayoRedirects,
  MayoResult,
  MayoStage,
  MayoToolConfig,
  MayoToolInfo,
  MayoToolSpec,
} from "./mayo.protocol";

export type {
  MayoDirectory,
  MayoEntry,
  MayoExecResult,
  MayoFile,
  MayoRedirects,
  MayoStage,
  MayoStageResult,
  MayoToolInfo,
  MayoToolSpec,
} from "./mayo.protocol";

/** Default location of tool files, as in Aioli: `<cdn>/<tool>/<version>/<program>.js`. */
export const MAYO_CDN = "https://biowasm.com/cdn/v3";

// Shell operators that are not implemented; rejected rather than passed to the tool as arguments.
const UNSUPPORTED_OPERATORS = new Set(["||", "&&", "&", ";"]);

export type MayoExecOptions = {
  /**
   * Called with each stage's stderr as it is printed (stage 0 is the first program; numbering
   * continues across `&&`, so in `a | b && c`, c is stage 2).
   */
  onStderr?: (text: string, stage: number) => void;
};

/**
 * Split a command string into pipelines joined by ` && ` (each runs only if the previous one
 * succeeded), each parsed by parsePipeline.
 */
export function parseCommand(command: string): MayoStage[][] {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("Expecting a command.");
  const groups: string[][] = [[]];
  for (const word of words) {
    if (word === "&&") groups.push([]);
    else if (word.includes("&&")) throw new Error(`Put spaces around "&&" (in "${word}").`);
    else groups[groups.length - 1].push(word);
  }
  return groups.map((group, index) => {
    if (group.length === 0) throw new Error(`Expecting a command ${index === 0 ? "before" : "after"} "&&".`);
    return parsePipeline(group.join(" "));
  });
}

/**
 * Split a command string into pipeline stages on ` | ` and each stage on whitespace (no quoting
 * or globs), taking out redirections: `< file` (first stage only), `> file` and `>> file` (last
 * stage only), `2> file` and `2>> file` (any stage); also written without the space, as `>file`.
 */
export function parsePipeline(command: string): MayoStage[] {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("Expecting a command.");
  const groups: string[][] = [[]];
  for (const word of words) {
    if (word === "|") groups.push([]);
    else if (word.includes("|")) throw new Error(`Put spaces around "|" (in "${word}"); "||" is not supported.`);
    else groups[groups.length - 1].push(word);
  }
  return groups.map((group, index) => {
    if (group.length === 0) throw new Error(`Expecting a command ${index === 0 ? "before" : "after"} "|".`);
    const stage = parseStage(group);
    const last = index === groups.length - 1;
    if (index > 0 && stage.redirects.stdin !== undefined) {
      throw new Error(`"<" can only be used in the first command of a pipeline (${stage.program} reads the pipe).`);
    }
    if (!last && stage.redirects.stdout) {
      throw new Error(`">" can only be used in the last command of a pipeline (${stage.program} writes to the pipe).`);
    }
    return stage;
  });
}

function parseStage(words: string[]): MayoStage {
  const args: string[] = [];
  const redirects: MayoRedirects = {};
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (UNSUPPORTED_OPERATORS.has(word)) throw new Error(`The shell operator "${word}" is not supported.`);
    const match = /^([12]?)(>>?)(.*)$/.exec(word) ?? /^()(<)(.*)$/.exec(word);
    if (!match) {
      args.push(word);
      continue;
    }
    const [, fd, operator, attached] = match;
    if (attached.startsWith("&") || attached.startsWith("<") || attached.startsWith(">")) {
      throw new Error(`"${word}" is not supported.`);
    }
    const path = attached || words[++i];
    if (!path || /^[<>&;]/.test(path)) throw new Error(`Expecting a file name after "${fd}${operator}".`);
    if (operator === "<") redirects.stdin = path;
    else redirects[fd === "2" ? "stderr" : "stdout"] = { path, append: operator === ">>" };
  }
  const [program = "", ...rest] = args;
  if (!program) throw new Error("Expecting a program name before the redirections.");
  return { program, args: rest, redirects };
}

type PendingRequest = {
  resolve: (result: MayoResult) => void;
  reject: (error: Error) => void;
  onStderr?: (text: string, stage: number) => void;
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
    this.worker.addEventListener("message", (event: MessageEvent<MayoMessage>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      if ("progress" in event.data) {
        request.onStderr?.(event.data.text, event.data.stage);
        return;
      }
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
   * Add a remote file to the selected folder as a URL link, without downloading it. Tools then use
   * it like any file (`samtools view -c reads.bam chr1`) and fetch only the bytes they read, with
   * range requests. Index files next to the URL (reads.bam.bai) are found too. The server must
   * allow CORS and range requests; this is checked first. `path` defaults to the URL's file name.
   * The link is a small text file ("mayo-url <url>"), so it can be renamed, moved or deleted like
   * any file, and it stays in the folder for the next visit. Returns the path and the remote size.
   */
  async addUrl(url: string, path?: string): Promise<{ path: string; size: number }> {
    const href = new URL(url, document.baseURI).href;
    const target = path || urlFileName(href);
    if (!target) throw new Error("The URL has no file name; give a path.");
    const result = await this.request({ type: "addUrl", url: href, path: target });
    if (result.type !== "added") throw new Error("Unexpected Mayo worker response.");
    return { path: target, size: result.size };
  }

  /**
   * Download a URL into the selected folder (parent folders must exist), streaming it in chunks
   * so memory use stays small. Exec can read URLs directly; downloading suits servers without
   * range support and files used many times. Resolves with the number of bytes written.
   */
  async download(url: string, path: string): Promise<number> {
    const result = await this.request({ type: "download", url: new URL(url, document.baseURI).href, path });
    if (result.type !== "downloaded") throw new Error("Unexpected Mayo worker response.");
    return result.bytes;
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
   * Run a loaded program or a pipeline, like a shell:
   * `exec("samtools view -h file.bam")` or `exec("minimap2 -a ref.fa reads.fq | samtools sort -o out.bam -")`.
   * The string is split on whitespace (no quoting or globs) and supports `|`, `&&`, `<`, `>`,
   * `>>`, `2>` and `2>>` (see parseCommand and parsePipeline). All the programs of a pipeline run
   * at the same time, each in its own worker, connected by pipes. With `a && b`, b runs only if a
   * exited with 0.
   * `exec("samtools", ["view", "-h", "my file.bam"], { stdout: { path: "out.sam", append: false } })`
   * runs one program with exact arguments and redirections.
   *
   * Resolves with the last program's stdout, every program's stderr, the exit code (the first
   * non-zero one, as with `set -o pipefail`; with `&&`, that of the last pipeline run) and
   * per-stage results; a redirected stream goes to
   * its file and comes back empty. A non-zero exit code does not reject. http(s) URLs in the
   * arguments are read in place with range requests (see mayo-url-fs.ts).
   */
  async exec(command: string, options?: MayoExecOptions): Promise<MayoExecResult>;
  async exec(program: string, args: string[], redirects?: MayoRedirects, options?: MayoExecOptions): Promise<MayoExecResult>;
  async exec(
    command: string,
    argsOrOptions?: string[] | MayoExecOptions,
    redirects?: MayoRedirects,
    options?: MayoExecOptions,
  ): Promise<MayoExecResult> {
    let pipelines: MayoStage[][];
    if (Array.isArray(argsOrOptions)) {
      const program = command.trim();
      if (!program) throw new Error("Expecting a command.");
      pipelines = [[{ program, args: argsOrOptions, redirects: redirects ?? {} }]];
    } else {
      pipelines = parseCommand(command);
      options = argsOrOptions;
    }
    const onStderr = options?.onStderr;
    const result = await this.request({ type: "exec", pipelines, liveStderr: onStderr !== undefined }, onStderr);
    if (result.type !== "exec") throw new Error("Unexpected Mayo worker response.");
    return result.result;
  }

  /**
   * Stop the running exec, if any: its programs are terminated, the pipelines after `&&` do not
   * start, and it resolves with exit code 130 and `cancelled: true`. Files being written by the stopped programs are left unchanged.
   */
  async cancel(): Promise<void> {
    await this.request({ type: "cancel" });
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

  private request(operation: MayoOperation, onStderr?: PendingRequest["onStderr"]): Promise<MayoResult> {
    if (this.closed) return Promise.reject(new Error("Mayo has been closed."));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStderr });
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

/** The decoded last segment of a URL's path ("" for a directory URL). */
export function urlFileName(url: string): string {
  const name = new URL(url).pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
