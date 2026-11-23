import type { Stage } from "../shared/command";
import type { RemoteStats } from "./shared/urls";

/** A file's name in the tree; its contents are not loaded. */
export type MayoFile = {
  readonly name: string;
  readonly kind: "file";
  /** Set for a URL link (see Mayo.addUrl): the remote file tools read in its place. */
  readonly url?: string;
};

/** A folder and its immediate children, which may themselves be folders. */
export type MayoDirectory = {
  readonly name: string;
  readonly kind: "directory";
  readonly children: readonly MayoEntry[];
};

/** The kind field distinguishes files from directories when traversing the tree. */
export type MayoEntry = MayoFile | MayoDirectory;

/**
 * A tool to load, in Aioli's format. `"samtools/1.10"` and `"seq-align/smith_waterman/2017.10"`
 * are shorthands for `{ tool, version }` and `{ tool, program, version }`.
 */
export type MayoToolSpec =
  | string
  | {
      tool: string;
      version: string;
      /** Executable name when a tool ships several programs; defaults to `tool`. */
      program?: string;
      /** Folder holding `<program>.js/.wasm/.data`; defaults to the biowasm CDN. Relative URLs resolve against the page. */
      urlPrefix?: string;
      /** "lazy" downloads and initializes the module on its first exec. */
      loading?: "eager" | "lazy";
      /** Re-create the module after every exec, for tools that do not reset global state. */
      reinit?: boolean;
    };

/** A tool spec with every default applied and an absolute urlPrefix; sent to the worker. */
export type MayoToolConfig = {
  tool: string;
  version: string;
  program: string;
  urlPrefix: string;
  loading: "eager" | "lazy";
  reinit: boolean;
};

export type MayoToolInfo = MayoToolConfig & {
  /** The module is downloaded and compiled, and a worker is ready to run it. */
  loaded: boolean;
};

export type MayoExecResult = {
  /** The last stage's stdout (empty if it was redirected to a file); with `&&`, each pipeline's in turn. */
  stdout: string;
  /** Every stage's stderr, in stage order. */
  stderr: string;
  /**
   * For a pipeline: 0 if every stage succeeded, otherwise the first non-zero exit code (like a
   * shell's `set -o pipefail`). A stage stopped because the next one exited early (`| head`) does
   * not count. With `&&`, the exit code of the last pipeline that ran.
   */
  exitCode: number;
  /** Set when a program read files from URLs: HTTP range requests made and bytes received. */
  remote?: RemoteStats;
  /** One entry per program that ran, in order (one for a single command). */
  stages: MayoStageResult[];
  /** Set when the run was stopped with Mayo.cancel(). */
  cancelled?: boolean;
};

export type MayoStageResult = {
  program: string;
  /** Which pipeline of an `a && b` command the stage belongs to (0 for the first). */
  pipeline: number;
  exitCode: number;
  stderr: string;
  remote?: RemoteStats;
  /** Stopped by writing to a pipe whose reader had exited (exit code 141, like SIGPIPE). */
  brokenPipe?: boolean;
};

export type MayoOperation =
  | { type: "init"; directory: FileSystemDirectoryHandle }
  | { type: "getTree" }
  | { type: "refreshTree" }
  | { type: "readFile"; path: string }
  | { type: "writeFile"; path: string; data: Uint8Array }
  | { type: "removeFile"; path: string }
  | { type: "loadTools"; tools: MayoToolConfig[] }
  // Pipelines joined by `&&`.
  | { type: "exec"; pipelines: Stage[][]; liveStderr: boolean }
  // Handled at once, not after the running exec: stops it. Replies "done".
  | { type: "cancel" }
  | { type: "download"; url: string; path: string }
  | { type: "addUrl"; url: string; path: string };

export type MayoRequest = MayoOperation & { id: number };

export type MayoResult =
  | { type: "tree"; tree: MayoDirectory }
  | { type: "bytes"; data: Uint8Array }
  | { type: "tools"; tools: MayoToolInfo[] }
  | { type: "exec"; result: MayoExecResult }
  | { type: "downloaded"; bytes: number }
  | { type: "added"; size: number }
  | { type: "done" };

export type MayoResponse =
  | { id: number; ok: true; result: MayoResult }
  | { id: number; ok: false; error: { name: string; message: string } };

/** Sent while an exec runs (when liveStderr is set): text a stage printed to stderr. */
export type MayoProgress = { id: number; progress: "stderr"; stage: number; text: string };

export type MayoMessage = MayoResponse | MayoProgress;
