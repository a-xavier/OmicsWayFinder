/**
 * What a tool worker mounts in its Emscripten filesystem:
 * - /shared/data, the working directory: the selected folder (FOLDERFS), remounted before each run
 *   so files changed by other tools or outside the app are seen;
 * - /shared/urls/<n>: one URLFS per remote directory named in a command's arguments.
 */

import type { IOClient } from "../io/client";
import { splitUrl, URL_PATTERN } from "../shared/urls";
import type { EmscriptenFS } from "./emscripten";
import { createFOLDERFS, type FOLDERFS } from "./folder-fs";
import type { RemoteFiles } from "./remote-files";
import { createURLFS, type URLFS, type URLFSMountOptions } from "./url-fs";

export const DIR_SHARED = "/shared";
export const DIR_DATA = "/shared/data";
const DIR_URLS = "/shared/urls";

export class Mounts {
  private readonly FS: EmscriptenFS;
  private readonly io: IOClient;
  private readonly remote: RemoteFiles;
  private folderfs: FOLDERFS | undefined;
  private folderMounted = false;
  private urlfs: URLFS | undefined;
  // One mount per remote directory URL, kept for the worker's lifetime so paths stay the same.
  private readonly urlMounts = new Map<string, { path: string; opts: URLFSMountOptions }>();

  constructor(FS: EmscriptenFS, io: IOClient, remote: RemoteFiles) {
    this.FS = FS;
    this.io = io;
    this.remote = remote;
    FS.mkdir(DIR_SHARED);
    FS.mkdir(DIR_DATA);
    FS.mkdir(DIR_URLS);
    FS.chdir(DIR_DATA);
  }

  /** (Re)mount the selected folder at /shared/data; `folder` is false when none is selected. */
  mountFolder(folder: boolean): void {
    if (this.folderMounted) {
      this.FS.unmount(DIR_DATA);
      this.folderMounted = false;
    }
    this.io.folder = folder;
    if (!this.io.ready) return;
    this.folderfs ??= createFOLDERFS(this.FS, this.io, this.remote);
    this.FS.mount(this.folderfs.type, {}, DIR_DATA);
    this.folderMounted = true;
  }

  /** Replace each http(s) URL in the arguments by its path under /shared/urls. */
  mountUrls(args: string[]): string[] {
    return args.map(arg => arg.replace(URL_PATTERN, url => this.mountUrl(url)));
  }

  /** Close files a program left open, which saves them. Returns one message per file that could not be saved. */
  closeOpenFiles(): string[] {
    return this.folderfs?.closeOpenFiles() ?? [];
  }

  /**
   * Mount a URL's directory (the coordinator has already checked the URL) and return the local
   * path, e.g. https://host/data/reads.bam -> /shared/urls/0/reads.bam.
   */
  private mountUrl(url: string): string {
    const FS = this.FS;
    const { base, name } = splitUrl(url);
    this.urlfs ??= createURLFS(FS, this.remote);
    let mount = this.urlMounts.get(base);
    if (!mount) {
      mount = { path: `${DIR_URLS}/${this.urlMounts.size}`, opts: { base, files: new Map() } };
      FS.mkdir(mount.path);
      FS.mount(this.urlfs.type, mount.opts, mount.path);
      this.urlMounts.set(base, mount);
    }
    if (!name) return mount.path;
    // The exact URL as written (it may carry a query string, as signed URLs do).
    const previous = mount.opts.files.get(name);
    mount.opts.files.set(name, url);
    if (previous !== undefined && previous !== url) {
      // Emscripten caches the node found for the old URL; remounting drops it.
      FS.unmount(mount.path);
      FS.mount(this.urlfs.type, mount.opts, mount.path);
    }
    return `${mount.path}/${name}`;
  }
}
