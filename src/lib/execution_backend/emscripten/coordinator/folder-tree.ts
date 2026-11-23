import { isSwapFile, NO_FOLDER_MESSAGE } from "../io/protocol";
import type { MayoDirectory, MayoEntry } from "../protocol";
import { mayBeLink, parseLink } from "../shared/url-links";

/** Worker-side folder scanner: one selected root handle and a display snapshot of its contents. */
export class FolderTree {
  private directory: FileSystemDirectoryHandle | undefined;
  private tree: MayoDirectory | undefined;

  /** Scan the selected folder before replacing any previously initialized root and tree. */
  async init(directory: FileSystemDirectoryHandle): Promise<MayoDirectory> {
    const tree = await this.buildTree(directory);
    this.directory = directory;
    this.tree = tree;
    return tree;
  }

  /** Return the last successful snapshot without rescanning the filesystem. */
  getTree(): MayoDirectory {
    if (!this.tree) throw new Error(NO_FOLDER_MESSAGE);
    return this.tree;
  }

  /** Rescan the selected root, preserving the previous snapshot if the scan fails. */
  async refreshTree(): Promise<MayoDirectory> {
    const directory = this.directory;
    if (!directory) throw new Error(NO_FOLDER_MESSAGE);
    const tree = await this.buildTree(directory);
    this.tree = tree;
    return tree;
  }

  /** The URL if the file is a link (only small files are read). */
  private async linkTarget(entry: FileSystemFileHandle): Promise<string | undefined> {
    try {
      const file = await entry.getFile();
      if (!mayBeLink(file.size)) return undefined;
      return parseLink(await file.text());
    } catch {
      return undefined;
    }
  }

  /** Recursively enumerate directory handles. Only small files are read, to spot URL links. */
  private async buildTree(directory: FileSystemDirectoryHandle): Promise<MayoDirectory> {
    const children: MayoEntry[] = [];
    for await (const entry of directory.values()) {
      if (entry.kind === "directory") {
        children.push(await this.buildTree(entry));
      } else if (!isSwapFile(entry.name)) {
        children.push({ name: entry.name, kind: "file", url: await this.linkTarget(entry) });
      }
    }
    return { name: directory.name, kind: "directory", children };
  }
}
