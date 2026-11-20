/**
 * MAYOFS: an Emscripten filesystem backed by the user-selected folder through MayoFS.
 *
 * Mounted in the base tool at /shared/data (the working directory); other tools reach it
 * through PROXYFS. Supports lookup, stat, readdir, open, read, write, seek, truncate,
 * create, unlink, mkdir, rmdir and rename.
 *
 * Writes go to a temporary copy that replaces the file when it is closed (File System Access
 * has no in-place writes for user folders). So a file's new contents are visible only after
 * close, and reading a file through a stream that also writes it returns the old contents.
 *
 * Modelled on Emscripten's WORKERFS. Each Emscripten module has its own FS object,
 * so the filesystem is created for one module's FS.
 */

import type { MayoFS } from "./mayo-fs";
import { DATA_CAPACITY, type MayoIOKind } from "./mayo-io.protocol";

// Emscripten's errno numbers (the same in every module built with a recent Emscripten).
const ERRNO = {
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
} as const;
type ErrnoName = keyof typeof ERRNO;

const DIR_MODE = 0o40755;
const FILE_MODE = 0o100644;
// Emscripten open() flags: the low two bits are the access mode.
const O_ACCMODE = 3;
const O_RDONLY = 0;
const O_WRONLY = 1;
// Chrome's temporary files for writes in progress; hidden from directory listings.
const SWAP_SUFFIX = ".crswap";

/** The Emscripten FS internals MAYOFS uses. */
export type EmscriptenFSInternals = {
  createNode(parent: FSNode | null, name: string, mode: number, dev: number): FSNode;
  lookupNode(parent: FSNode, name: string): FSNode;
  destroyNode(node: FSNode): void;
  close(stream: unknown): void;
  ErrnoError: new (errno: number) => Error;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
};

type FSNode = {
  id: number;
  name: string;
  mode: number;
  parent: FSNode;
  node_ops: unknown;
  stream_ops: unknown;
  size: number;
  timestamp: number;
};

/** Browser handles and buffers for one open file. Duplicated streams share it. */
type OpenFile = {
  readId?: number;
  // Size of the file as it was when the read handle was opened.
  readSize: number;
  cache?: Uint8Array;
  cacheStart: number;
  writeId?: number;
  // Consecutive small writes are collected here and sent as one request.
  pending?: Uint8Array;
  pendingStart: number;
  pendingLength: number;
};
type FSStream = { node: FSNode; flags: number; position: number; mayo?: OpenFile };

export type MAYOFS = {
  /** Pass to FS.mount. */
  type: { mount(mount: unknown): FSNode };
  /**
   * Close files a program left open, which saves them. A process's files are closed when it
   * exits; Emscripten modules stay alive, so Mayo does it after each run.
   * Returns one message per file that could not be saved.
   */
  closeOpenFiles(): string[];
};

