/**
 * Sent once, asynchronously, when the I/O worker starts. The worker answers with a normal
 * "ready" message. The tool worker must wait for it without blocking, because a nested
 * worker cannot start while its parent is blocked in Atomics.wait.
 */
export type MayoIOSetup = { type: "setup"; buffer: SharedArrayBuffer; directory: FileSystemDirectoryHandle };
export type MayoIOReady = { type: "ready" };

/**
 * Synchronous requests the tool worker sends to the I/O worker. Replies go through shared memory.
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
  | { type: "rename"; from: string; to: string };

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
export const DATA_CAPACITY = 1024 * 1024;
