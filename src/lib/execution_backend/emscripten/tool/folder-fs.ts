/**
 * FOLDERFS: an Emscripten filesystem backed by the user-selected folder, through an IOClient.
 *
 * Mounted in every tool worker at /shared/data (the working directory), each with its own IOClient
 * connection. Supports lookup, stat, readdir, open, read, write, seek, truncate, create, unlink,
 * mkdir, rmdir and rename. Modelled on Emscripten's WORKERFS.
 *
 * Writes go to a temporary copy that replaces the file when it is closed (File System Access
 * has no in-place writes for user folders). So a file's new contents are visible only after
 * close, and reading a file through a stream that also writes it returns the old contents.
 *
 * URL links (shared/url-links.ts) are served as the remote file they name, read lazily with range
 * requests (RemoteFiles). Tools see its real size and contents. A missing name that extends a link
 * (reads.bam.bai next to the link reads.bam) is looked up next to the URL, so remote index files
 * are found. Opening a link for writing replaces it with an ordinary file, as overwriting any file would.
 */

import { WriteBuffer, type IOClient } from "../io/client";
import { DATA_CAPACITY, isSwapFile, type IOKind, type IOStat } from "../io/protocol";
import { mayBeLink, parseLinkBytes } from "../shared/url-links";
import type { RemoteFile } from "../shared/urls";
import {
  createFSNode,
  errnoError,
  nodeAttributes,
  O_ACCMODE,
  O_RDONLY,
  O_WRONLY,
  seekPosition,
  type EmscriptenFSInternals,
  type ErrnoName,
  type FSNode,
} from "./emscripten";
import type { RemoteFiles, RemoteReadState } from "./remote-files";

const DIR_MODE = 0o40755;
const FILE_MODE = 0o100644;

type FolderNode = FSNode & {
  parent: FolderNode;
  /** Set for a URL link, or for a remote file found next to one (`virtual`: not in the folder). */
  remote?: RemoteFile;
  virtual?: boolean;
};

/** Browser handles and buffers for one open file. Duplicated streams share it. */
type OpenFile = {
  readId?: number;
  // Size of the file as it was when the read handle was opened.
  readSize: number;
  cache?: Uint8Array;
  cacheStart: number;
  writeId?: number;
  // Set with writeId: collects consecutive small writes into one request.
  writes?: WriteBuffer;
};
type FolderStream = { node: FolderNode; flags: number; position: number; file?: OpenFile; remote?: RemoteReadState };

export type FOLDERFS = {
  /** Pass to FS.mount. */
  type: { mount(mount: unknown): FolderNode };
  /**
   * Close files a program left open, which saves them. A process's files are closed when it
   * exits; Emscripten modules stay alive, so Mayo does it after each run.
   * Returns one message per file that could not be saved.
   */
  closeOpenFiles(): string[];
};

