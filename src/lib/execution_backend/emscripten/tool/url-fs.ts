/**
 * URLFS: a read-only Emscripten filesystem for files on web servers, read lazily with HTTP range
 * requests. A tool reading /shared/urls/0/reads.bam gets only the bytes it asks for; nothing is
 * downloaded first, and memory use is limited to the I/O worker's chunk cache however big the file.
 *
 * Each mount is one remote directory (the URL without the file name). Looking up another name in
 * it (reads.bam.bai, ref.fa.fai…) asks the server for that file, so index files next to the data
 * are found the way tools expect. HTTP cannot list a directory: readdir only shows names already found.
 *
 * The tool worker mounts one URLFS per remote directory for the URLs in a command's arguments
 * (see tool/mounts.ts); the coordinator has already checked them (coordinator/remote.ts).
 */

import { REMOTE_CHUNK_SIZE } from "../io/protocol";
import type { RemoteFile } from "../shared/urls";
import {
  createFSNode,
  errnoError,
  nodeAttributes,
  O_ACCMODE,
  O_RDONLY,
  seekPosition,
  type EmscriptenFSInternals,
  type ErrnoName,
  type FSNode,
} from "./emscripten";
import type { RemoteFiles, RemoteReadState } from "./remote-files";

const DIR_MODE = 0o40555;
const FILE_MODE = 0o100444;

type UrlNode = FSNode & { parent: UrlNode; mount: { opts: URLFSMountOptions }; remote?: RemoteFile };
type UrlStream = { node: UrlNode; flags: number; position: number; urlfs?: RemoteReadState };

export type URLFSMountOptions = {
  /** Directory URL, ending with "/". */
  base: string;
  /** Names whose URL is not simply base + name (for example signed URLs with a query string). */
  files: Map<string, string>;
};

export type URLFS = { type: { mount(mount: { opts: URLFSMountOptions }): UrlNode } };

export function createURLFS(FS: EmscriptenFSInternals, remote: RemoteFiles): URLFS {
  // Names found by lookup in each mount root.
  const found = new WeakMap<UrlNode, Set<string>>();

  const errno = (name: ErrnoName) => errnoError(FS, name);

  function createNode(parent: UrlNode | null, name: string, file?: RemoteFile): UrlNode {
    const ops = { node_ops: nodeOps, stream_ops: streamOps };
    const node = createFSNode(FS, parent, name, file ? FILE_MODE : DIR_MODE, ops, file?.size ?? 0, file?.mtime ?? 0);
    node.remote = file;
    return node;
  }

  function urlOf(parent: UrlNode, name: string): string {
    const { base, files } = parent.mount.opts;
    return files.get(name) ?? `${base}${encodeURIComponent(name)}`;
  }

  const nodeOps = {
    getattr(node: UrlNode) {
      // Block size: what the I/O worker fetches and caches at once.
      return nodeAttributes(node, 2, REMOTE_CHUNK_SIZE);
    },
    setattr(node: UrlNode, attr: { mode?: number; timestamp?: number; size?: number }) {
      if (attr.size !== undefined && attr.size !== node.size) throw errno("EROFS");
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
    },
    lookup(parent: UrlNode, name: string): UrlNode {
      // Remote directories are flat: only the mount root has children.
      if (parent.remote || parent.parent !== parent) throw errno("ENOENT");
      const file = remote.stat(urlOf(parent, name));
      if (!file) throw errno("ENOENT");
      let names = found.get(parent);
      if (!names) found.set(parent, names = new Set());
      names.add(name);
      return createNode(parent, name, file);
    },
    readdir(node: UrlNode): string[] {
      // HTTP cannot list a directory; show the files named in commands and found so far.
      const names = new Set([...node.mount.opts.files.keys(), ...(found.get(node) ?? [])]);
      return [".", "..", ...names];
    },
    mknod(): never {
      throw errno("EROFS");
    },
    rename(): never {
      throw errno("EROFS");
    },
    unlink(): never {
      throw errno("EROFS");
    },
    rmdir(): never {
      throw errno("EROFS");
    },
    symlink(): never {
      throw errno("EROFS");
    },
    readlink(): never {
      throw errno("EINVAL");
    },
  };

  const streamOps = {
    open(stream: UrlStream) {
      if ((stream.flags & O_ACCMODE) !== O_RDONLY) throw errno("EROFS");
      if (stream.node.remote) stream.urlfs = remote.open(stream.node.remote);
    },
    close() {},
    read(stream: UrlStream, buffer: Int8Array, offset: number, length: number, position: number): number {
      if (!stream.node.remote) throw errno("EISDIR");
      if (!stream.urlfs) throw errno("EBADF");
      return remote.read(stream.urlfs, buffer, offset, length, position, () => errno("EIO"));
    },
    write(): never {
      throw errno("EROFS");
    },
    llseek(stream: UrlStream, offset: number, whence: number): number {
      return seekPosition(FS, stream, offset, whence);
    },
  };

  return {
    type: {
      mount(mount: { opts: URLFSMountOptions }): UrlNode {
        const root = createNode(null, "/");
        root.mount = mount;
        return root;
      },
    },
  };
}
