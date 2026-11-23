/**
 * The parts of an Emscripten module that Mayo uses, and helpers shared by Mayo's Emscripten
 * filesystems (FOLDERFS, URLFS) and devices. biowasm glue does not ship TypeScript types.
 */

/** Emscripten's errno numbers (the same in every module built with a recent Emscripten). */
export const ERRNO = {
  EACCES: 2,
  EBADF: 8,
  EBUSY: 10,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ENOENT: 44,
  ENOSPC: 51,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
  EPERM: 63,
  EROFS: 69,
} as const;
export type ErrnoName = keyof typeof ERRNO;

/** How a shell describes an errno, for redirection errors ("mayo: out.sam: No such file or directory"). */
export const ERRNO_MESSAGES: Record<number, string> = {
  [ERRNO.EACCES]: "Permission denied",
  [ERRNO.EISDIR]: "Is a directory",
  [ERRNO.ENOENT]: "No such file or directory",
  [ERRNO.ENOTDIR]: "Not a directory",
  [ERRNO.EPERM]: "Operation not permitted",
};

// open() flags: the low two bits are the access mode.
export const O_ACCMODE = 3;
export const O_RDONLY = 0;
export const O_WRONLY = 1;

/** A node of Emscripten's in-memory filesystem tree. Filesystems add their own fields. */
export type FSNode = {
  id: number;
  name: string;
  mode: number;
  /** The mount root's parent is itself. */
  parent: FSNode;
  node_ops: unknown;
  stream_ops: unknown;
  size: number;
  timestamp: number;
  mount: { opts: unknown };
};

/** The FS internals a custom filesystem needs. */
export type EmscriptenFSInternals = {
  createNode(parent: FSNode | null, name: string, mode: number, dev: number): FSNode;
  lookupNode(parent: FSNode, name: string): FSNode;
  destroyNode(node: FSNode): void;
  close(stream: unknown): void;
  ErrnoError: new (errno: number) => Error;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
};

/** The FS calls the tool worker makes. */
export type EmscriptenFS = EmscriptenFSInternals & {
  mkdir(path: string): void;
  chdir(path: string): void;
  symlink(target: string, path: string): void;
  unlink(path: string): void;
  mount(type: unknown, options: unknown, mountpoint: string): void;
  unmount(mountpoint: string): void;
  analyzePath(path: string): { exists: boolean };
  open(path: string, flags: string): { fd: number };
  makedev(major: number, minor: number): number;
  mkdev(path: string, mode: number, dev: number): void;
  registerDevice(dev: number, ops: Record<string, unknown>): void;
  /** Open streams by file descriptor. */
  streams: unknown[];
};

export type EmscriptenModule = {
  callMain(args: string[]): void;
  FS: EmscriptenFS;
  /** Flushes C stdio buffers; fflush(0) flushes all. Not exported by every build. */
  _fflush?: (stream: number) => number;
};

/** biowasm glue defines a MODULARIZE factory: `Module(overrides)` resolves to the module. */
export type EmscriptenFactory = (overrides: Record<string, unknown>) => Promise<EmscriptenModule>;

/** An FS.ErrnoError with a `code` name, so callers can tell errors apart (`error.code === "ENOENT"`). */
export function errnoError(FS: EmscriptenFSInternals, name: ErrnoName): Error {
  return Object.assign(new FS.ErrnoError(ERRNO[name]), { code: name });
}

/** stat() size reported for a directory, as on a typical disk. */
const DIRECTORY_SIZE = 4096;

/** A new node using a filesystem's operations. Directories get DIRECTORY_SIZE; no time means now. */
export function createFSNode<T extends FSNode>(
  FS: EmscriptenFSInternals,
  parent: T | null,
  name: string,
  mode: number,
  ops: { node_ops: unknown; stream_ops: unknown },
  size: number,
  timestamp: number,
): T {
  const node = FS.createNode(parent, name, mode, 0) as T;
  node.node_ops = ops.node_ops;
  node.stream_ops = ops.stream_ops;
  node.size = FS.isDir(mode) ? DIRECTORY_SIZE : size;
  node.timestamp = timestamp || Date.now();
  return node;
}

/** stat() fields for a node; `dev` tells filesystems apart. */
export function nodeAttributes(node: FSNode, dev: number, blksize: number) {
  const time = new Date(node.timestamp);
  return {
    dev,
    ino: node.id,
    mode: node.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: node.size,
    atime: time,
    mtime: time,
    ctime: time,
    blksize,
    blocks: Math.ceil(node.size / 512),
  };
}

/** The new position for lseek(); SEEK_END (2) only applies to files. */
export function seekPosition(FS: EmscriptenFSInternals, stream: { node: FSNode; position: number }, offset: number, whence: number): number {
  let position = offset;
  if (whence === 1) position += stream.position;
  else if (whence === 2 && FS.isFile(stream.node.mode)) position += stream.node.size;
  if (position < 0) throw errnoError(FS, "EINVAL");
  return position;
}
