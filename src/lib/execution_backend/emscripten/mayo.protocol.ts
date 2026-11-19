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

export type MayoOperation =
  | { type: "init"; directory: FileSystemDirectoryHandle }
  | { type: "getTree" }
  | { type: "refreshTree" }
  | { type: "readFile"; path: string }
  | { type: "writeFile"; path: string; data: Uint8Array }
  | { type: "removeFile"; path: string };

export type MayoRequest = MayoOperation & { id: number };

export type MayoResult =
  | { type: "tree"; tree: MayoDirectory }
  | { type: "bytes"; data: Uint8Array }
  | { type: "done" };

export type MayoResponse =
  | { id: number; ok: true; result: MayoResult }
  | { id: number; ok: false; error: { name: string; message: string } };
