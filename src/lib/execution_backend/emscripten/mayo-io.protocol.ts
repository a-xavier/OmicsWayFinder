/**
 * Messages from the Mayo coordinator to the I/O worker, on the worker's own channel.
 *
 * - root: use a folder (or none); aborts writes in progress and closes every handle. Answered with
 *   "rooted", so the coordinator can wait for it without blocking.
 * - connect: add a client (a tool worker, or the coordinator itself). The client sends requests on
 *   `port` and blocks until the reply is in `buffer` (control slots, then data; see below).
 * - disconnect: forget a client that was stopped, aborting its writes so no temporary files stay.
 *
 * A nested worker cannot start while its parent is blocked in Atomics.wait, so the coordinator
 * creates the I/O worker and waits for "ready" before any client blocks.
 */
export type MayoIOControl =
  | { type: "root"; directory: FileSystemDirectoryHandle | undefined }
  | { type: "connect"; client: number; port: MessagePort; buffer: SharedArrayBuffer }
  | { type: "disconnect"; client: number };
export type MayoIOEvent = { type: "ready" } | { type: "rooted" };

/** What a client needs to talk to the I/O worker: send it to a tool worker. */
export type MayoIOConnection = { port: MessagePort; buffer: SharedArrayBuffer };

/** Bytes of shared memory per client: control slots, then the data area. */
export const CONNECTION_BYTES = 16 + 1024 * 1024;

/**
 * Synchronous requests a client sends to the I/O worker. Replies go through shared memory.
 * Paths are relative to the selected folder; "" is the folder itself.
 */
export type MayoIORequest =
  // Replies with MayoIOStat.
  | { type: "stat"; path: string }
  // Replies with MayoIOEntry[].
  | { type: "list"; path: string }
  // Read handles: openRead replies with MayoIOOpenRead; read replies with the bytes.
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
  | { type: "create"; path: string; kind: MayoIOKind }
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

export type MayoIOKind = "file" | "directory";
export type MayoIOStat = { kind: MayoIOKind; size: number; mtime: number };
export type MayoIOEntry = { name: string; kind: MayoIOKind };
export type MayoIOOpenRead = { id: number; size: number; mtime: number };

// Shared buffer layout: four Int32 control slots, then the reply bytes.
export const CONTROL_STATE = 0;
export const CONTROL_STATUS = 1;
export const CONTROL_LENGTH = 2;

export const STATE_IDLE = 0;
export const STATE_PENDING = 1;
export const STATE_DONE = 2;

export const STATUS_OK = 0;
export const STATUS_ERROR = 1;

/** Largest reply or write chunk per request; reads and writes are split into chunks of this size. */
export const DATA_CAPACITY = CONNECTION_BYTES - 16;
