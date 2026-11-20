/** A file's name in the tree; its contents are not loaded. */
export type MayoFile = {
  readonly name: string;
  readonly kind: "file";
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
  /** The module is downloaded and initialized. */
  loaded: boolean;
  /** This module owns the shared filesystem that other tools mount. */
  base: boolean;
};

export type MayoExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Send a stream to a file instead of the result, like `> file` (append: `>> file`). */
export type MayoRedirect = { path: string; append: boolean };
export type MayoRedirects = { stdout?: MayoRedirect; stderr?: MayoRedirect };

export type MayoOperation =
  | { type: "init"; directory: FileSystemDirectoryHandle }
  | { type: "getTree" }
  | { type: "refreshTree" }
  | { type: "readFile"; path: string }
  | { type: "writeFile"; path: string; data: Uint8Array }
  | { type: "removeFile"; path: string }
  | { type: "loadTools"; tools: MayoToolConfig[] }
  | { type: "exec"; program: string; args: string[]; redirects?: MayoRedirects };

export type MayoRequest = MayoOperation & { id: number };

export type MayoResult =
  | { type: "tree"; tree: MayoDirectory }
  | { type: "bytes"; data: Uint8Array }
  | { type: "tools"; tools: MayoToolInfo[] }
  | { type: "exec"; result: MayoExecResult }
  | { type: "done" };

export type MayoResponse =
  | { id: number; ok: true; result: MayoResult }
  | { id: number; ok: false; error: { name: string; message: string } };