export function createMAYOFS(FS: EmscriptenFSInternals, fs: MayoFS): MAYOFS {
  const openStreams = new Set<FSStream>();

  /** An FS.ErrnoError with a `code` name, which PROXYFS needs to pass the error to other tools. */
  function errno(name: ErrnoName): Error {
    return Object.assign(new FS.ErrnoError(ERRNO[name]), { code: name });
  }

  /** Run a MayoFS call, turning browser errors into errno errors so the tool sees a normal failure. */
  function call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof FS.ErrnoError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "NotFoundError") throw errno("ENOENT");
      if (name === "TypeMismatchError") throw errno("ENOTDIR");
      if (name === "InvalidModificationError") throw errno("ENOTEMPTY");
      if (name === "NoModificationAllowedError") throw errno("EBUSY");
      if (name === "QuotaExceededError") throw errno("ENOSPC");
      if (name === "NotSupportedError") throw errno("EPERM");
      if (name === "NotAllowedError" || name === "SecurityError") throw errno("EACCES");
      if (error instanceof Error && error.message.startsWith("Invalid path")) throw errno("EINVAL");
      throw errno("EIO");
    }
  }

  /** Path relative to the selected folder: walk up to the mount root, whose parent is itself. */
  function relativePath(node: FSNode): string {
    const parts: string[] = [];
    for (let current = node; current.parent !== current; current = current.parent) parts.push(current.name);
    return parts.reverse().join("/");
  }

  function join(parent: FSNode, name: string): string {
    const base = relativePath(parent);
    return base ? `${base}/${name}` : name;
  }

  function createNode(parent: FSNode | null, name: string, kind: MayoIOKind, size: number, mtime: number): FSNode {
    const node = FS.createNode(parent, name, kind === "directory" ? DIR_MODE : FILE_MODE, 0);
    node.node_ops = nodeOps;
    node.stream_ops = streamOps;
    node.size = kind === "directory" ? 4096 : size;
    node.timestamp = mtime || Date.now();
    return node;
  }

  function writersOf(node: FSNode): OpenFile[] {
    return [...openStreams].filter(stream => stream.node === node && stream.mayo?.writeId !== undefined).map(stream => stream.mayo!);
  }

  function ensureReader(file: OpenFile, node: FSNode): number {
    if (file.readId === undefined) {
      const opened = call(() => fs.openRead(relativePath(node)));
      file.readId = opened.id;
      file.readSize = opened.size;
      file.cache = undefined;
    }
    return file.readId;
  }

  function ensureWriter(file: OpenFile, node: FSNode): number {
    file.writeId ??= call(() => fs.openWrite(relativePath(node), true));
    return file.writeId;
  }

  function flush(file: OpenFile): void {
    if (file.pendingLength === 0 || file.writeId === undefined) return;
    const id = file.writeId;
    const bytes = file.pending!.subarray(0, file.pendingLength);
    file.pendingLength = 0;
    call(() => fs.writeAt(id, file.pendingStart, bytes));
  }

  /** Save and close the write handle, then close the read handle. */
  function release(file: OpenFile): void {
    const { readId, writeId } = file;
    try {
      if (writeId !== undefined) {
        try {
          flush(file);
        } catch (error) {
          // Discard the temporary copy so it is not left in the folder.
          try {
            fs.abort(writeId);
          } catch {
            // Already closed, or the I/O worker stopped.
          }
          throw error;
        } finally {
          file.writeId = undefined;
          file.pendingLength = 0;
        }
        call(() => fs.close(writeId));
      }
    } finally {
      file.readId = undefined;
      file.cache = undefined;
      if (readId !== undefined) call(() => fs.close(readId));
    }
  }

  const nodeOps = {
    getattr(node: FSNode) {
      const time = new Date(node.timestamp);
      return {
        dev: 1,
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
        blksize: 4096,
        blocks: Math.ceil(node.size / 4096),
      };
    },
    setattr(node: FSNode, attr: { mode?: number; timestamp?: number; size?: number }) {
      if (attr.size !== undefined) {
        const size = attr.size;
        const writers = writersOf(node);
        if (writers.length > 0) {
          for (const file of writers) {
            flush(file);
            call(() => fs.truncateHandle(file.writeId!, size));
          }
        } else if (size !== node.size) {
          // Also reached by open(O_TRUNC); a newly created file is already empty.
          call(() => fs.truncate(relativePath(node), size));
        }
        node.size = size;
      }
      // Mode and time changes are kept in memory only.
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
    },
    lookup(parent: FSNode, name: string): FSNode {
      const stat = call(() => fs.stat(join(parent, name)));
      return createNode(parent, name, stat.kind, stat.size, stat.mtime);
    },
    readdir(node: FSNode): string[] {
      const names = call(() => fs.list(relativePath(node))).map(entry => entry.name);
      return [".", "..", ...names.filter(name => !name.endsWith(SWAP_SUFFIX))];
    },
    mknod(parent: FSNode, name: string, mode: number): FSNode {
      const kind: MayoIOKind | undefined = FS.isDir(mode) ? "directory" : FS.isFile(mode) ? "file" : undefined;
      if (!kind) throw errno("EPERM");
      call(() => fs.create(join(parent, name), kind));
      return createNode(parent, name, kind, 0, Date.now());
    },
    rename(node: FSNode, newParent: FSNode, newName: string) {
      call(() => fs.rename(relativePath(node), join(newParent, newName)));
      // Forget the cached node the file replaced, then move the node (Emscripten rehashes it).
      try {
        const replaced = FS.lookupNode(newParent, newName);
        if (replaced !== node) FS.destroyNode(replaced);
      } catch {
        // Nothing was at the target.
      }
      node.parent = newParent;
      node.name = newName;
    },
    unlink(parent: FSNode, name: string) {
      call(() => fs.removeFile(join(parent, name)));
    },
    rmdir(parent: FSNode, name: string) {
      call(() => fs.removeDirectory(join(parent, name)));
    },
    symlink(): never {
      throw errno("EPERM");
    },
    readlink(): never {
      throw errno("EINVAL");
    },
  };

  const streamOps = {
    open(stream: FSStream) {
      if (FS.isDir(stream.node.mode)) return;
      const access = stream.flags & O_ACCMODE;
      const file: OpenFile = { readSize: 0, cacheStart: 0, pendingStart: 0, pendingLength: 0 };
      if (access !== O_WRONLY) {
        ensureReader(file, stream.node);
        // Another stream may have written more than is on disk yet.
        if (writersOf(stream.node).length === 0) stream.node.size = file.readSize;
      }
      if (access !== O_RDONLY) {
        try {
          ensureWriter(file, stream.node);
        } catch (error) {
          release(file);
          throw error;
        }
      }
      stream.mayo = file;
      openStreams.add(stream);
    },
    close(stream: FSStream) {
      const file = stream.mayo;
      if (!file) return;
      openStreams.delete(stream);
      release(file);
      stream.node.timestamp = Date.now();
    },
    /**
     * Programs read in small blocks, and each browser read is a round trip to the I/O worker.
     * So fetch up to DATA_CAPACITY bytes at once and serve the following reads from that block.
     */
    read(stream: FSStream, buffer: Int8Array, offset: number, length: number, position: number): number {
      const file = stream.mayo;
      if (!file) throw errno(FS.isDir(stream.node.mode) ? "EISDIR" : "EBADF");
      const id = ensureReader(file, stream.node);
      let done = 0;
      while (done < length) {
        const at = position + done;
        if (at >= file.readSize) break;
        let cache = file.cache;
        if (!cache || at < file.cacheStart || at >= file.cacheStart + cache.byteLength) {
          cache = call(() => fs.read(id, at, Math.min(DATA_CAPACITY, file.readSize - at)));
          if (cache.byteLength === 0) break;
          file.cache = cache;
          file.cacheStart = at;
        }
        const from = at - file.cacheStart;
        const count = Math.min(length - done, cache.byteLength - from);
        buffer.set(cache.subarray(from, from + count), offset + done);
        done += count;
      }
      return done;
    },
    /** Collect consecutive writes into one block of up to DATA_CAPACITY before sending them. */
    write(stream: FSStream, buffer: Int8Array, offset: number, length: number, position: number): number {
      const file = stream.mayo;
      if (!file) throw errno(FS.isDir(stream.node.mode) ? "EISDIR" : "EBADF");
      const id = ensureWriter(file, stream.node);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      const appends = file.pendingLength > 0 && position === file.pendingStart + file.pendingLength;
      if (appends && file.pendingLength + length <= DATA_CAPACITY) {
        file.pending!.set(bytes, file.pendingLength);
        file.pendingLength += length;
      } else {
        flush(file);
        if (length >= DATA_CAPACITY) {
          call(() => fs.writeAt(id, position, bytes));
        } else {
          // Copy: `buffer` is the module's memory, which the program will reuse.
          file.pending ??= new Uint8Array(DATA_CAPACITY);
          file.pending.set(bytes);
          file.pendingStart = position;
          file.pendingLength = length;
        }
      }
      stream.node.size = Math.max(stream.node.size, position + length);
      stream.node.timestamp = Date.now();
      return length;
    },
    llseek(stream: FSStream, offset: number, whence: number): number {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2 && FS.isFile(stream.node.mode)) position += stream.node.size;
      if (position < 0) throw errno("EINVAL");
      return position;
    },
  };

  return {
    type: {
      mount(): FSNode {
        const root = call(() => fs.stat(""));
        return createNode(null, "/", root.kind, 0, root.mtime);
      },
    },
    closeOpenFiles(): string[] {
      const errors: string[] = [];
      for (const stream of [...openStreams]) {
        try {
          FS.close(stream);
        } catch (error) {
          const code = (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
          errors.push(`${relativePath(stream.node)}: ${code}`);
        }
      }
      return errors;
    },
  };
}
