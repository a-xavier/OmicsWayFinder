/**
 * RemoteFiles: a tool worker's synchronous access to remote files, through its IOClient. The HTTP
 * requests and the chunk cache live in the I/O worker (io/remote-cache.ts), shared by every tool.
 *
 * Used by URLFS (URLs typed in commands) and FOLDERFS (URL links in the selected folder). It also
 * keeps the run's statistics and messages, which end up in the stage result and its stderr.
 */

import type { IOClient } from "../io/client";
import { REMOTE_MAX_AHEAD } from "../io/protocol";
import { emptyStats, type RemoteFile, type RemoteStats } from "../shared/urls";

/** Per open stream: where the last read ended and how many sequential reads missed the cache. */
export type RemoteReadState = { file: RemoteFile; next: number; streak: number };

export class RemoteFiles {
  private readonly io: IOClient;
  private readonly files = new Map<string, RemoteFile>();
  // URLs looked up during this run that do not exist; probed again on the next run.
  private readonly missing = new Set<string>();
  private readonly messages = new Set<string>();
  private used = false;

  constructor(io: IOClient) {
    this.io = io;
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
      file = this.io.remoteStat(url);
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

  /** State for a stream opened on a remote file; pass it to read(). */
  open(file: RemoteFile): RemoteReadState {
    return { file, next: 0, streak: 0 };
  }

  /**
   * A filesystem's read() for a remote file. Reading straight through fetches more at once
   * (2, 4, 8 chunks), cutting round trips. Returns the number of bytes copied. A failed read is
   * reported in the run's messages and throws `eio()`, the filesystem's EIO error.
   */
  read(state: RemoteReadState, target: Int8Array, offset: number, length: number, position: number, eio: () => Error): number {
    this.used = true;
    const { file } = state;
    if (position >= file.size || length === 0) return 0;
    state.streak = position === state.next ? state.streak + 1 : 0;
    const ahead = Math.min(REMOTE_MAX_AHEAD, 2 ** Math.max(0, state.streak - 1));
    const end = Math.min(position + length, file.size);
    let at = position;
    while (at < end) {
      let bytes: Uint8Array;
      try {
        bytes = this.io.remoteRead(file, at, end - at, ahead);
      } catch (error) {
        // The I/O worker's messages (named ReadError) already name the URL.
        this.report(error instanceof Error && error.name === "ReadError"
          ? error.message
          : `${file.url}: ${error instanceof Error ? error.message : String(error)}`);
        throw eio();
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
      return this.io.remoteStats();
    } catch {
      return emptyStats();
    }
  }
}
