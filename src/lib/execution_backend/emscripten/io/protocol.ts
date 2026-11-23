/**
 * Messages between the I/O worker (io/worker.ts) and its clients.
 *
 * Control messages, from the coordinator (io/host.ts) on the worker's own channel:
 *
 * - root: use a folder (or none); aborts writes in progress and closes every handle. Answered with
 *   "rooted", so the coordinator can wait for it without blocking.
 * - connect: add a client (a tool worker, or the coordinator itself). The client sends requests on
 *   `port` and blocks until the reply is in `buffer` (control slots, then data; see below).
 * - disconnect: forget a client that was stopped, aborting its writes so no temporary files stay.
 */
export type IOControl =
  | { type: "root"; directory: FileSystemDirectoryHandle | undefined }
  | { type: "connect"; client: number; port: MessagePort; buffer: SharedArrayBuffer }
  | { type: "disconnect"; client: number };
export type IOEvent = { type: "ready" } | { type: "rooted" };

/** What a client needs to talk to the I/O worker: send it to a tool worker. */
export type IOConnection = { port: MessagePort; buffer: SharedArrayBuffer };

// Shared buffer layout: four Int32 control slots, then the reply bytes.
const CONTROL_SLOTS = 4;
const CONTROL_BYTES = CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT;

/** Largest reply or write chunk per request; reads and writes are split into chunks of this size. */
export const DATA_CAPACITY = 1024 * 1024;

/** Bytes of shared memory per client: control slots, then the data area. */
export const CONNECTION_BYTES = CONTROL_BYTES + DATA_CAPACITY;

/** The control slots and data area of a connection's shared buffer. */
export function connectionViews(buffer: SharedArrayBuffer): { control: Int32Array; data: Uint8Array } {
  return { control: new Int32Array(buffer, 0, CONTROL_SLOTS), data: new Uint8Array(buffer, CONTROL_BYTES) };
}

/** Bytes per cached remote chunk. A remoteRead reply never crosses a chunk, so it must fit DATA_CAPACITY. */
export const REMOTE_CHUNK_SIZE = DATA_CAPACITY;
/** Most remote chunks fetched in one request. */
export const REMOTE_MAX_AHEAD = 8;

export const NO_FOLDER_MESSAGE = "Choose a folder first.";
export const ISOLATION_MESSAGE = "Mayo needs cross-origin isolation (COOP/COEP headers) to run tools and use folders.";

/** Chrome's temporary copies of files being written (<name>.crswap); hidden from listings. */
export function isSwapFile(name: string): boolean {
  return name.endsWith(".crswap");
}

/**
 * Synchronous requests a client sends to the I/O worker. Replies go through shared memory.
 * Paths are relative to the selected folder; "" is the folder itself.
 */
export type IORequest =
  // Replies with IOStat.
  | { type: "stat"; path: string }
  // Replies with IOEntry[].
  | { type: "list"; path: string }
  // Read handles: openRead replies with IOOpenRead; read replies with the bytes.
  | { type: "openRead"; path: string }
  | { type: "read"; id: number; offset: number; length: number }
  // Write handles: openWrite creates the file if needed and replies with { id }. The data goes to a
  // temporary copy that replaces the file on close. keepExistingData starts the copy from the
  // current contents (otherwise it starts empty).
  | { type: "openWrite"; path: string; keepExistingData?: boolean }
  // Takes its bytes from the shared data area. Without a position, appends after the previous write.
  | { type: "write"; id: number; length: number; position?: number }
  | { type: "truncateHandle"; id: number; size: number }
  // Closes a read or write handle; a write handle replaces its target file.
  | { type: "close"; id: number }
  | { type: "abort"; id: number }
  // Resize a file that is not open for writing (commits immediately).
  | { type: "truncate"; path: string; size: number }
  // Create an empty file or a directory. Parent folders must exist.
  | { type: "create"; path: string; kind: IOKind }
  // Remove a file (like unlink) or an empty directory (like rmdir).
  | { type: "remove"; path: string }
  | { type: "rmdir"; path: string }
  // Move a file or directory, replacing an existing file at the target (like rename).
  | { type: "rename"; from: string; to: string }
  // Remote files (URLs), read with HTTP range requests and kept in one chunk cache shared by
  // every client. remoteStat replies with RemoteFile JSON, or null if the file does not exist.
  | { type: "remoteStat"; url: string }
  // Replies with bytes from `offset`, at most `length` and never past the chunk holding `offset`.
  // On a cache miss, `ahead` chunks are fetched in one request. Errors are "ReadError: <message>".
  | { type: "remoteRead"; url: string; size: number; offset: number; length: number; ahead: number }
  // Replies with this client's RemoteStats since the last remoteStats request, and resets them.
  | { type: "remoteStats" };

export type IOKind = "file" | "directory";
export type IOStat = { kind: IOKind; size: number; mtime: number };
export type IOEntry = { name: string; kind: IOKind };
export type IOOpenRead = { id: number; size: number; mtime: number };

// Control slot indexes.
export const CONTROL_STATE = 0;
export const CONTROL_STATUS = 1;
export const CONTROL_LENGTH = 2;

export const STATE_IDLE = 0;
export const STATE_PENDING = 1;
export const STATE_DONE = 2;

export const STATUS_OK = 0;
export const STATUS_ERROR = 1;
