/**
 * URL links: small files in the selected folder whose single line is "mayo-url <url>". Tools read
 * a link as the remote file it names (see tool/folder-fs.ts); the folder tree shows its URL.
 * Mayo.addUrl creates them (see coordinator/remote.ts).
 */

const LINK_PREFIX = "mayo-url ";

/** Larger files are never links, so ordinary files are not read to find out. */
const LINK_MAX_SIZE = 4096;

/** Whether a file of this size can be a link, and so is worth reading to find out. */
export function mayBeLink(size: number): boolean {
  return size > 0 && size <= LINK_MAX_SIZE;
}

/** The URL in a link file's bytes, or undefined if they are not a link. */
export function parseLinkBytes(bytes: Uint8Array): string | undefined {
  return parseLink(new TextDecoder().decode(bytes));
}

/** The URL a link file points to, or undefined if the text is not a link. */
export function parseLink(text: string): string | undefined {
  if (!text.startsWith(LINK_PREFIX)) return undefined;
  const url = text.slice(LINK_PREFIX.length).trim();
  return /^https?:\/\/\S+$/.test(url) ? url : undefined;
}

/** The contents of a link file. */
export function linkText(url: string): string {
  return `${LINK_PREFIX}${url}\n`;
}