export function createFOLDERFS(FS: EmscriptenFSInternals, io: IOClient, remote: RemoteFiles): FOLDERFS {
  const openStreams = new Set<FolderStream>();
  // Link targets by path, valid while the file's size and date are unchanged.
  const links = new Map<string, { size: number; mtime: number; url?: string }>();

  const errno = (name: ErrnoName) => errnoError(FS, name);

  /** Run an IOClient call, turning browser errors into errno errors so the tool sees a normal failure. */
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
  function relativePath(node: FolderNode): string {
    const parts: string[] = [];
    for (let current: FolderNode = node; current.parent !== current; current = current.parent) parts.push(current.name);
    return parts.reverse().join("/");
  }

  function join(parent: FolderNode, name: string): string {
    const base = relativePath(parent);
    return base ? `${base}/${name}` : name;
  }

  function createNode(parent: FolderNode | null, name: string, kind: IOKind, size: number, mtime: number): FolderNode {
    const mode = kind === "directory" ? DIR_MODE : FILE_MODE;
    return createFSNode(FS, parent, name, mode, { node_ops: nodeOps, stream_ops: streamOps }, size, mtime);
  }

  /** The URL if the file at `path` is a link. Reads only small files. */
  function linkTarget(path: string, stat: IOStat): string | undefined {
    if (stat.kind !== "file" || !mayBeLink(stat.size)) return undefined;
    const known = links.get(path);
    if (known && known.size === stat.size && known.mtime === stat.mtime) return known.url;
    let url: string | undefined;
    try {
      url = parseLinkBytes(io.readFile(path));
    } catch {
      // Unreadable: treat it as an ordinary file, which will report the error when opened.
    }
    links.set(path, { size: stat.size, mtime: stat.mtime, url });
    return url;
  }

  function createRemoteNode(parent: FolderNode, name: string, file: RemoteFile, virtual: boolean): FolderNode {
    const node = createNode(parent, name, "file", file.size, file.mtime);
    node.remote = file;
    node.virtual = virtual;
    return node;
  }

  /**
   * For a missing name such as reads.bam.bai: if reads.bam (or reads) is a link, the same suffix
   * on its URL, if the server has it.
   */
  function remoteSibling(parent: FolderNode, name: string): RemoteFile | undefined {
    for (let dot = name.lastIndexOf("."); dot > 0; dot = name.lastIndexOf(".", dot - 1)) {
      const path = join(parent, name.slice(0, dot));
      let url: string | undefined;
      try {
        url = linkTarget(path, io.stat(path));
      } catch {
        continue;
      }
      if (!url) continue;
      const sibling = new URL(url);
      sibling.pathname += name.slice(dot);
      return remote.stat(sibling.href);
    }
    return undefined;
  }

  /** Before writing to a link: make it an ordinary file in the folder. */
  function makeLocal(node: FolderNode): void {
    if (!node.remote) return;
    const path = relativePath(node);
    if (node.virtual) call(() => io.create(path, "file"));
    node.size = node.virtual ? 0 : call(() => io.stat(path)).size;
    node.timestamp = Date.now();
    node.remote = undefined;
    node.virtual = false;
  }

  function writersOf(node: FolderNode): OpenFile[] {
    return [...openStreams].filter(stream => stream.node === node && stream.file?.writeId !== undefined).map(stream => stream.file!);
  }

  function ensureReader(file: OpenFile, node: FolderNode): number {
    if (file.readId === undefined) {
      const opened = call(() => io.openRead(relativePath(node)));
      file.readId = opened.id;
      file.readSize = opened.size;
      file.cache = undefined;
    }
    return file.readId;
  }

  function ensureWriter(file: OpenFile, node: FolderNode): WriteBuffer {
    if (!file.writes) {
      const id = call(() => io.openWrite(relativePath(node), true));
      file.writeId = id;
      file.writes = new WriteBuffer((position, bytes) => call(() => io.writeAt(id, position, bytes)));
    }
    return file.writes;
  }

  /** Save and close the write handle, then close the read handle. */
  function release(file: OpenFile): void {
    const { readId, writeId } = file;
    try {
      if (writeId !== undefined) {
        try {
          file.writes?.flush();
        } catch (error) {
          // Discard the temporary copy so it is not left in the folder.
          io.abortQuietly(writeId);
          throw error;
        } finally {
          file.writeId = undefined;
          file.writes = undefined;
        }
        call(() => io.close(writeId));
      }
    } finally {
      file.readId = undefined;
      file.cache = undefined;
      if (readId !== undefined) call(() => io.close(readId));
    }
  }

  const nodeOps = {
    getattr(node: FolderNode) {
      return nodeAttributes(node, 1, 4096);
    },
    setattr(node: FolderNode, attr: { mode?: number; timestamp?: number; size?: number }) {
      if (attr.size !== undefined) {
        makeLocal(node);
        const size = attr.size;
        const writers = writersOf(node);
        if (writers.length > 0) {
          for (const file of writers) {
            file.writes!.flush();
            call(() => io.truncateHandle(file.writeId!, size));
          }
        } else if (size !== node.size) {
          // Also reached by open(O_TRUNC); a newly created file is already empty.
          call(() => io.truncate(relativePath(node), size));
        }
        node.size = size;
      }
      // Mode and time changes are kept in memory only.
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
    },
    lookup(parent: FolderNode, name: string): FolderNode {
      const path = join(parent, name);
      let stat: IOStat;
      try {
        stat = call(() => io.stat(path));
      } catch (error) {
        const sibling = (error as { code?: string }).code === "ENOENT" ? remoteSibling(parent, name) : undefined;
        if (sibling) return createRemoteNode(parent, name, sibling, true);
        throw error;
      }
      const url = linkTarget(path, stat);
      if (!url) return createNode(parent, name, stat.kind, stat.size, stat.mtime);
      const file = remote.stat(url);
      if (!file) {
        remote.report(`${path} links to ${url}, which cannot be read (missing, or the server does not allow cross-origin requests)`);
        throw errno("EIO");
      }
      return createRemoteNode(parent, name, file, false);
    },
    readdir(node: FolderNode): string[] {
      const names = call(() => io.list(relativePath(node))).map(entry => entry.name);
      return [".", "..", ...names.filter(name => !isSwapFile(name))];
    },
    mknod(parent: FolderNode, name: string, mode: number): FolderNode {
      const kind: IOKind | undefined = FS.isDir(mode) ? "directory" : FS.isFile(mode) ? "file" : undefined;
      if (!kind) throw errno("EPERM");
      call(() => io.create(join(parent, name), kind));
      return createNode(parent, name, kind, 0, Date.now());
    },
    rename(node: FolderNode, newParent: FolderNode, newName: string) {
      call(() => io.rename(relativePath(node), join(newParent, newName)));
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
    unlink(parent: FolderNode, name: string) {
      call(() => io.removeFile(join(parent, name)));
    },
    rmdir(parent: FolderNode, name: string) {
      call(() => io.removeDirectory(join(parent, name)));
    },
    symlink(): never {
      throw errno("EPERM");
    },
    readlink(): never {
      throw errno("EINVAL");
    },
  };

  const streamOps = {
    open(stream: FolderStream) {
      if (FS.isDir(stream.node.mode)) return;
      const access = stream.flags & O_ACCMODE;
      if (stream.node.remote) {
        if (access === O_RDONLY) {
          stream.remote = remote.open(stream.node.remote);
          return;
        }
        makeLocal(stream.node);
      }
      const file: OpenFile = { readSize: 0, cacheStart: 0 };
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
      stream.file = file;
      openStreams.add(stream);
    },
    close(stream: FolderStream) {
      const file = stream.file;
      if (!file) return;
      openStreams.delete(stream);
      release(file);
      stream.node.timestamp = Date.now();
    },
    /**
     * Programs read in small blocks, and each browser read is a round trip to the I/O worker.
     * So fetch up to DATA_CAPACITY bytes at once and serve the following reads from that block.
     */
    read(stream: FolderStream, buffer: Int8Array, offset: number, length: number, position: number): number {
      if (stream.remote) return remote.read(stream.remote, buffer, offset, length, position, () => errno("EIO"));
      const file = stream.file;
      if (!file) throw errno(FS.isDir(stream.node.mode) ? "EISDIR" : "EBADF");
      const id = ensureReader(file, stream.node);
      let done = 0;
      while (done < length) {
        const at = position + done;
        if (at >= file.readSize) break;
        let cache = file.cache;
        if (!cache || at < file.cacheStart || at >= file.cacheStart + cache.byteLength) {
          cache = call(() => io.read(id, at, Math.min(DATA_CAPACITY, file.readSize - at)));
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
    /** Consecutive writes are collected into one block of up to DATA_CAPACITY before being sent. */
    write(stream: FolderStream, buffer: Int8Array, offset: number, length: number, position: number): number {
      const file = stream.file;
      if (!file) throw errno(FS.isDir(stream.node.mode) ? "EISDIR" : "EBADF");
      // WriteBuffer copies small writes: `buffer` is the module's memory, which the program will reuse.
      ensureWriter(file, stream.node).write(position, new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length));
      stream.node.size = Math.max(stream.node.size, position + length);
      stream.node.timestamp = Date.now();
      return length;
    },
    llseek(stream: FolderStream, offset: number, whence: number): number {
      return seekPosition(FS, stream, offset, whence);
    },
  };

  return {
    type: {
      mount(): FolderNode {
        const root = call(() => io.stat(""));
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
