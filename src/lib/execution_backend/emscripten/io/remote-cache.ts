/**
 * Remote file reading for the I/O worker: HTTP HEAD for sizes, range requests for data, and one
 * chunk cache shared by every client, so a file read by several tools (or by the two ends of a
 * pipe) is fetched once and memory use stays bounded however many tools run.
 *
 * Tool workers reach it through IOClient requests (remoteStat, remoteRead, remoteStats); see
 * tool/remote-files.ts for the tool side.
 */

import { CORS_HINT, emptyStats, headRemoteFile, type RemoteFile, type RemoteStats } from "../shared/urls";
import { REMOTE_CHUNK_SIZE as CHUNK_SIZE, REMOTE_MAX_AHEAD } from "./protocol";

/** Most bytes kept in the chunk cache. */
const CACHE_LIMIT = 64 * 1024 * 1024;

function chunkKey(url: string, index: number): string {
  return `${index} ${url}`;
}

/** A failed remote read; the message is shown in the run's stderr and the tool sees EIO. */
function readError(message: string): Error {
  const error = new Error(message);
  error.name = "ReadError";
  return error;
}

export class RemoteCache {
  private readonly files = new Map<string, RemoteFile>();
  private readonly cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  private readonly stats = new Map<number, RemoteStats>();

  /** Size and date of a file, or null if it does not exist or cannot be read. */
  async stat(url: string): Promise<RemoteFile | null> {
    const known = this.files.get(url);
    if (known) return known;
    let file: RemoteFile;
    try {
      file = await headRemoteFile(url);
    } catch {
      // Tools probe for optional files (indexes); a server that refuses them counts as "missing".
      return null;
    }
    this.files.set(url, file);
    return file;
  }

  /** Bytes from `offset`, up to `length` and the end of the chunk that holds `offset`. */
  async read(client: number, url: string, size: number, offset: number, length: number, ahead: number): Promise<Uint8Array> {
    if (offset >= size || length <= 0) return new Uint8Array();
    const index = Math.floor(offset / CHUNK_SIZE);
    const chunk = this.cached(url, index) ?? await this.fetchChunks(client, url, size, index, Math.max(1, Math.min(REMOTE_MAX_AHEAD, ahead)));
    const from = offset - index * CHUNK_SIZE;
    return chunk.subarray(from, from + Math.min(length, size - offset));
  }

  /** A client's statistics since the last call, then reset. */
  takeStats(client: number): RemoteStats {
    const stats = this.stats.get(client) ?? emptyStats();
    this.stats.delete(client);
    return stats;
  }

  forget(client: number): void {
    this.stats.delete(client);
  }

  private cached(url: string, index: number): Uint8Array | undefined {
    const key = chunkKey(url, index);
    const chunk = this.cache.get(key);
    if (chunk) {
      // Most recently used goes last.
      this.cache.delete(key);
      this.cache.set(key, chunk);
    }
    return chunk;
  }

  /** Fetch `count` chunks from `index` (fewer at the end of the file or before a cached chunk). */
  private async fetchChunks(client: number, url: string, size: number, index: number, count: number): Promise<Uint8Array> {
    const last = Math.ceil(size / CHUNK_SIZE) - 1;
    let stop = index;
    while (stop < last && stop - index + 1 < count && !this.cache.has(chunkKey(url, stop + 1))) stop++;
    const start = index * CHUNK_SIZE;
    const end = Math.min(size, (stop + 1) * CHUNK_SIZE) - 1;

    let response: Response;
    let data: Uint8Array;
    try {
      response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: "no-store" });
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw readError(`${url}: could not read bytes ${start}-${end} (${error instanceof Error ? error.message : String(error)}; ${CORS_HINT})`);
    }
    const stats = this.stats.get(client) ?? emptyStats();
    stats.requests++;
    stats.bytes += data.byteLength;
    this.stats.set(client, stats);
    if (response.status !== 206) throw readError(`${url}: HTTP ${response.status} for a range request (bytes ${start}-${end})`);
    if (data.byteLength !== end - start + 1) {
      throw readError(`${url}: expected ${end - start + 1} bytes from ${start}, got ${data.byteLength} (the file may have changed, or the server compresses it)`);
    }

    for (let i = index; i <= stop; i++) {
      const chunk = data.slice((i - index) * CHUNK_SIZE, (i - index + 1) * CHUNK_SIZE);
      const key = chunkKey(url, i);
      const previous = this.cache.get(key);
      if (previous) this.cacheBytes -= previous.byteLength;
      this.cache.delete(key);
      this.cache.set(key, chunk);
      this.cacheBytes += chunk.byteLength;
    }
    const first = this.cache.get(chunkKey(url, index))!;
    // Drop the least recently used chunks, keeping the ones just fetched.
    for (const [key, chunk] of this.cache) {
      if (this.cacheBytes <= CACHE_LIMIT || chunk === first) break;
      this.cache.delete(key);
      this.cacheBytes -= chunk.byteLength;
    }
    return first;
  }
}
