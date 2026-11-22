/**
 * URLFS: a read-only Emscripten filesystem for files on web servers, read lazily with HTTP range
 * requests. A tool reading /shared/urls/0/reads.bam gets only the bytes it asks for; nothing is
 * downloaded first, and memory use is limited to a fixed chunk cache however big the file is.
 *
 * Each mount is one remote directory (the URL without the file name). Looking up another name in
 * it (reads.bam.bai, ref.fa.fai…) asks the server for that file, so index files next to the data
 * are found the way tools expect. HTTP cannot list a directory: readdir only shows names already found.
 *
 * The same reading code (RemoteFiles) serves URL links in the selected folder: small files
 * containing "mayo-url <url>", which MAYOFS reads as the remote file (see linkUrl).
 *
 * The HTTP requests and the chunk cache live in the I/O worker (mayo-remote-cache.ts), shared by
 * every tool worker; RemoteFiles is the synchronous tool-side client. Before a run, the coordinator
 * checks each URL from the command with RemoteChecker (async fetch), so a missing file, a CORS
 * refusal or a server without range support is reported before the tool starts.
 */

import type { EmscriptenFSInternals } from "./mayo-emscripten-fs";
import type { MayoFS } from "./mayo-fs";
import { DATA_CAPACITY } from "./mayo-io.protocol";

const ERRNO = { EBADF: 8, EINVAL: 28, EIO: 29, EISDIR: 31, ENOENT: 44, EROFS: 69 } as const;
type ErrnoName = keyof typeof ERRNO;

const DIR_MODE = 0o40555;
const FILE_MODE = 0o100444;
const O_ACCMODE = 3;
const O_RDONLY = 0;
/** Block size reported to programs; the I/O worker caches 1 MiB chunks. */
const BLOCK_SIZE = 1024 * 1024;
/** Most chunks fetched in one request when a program reads straight through a file. */
const READ_AHEAD_CHUNKS = 8;

/**
 * A URL link in the selected folder: a small file whose single line is "mayo-url <url>".
 * MAYOFS serves it as the remote file it names (see mayo-emscripten-fs.ts).
 */
const LINK_PREFIX = "mayo-url ";
/** Larger files are never links, so ordinary files are not read to find out. */
export const LINK_MAX_SIZE = 4096;

/** The URL a link file points to, or undefined if the text is not a link. */
export function parseLink(text: string): string | undefined {
  if (!text.startsWith(LINK_PREFIX)) return undefined;
  const url = text.slice(LINK_PREFIX.length).trim();
  return /^https?:\/\/\S+$/.test(url) ? url : undefined;
}

/** http(s) URLs in command arguments. Stops at whitespace, "#" (htslib's ##idx##) and ",". */
export const URL_PATTERN = /https?:\/\/[^\s#,]+/g;

export type RemoteFile = { url: string; size: number; mtime: number };
/** Per open stream: where the last read ended and how many sequential reads missed the cache. */
export type RemoteReadState = { file: RemoteFile; next: number; streak: number };

export type RemoteStats = { requests: number; bytes: number };

/** Split a URL into its directory (with a trailing slash) and its decoded file name. */
export function splitUrl(url: string): { base: string; name: string } {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const slash = path.lastIndexOf("/");
  const raw = path.slice(slash + 1);
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // Keep a malformed escape as written.
  }
  // An encoded slash cannot be part of a file name.
  if (name.includes("/")) name = raw;
  return { base: `${parsed.origin}${path.slice(0, slash + 1)}`, name };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CORS_HINT = "network error, or the server does not allow cross-origin requests (CORS)";

/**
 * Checks URLs before they are used (exists, has a size, supports range requests), asynchronously.
 * Used by the coordinator for URLs typed in commands and for Mayo.addUrl.
 */
export class RemoteChecker {
  private readonly files = new Map<string, RemoteFile>();
  // Servers (origins) already seen answering range requests.
  private readonly rangeServers = new Set<string>();

  /** Throws a message suitable for stderr. Nothing is downloaded. */
  async check(url: string): Promise<RemoteFile> {
    const known = this.files.get(url);
    if (known) return known;
    let head: Response;
    try {
      head = await fetch(url, { method: "HEAD", cache: "no-store" });
    } catch {
      throw new Error(`mayo: ${url}: could not connect (${CORS_HINT})`);
    }
    if (!head.ok || isHtml(head.headers.get("content-type"))) {
      throw new Error(`mayo: ${url}: ${head.ok ? "No such file (the server returned a web page)" : `HTTP ${head.status}`}`);
    }
    const size = Number(head.headers.get("content-length"));
    if (!head.headers.has("content-length") || !Number.isFinite(size)) {
      throw new Error(`mayo: ${url}: the server does not report the file size`);
    }

    const origin = new URL(url).origin;
    if (size > 0 && !this.rangeServers.has(origin)) {
      // Ask for one byte and stop reading at once, so a server that ignores Range does not
      // send the whole file.
      const controller = new AbortController();
      let status: number;
      try {
        const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: controller.signal, cache: "no-store" });
        status = probe.status;
      } catch {
        throw new Error(`mayo: ${url}: could not connect (${CORS_HINT})`);
      } finally {
        controller.abort();
      }
      if (status !== 206) {
        throw new Error(`mayo: ${url}: the server does not support range requests (HTTP ${status}); download the file to your folder first`);
      }
      this.rangeServers.add(origin);
    }
    const file = { url, size, mtime: Date.parse(head.headers.get("last-modified") ?? "") || Date.now() };
    this.files.set(url, file);
    return file;
  }
}

