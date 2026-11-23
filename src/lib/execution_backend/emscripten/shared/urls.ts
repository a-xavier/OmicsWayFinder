/** Helpers for remote files (http(s) URLs), used by every layer. */

/** A remote file's size and date, as reported by the server. */
export type RemoteFile = { url: string; size: number; mtime: number };

/** HTTP range requests made and bytes received. */
export type RemoteStats = { requests: number; bytes: number };

export function emptyStats(): RemoteStats {
  return { requests: 0, bytes: 0 };
}

/** http(s) URLs in command arguments. Stops at whitespace, "#" (htslib's ##idx##) and ",". */
export const URL_PATTERN = /https?:\/\/[^\s#,]+/g;

export const CORS_HINT = "network error, or the server does not allow cross-origin requests (CORS)";

/** Dev servers and single-page hosts answer a missing file with index.html. */
export function isHtml(contentType: string | null): boolean {
  return contentType?.includes("text/html") ?? false;
}

/**
 * Fetch a whole file, refusing errors and web pages. Throws "Could not download <url>: <reason>".
 */
export async function fetchFile(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error(`Could not download ${url} (${CORS_HINT}).`);
  }
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  if (isHtml(response.headers.get("content-type"))) throw new Error(`Could not download ${url}: the server returned a web page.`);
  return response;
}

/**
 * A remote file's size and date, from an HTTP HEAD request. Throws "<url>: <reason>" if the server
 * cannot be reached, has no such file, or does not report its size.
 */
export async function headRemoteFile(url: string): Promise<RemoteFile> {
  let head: Response;
  try {
    head = await fetch(url, { method: "HEAD", cache: "no-store" });
  } catch {
    throw new Error(`${url}: could not connect (${CORS_HINT})`);
  }
  if (!head.ok || isHtml(head.headers.get("content-type"))) {
    throw new Error(`${url}: ${head.ok ? "No such file (the server returned a web page)" : `HTTP ${head.status}`}`);
  }
  const size = Number(head.headers.get("content-length"));
  if (!head.headers.has("content-length") || !Number.isFinite(size)) {
    throw new Error(`${url}: the server does not report the file size`);
  }
  return { url, size, mtime: Date.parse(head.headers.get("last-modified") ?? "") || Date.now() };
}

/** Split a URL into its directory (with a trailing slash) and its decoded file name ("" for a directory URL). */
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

/** The decoded file name of a URL ("" for a directory URL). */
export function urlFileName(url: string): string {
  return splitUrl(url).name;
}

/** The sum of several statistics, or undefined if there are none. */
export function addStats(stats: (RemoteStats | undefined)[]): RemoteStats | undefined {
  const present = stats.filter(stat => stat !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((sum, stat) => ({ requests: sum.requests + stat.requests, bytes: sum.bytes + stat.bytes }));
}
