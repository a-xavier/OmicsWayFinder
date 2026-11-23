/**
 * Remote files on the coordinator side: checking URLs before a run, adding them to the folder as
 * link files, and downloading them into the folder.
 */

import { WriteBuffer, type IOClient } from "../io/client";
import { NO_FOLDER_MESSAGE } from "../io/protocol";
import { linkText, mayBeLink, parseLinkBytes } from "../shared/url-links";
import { CORS_HINT, fetchFile, headRemoteFile, type RemoteFile } from "../shared/urls";

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
    let file: RemoteFile;
    try {
      file = await headRemoteFile(url);
    } catch (error) {
      throw new Error(`mayo: ${(error as Error).message}`);
    }

    const origin = new URL(url).origin;
    if (file.size > 0 && !this.rangeServers.has(origin)) {
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
    this.files.set(url, file);
    return file;
  }
}

/**
 * Add a URL to the selected folder as a link file, after checking that the server allows CORS and
 * range requests. Nothing is downloaded. Replaces an existing link, but not an ordinary file.
 * Returns the remote file's size.
 */
export async function linkUrl(io: IOClient, remote: RemoteChecker, url: string, path: string): Promise<number> {
  if (!io.ready) throw new Error(NO_FOLDER_MESSAGE);
  let existing: { kind: string; size: number } | undefined;
  try {
    existing = io.stat(path);
  } catch (error) {
    if (!(error instanceof Error && error.name === "NotFoundError")) throw error;
  }
  if (existing) {
    const isLink = existing.kind === "file" && mayBeLink(existing.size) && parseLinkBytes(io.readFile(path));
    if (!isLink) throw new Error(`${path} already exists in the folder; choose another name.`);
  }
  const file = await remote.check(url);
  try {
    io.writeFile(path, new TextEncoder().encode(linkText(url)));
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
export async function downloadToFolder(io: IOClient, url: string, path: string): Promise<number> {
  if (!io.ready) throw new Error(NO_FOLDER_MESSAGE);
  const response = await fetchFile(url, { cache: "no-store" });
  if (!response.body) throw new Error(`Could not download ${url}: the response has no body.`);

  const id = io.openWrite(path, false);
  const reader = response.body.getReader();
  // Network chunks are small; collect them so each I/O worker round trip moves a full block.
  const writes = new WriteBuffer((position, bytes) => io.writeAt(id, position, bytes));
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writes.write(written, value);
      written += value.byteLength;
    }
    writes.flush();
    io.close(id);
  } catch (error) {
    void reader.cancel().catch(() => {});
    io.abortQuietly(id);
    throw new Error(`Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return written;
}