/**
 * Tool-side access to remote files, through the I/O worker (one per tool worker): sizes, reads
 * with read-ahead for sequential readers, and the run's statistics and messages.
 */
export class RemoteFiles {
  private readonly fs: MayoFS;
  private readonly files = new Map<string, RemoteFile>();
  // URLs looked up during this run that do not exist; probed again on the next run.
  private readonly missing = new Set<string>();
  private readonly messages = new Set<string>();
  private used = false;

  constructor(fs: MayoFS) {
    this.fs = fs;
  }

  /** Start a run: reset the statistics and messages, and forget missing files. */
  startRun(): void {
    this.used = false;
    this.messages.clear();
    this.missing.clear();
    this.takeStats();
  }

  /** Statistics and messages for the run; `used` is true if a remote file was read. */
  finishRun(): { stats: RemoteStats; messages: string[]; used: boolean } {
    return { stats: this.takeStats(), messages: [...this.messages], used: this.used };
  }

  /** Add a message to the run's stderr. */
  report(message: string): void {
    this.messages.add(`[Mayo] ${message}`);
  }

  /** Size and date of a file, asking the server if needed; undefined if it does not exist. */
  stat(url: string): RemoteFile | undefined {
    const known = this.files.get(url);
    if (known || this.missing.has(url)) return known;
    let file: RemoteFile | null = null;
    try {
      file = this.fs.remoteStat(url);
    } catch {
      // The I/O worker is unavailable: treat the file as missing.
    }
    if (!file) {
      this.missing.add(url);
      return undefined;
    }
    this.files.set(url, file);
    return file;
  }

  /**
   * Read for an open stream. Reading straight through fetches more at once (2, 4, 8 chunks),
   * cutting round trips. Returns the number of bytes copied; throws a ReadError (see isReadError).
   */
  readStream(state: RemoteReadState, target: Int8Array, offset: number, length: number, position: number): number {
    this.used = true;
    const { file } = state;
    if (position >= file.size || length === 0) return 0;
    state.streak = position === state.next ? state.streak + 1 : 0;
    const ahead = Math.min(READ_AHEAD_CHUNKS, 2 ** Math.max(0, state.streak - 1));
    const end = Math.min(position + length, file.size);
    let at = position;
    while (at < end) {
      let bytes: Uint8Array;
      try {
        bytes = this.fs.remoteRead(file, at, end - at, ahead);
      } catch (error) {
        const message = error instanceof Error && error.name === "ReadError" ? error.message : `${file.url}: ${describe(error)}`;
        this.messages.add(`[Mayo] ${message}`);
        throw new ReadError(message);
      }
      if (bytes.byteLength === 0) break;
      new Uint8Array(target.buffer, target.byteOffset + offset + (at - position), bytes.byteLength).set(bytes);
      at += bytes.byteLength;
    }
    state.next = at;
    return at - position;
  }

  private takeStats(): RemoteStats {
    try {
      return this.fs.remoteStats();
    } catch {
      return { requests: 0, bytes: 0 };
    }
  }
}

class ReadError extends Error {}

/** True for a failed remote read (already reported in the run's messages); map it to EIO. */
export function isReadError(error: unknown): boolean {
  return error instanceof ReadError;
}

function isHtml(contentType: string | null): boolean {
  // Dev servers and single-page hosts answer a missing file with index.html.
  return contentType?.includes("text/html") ?? false;
}

type FSNode = {
  id: number;
  name: string;
  mode: number;
  parent: FSNode;
  node_ops: unknown;
  stream_ops: unknown;
  size: number;
  timestamp: number;
  mount: { opts: URLFSMountOptions };
  remote?: RemoteFile;
};
type FSStream = { node: FSNode; flags: number; position: number; urlfs?: RemoteReadState };

export type URLFSMountOptions = {
  /** Directory URL, ending with "/". */
  base: string;
  /** Names whose URL is not simply base + name (for example signed URLs with a query string). */
  files: Map<string, string>;
};

export type URLFS = { type: { mount(mount: { opts: URLFSMountOptions }): FSNode } };

