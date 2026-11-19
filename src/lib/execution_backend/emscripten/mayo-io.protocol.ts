/**
 * Sent once, asynchronously, when the I/O worker starts. The worker answers with a normal
 * "ready" message. The tool worker must wait for it without blocking, because a nested
 * worker cannot start while its parent is blocked in Atomics.wait.
 */
export type MayoIOSetup = { type: "setup"; buffer: SharedArrayBuffer; directory: FileSystemDirectoryHandle };
export type MayoIOReady = { type: "ready" };

/** Synchronous requests the tool worker sends to the I/O worker. Replies go through shared memory. */
export type MayoIORequest =
  | { type: "stat"; path: string }
  | { type: "read"; path: string; offset: number; length: number };

// Shared buffer layout: four Int32 control slots, then the reply bytes.
export const CONTROL_STATE = 0;
export const CONTROL_STATUS = 1;
export const CONTROL_LENGTH = 2;

export const STATE_IDLE = 0;
export const STATE_PENDING = 1;
export const STATE_DONE = 2;

export const STATUS_OK = 0;
export const STATUS_ERROR = 1;

/** Largest reply per request; reads are split into chunks of this size. */
export const DATA_CAPACITY = 1024 * 1024;