export function createURLFS(FS: EmscriptenFSInternals, remote: RemoteFiles): URLFS {
  // Names found by lookup in each mount root.
  const found = new WeakMap<FSNode, Set<string>>();

  function errno(name: ErrnoName): Error {
    return Object.assign(new FS.ErrnoError(ERRNO[name]), { code: name });
  }

  function createNode(parent: FSNode | null, name: string, file?: RemoteFile): FSNode {
    const node = FS.createNode(parent, name, file ? FILE_MODE : DIR_MODE, 0) as unknown as FSNode;
    node.node_ops = nodeOps;
    node.stream_ops = streamOps;
    node.remote = file;
    node.size = file ? file.size : 4096;
    node.timestamp = file ? file.mtime : Date.now();
    return node;
  }

  function urlOf(parent: FSNode, name: string): string {
    const { base, files } = parent.mount.opts;
    return files.get(name) ?? `${base}${encodeURIComponent(name)}`;
  }

  const nodeOps = {
    getattr(node: FSNode) {
      const time = new Date(node.timestamp);
      return {
        dev: 2,
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
        blksize: BLOCK_SIZE,
        blocks: Math.ceil(node.size / 512),
      };
    },
    setattr(node: FSNode, attr: { mode?: number; timestamp?: number; size?: number }) {
      if (attr.size !== undefined && attr.size !== node.size) throw errno("EROFS");
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
    },
    lookup(parent: FSNode, name: string): FSNode {
      // Remote directories are flat: only the mount root has children.
      if (parent.remote || parent.parent !== parent) throw errno("ENOENT");
      const file = remote.stat(urlOf(parent, name));
      if (!file) throw errno("ENOENT");
      let names = found.get(parent);
      if (!names) found.set(parent, names = new Set());
      names.add(name);
      return createNode(parent, name, file);
    },
    readdir(node: FSNode): string[] {
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
    open(stream: FSStream) {
      if ((stream.flags & O_ACCMODE) !== O_RDONLY) throw errno("EROFS");
      if (stream.node.remote) stream.urlfs = { file: stream.node.remote, next: 0, streak: 0 };
    },
    close() {},
    read(stream: FSStream, buffer: Int8Array, offset: number, length: number, position: number): number {
      if (!stream.node.remote) throw errno("EISDIR");
      if (!stream.urlfs) throw errno("EBADF");
      try {
        return remote.readStream(stream.urlfs, buffer, offset, length, position);
      } catch (error) {
        if (error instanceof ReadError) throw errno("EIO");
        throw error;
      }
    },
    write(): never {
      throw errno("EROFS");
    },
    llseek(stream: FSStream, offset: number, whence: number): number {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2 && stream.node.remote) position += stream.node.size;
      if (position < 0) throw errno("EINVAL");
      return position;
    },
  };

  return {
    type: {
      mount(mount: { opts: URLFSMountOptions }): FSNode {
        const root = createNode(null, "/");
        root.mount = mount;
        return root;
      },
    },
  };
}

/**
 * Add a URL to the selected folder as a link file, after checking that the server allows CORS and
 * range requests. Nothing is downloaded. Replaces an existing link, but not an ordinary file.
 * Returns the remote file's size.
 */
export async function linkUrl(fs: MayoFS, remote: RemoteChecker, url: string, path: string): Promise<number> {
  if (!fs.ready) throw new Error("Choose a folder first.");
  let existing: { kind: string; size: number } | undefined;
  try {
    existing = fs.stat(path);
  } catch (error) {
    if (!(error instanceof Error && error.name === "NotFoundError")) throw error;
  }
  if (existing) {
    const isLink = existing.kind === "file" && existing.size <= LINK_MAX_SIZE && parseLink(new TextDecoder().decode(fs.readFile(path)));
    if (!isLink) throw new Error(`${path} already exists in the folder; choose another name.`);
  }
  const file = await remote.check(url);
  try {
    fs.writeFile(path, new TextEncoder().encode(`${LINK_PREFIX}${url}\n`));
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") throw new Error(`The folder for ${path} does not exist.`);
    throw error;
  }
  return file.size;
}

/**
 * Stream a URL into a file of the selected folder, a chunk at a time, so memory use stays small
 * whatever the file size. For servers without range support and for files used many times.
 */
export async function downloadToFolder(fs: MayoFS, url: string, path: string): Promise<number> {
  if (!fs.ready) throw new Error("Choose a folder first.");
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error(`Could not download ${url} (${CORS_HINT}).`);
  }
  if (!response.ok || !response.body) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  if (isHtml(response.headers.get("content-type"))) throw new Error(`Could not download ${url}: the server returned a web page.`);

  const id = fs.openWrite(path, false);
  const reader = response.body.getReader();
  const pending = new Uint8Array(DATA_CAPACITY);
  let pendingLength = 0;
  let written = 0;
  const flush = () => {
    if (pendingLength === 0) return;
    fs.writeAt(id, written, pending.subarray(0, pendingLength));
    written += pendingLength;
    pendingLength = 0;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Network chunks are small; collect them so each I/O worker round trip moves up to 1 MiB.
      for (let offset = 0; offset < value.byteLength;) {
        const count = Math.min(value.byteLength - offset, DATA_CAPACITY - pendingLength);
        pending.set(value.subarray(offset, offset + count), pendingLength);
        pendingLength += count;
        offset += count;
        if (pendingLength === DATA_CAPACITY) flush();
      }
    }
    flush();
    fs.close(id);
  } catch (error) {
    void reader.cancel().catch(() => {});
    try {
      fs.abort(id);
    } catch {
      // Already closed, or the I/O worker stopped.
    }
    throw new Error(`Could not download ${url}: ${describe(error)}`);
  }
  return written;
}
