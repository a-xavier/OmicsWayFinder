/**
 * The selected folder for Java: the natives of omics.cheerp.Folder, and the choice of files to
 * copy into /files/ before a run (see Workspace.java for the copy itself).
 */

import { folderPath, getDirectory, getFile, openWritable, requireFolderPath } from "../shared/folder";

type CheerpJLibrary = unknown;

/** The folder of the current run, and what Java read from and wrote to it. */
export type FolderSession = {
  folder: FileSystemDirectoryHandle;
  /** Files Java copies into /files/ before the run. */
  inputs: string[];
  /** Files Java copied back, in order. */
  written: string[];
  writers: Map<string, FileSystemWritableFileStream>;
};

export function newFolderSession(folder: FileSystemDirectoryHandle, inputs: string[] = []): FolderSession {
  return { folder, inputs, written: [], writers: new Map() };
}

/** Drops unfinished writes (a failed run); the files in the folder stay as they were. */
export async function abortWrites(session: FolderSession): Promise<void> {
  await Promise.all([...session.writers.values()].map(writer => writer.abort().catch(() => undefined)));
  session.writers.clear();
}

/** The natives of omics.cheerp.Folder, for cheerpjInit({ natives }). */
export function folderNatives(session: () => FolderSession | null) {
  const open = (): FolderSession => {
    const current = session();
    if (!current) throw new Error("No folder for this Java run.");
    return current;
  };
  return {
    async Java_omics_cheerp_Folder_list(_lib: CheerpJLibrary, path: string): Promise<string> {
      const directory = await getDirectory(open().folder, requireFolderPath(path));
      const lines: string[] = [];
      for await (const handle of directory.values()) {
        lines.push(handle.kind === "directory" ? `d\t${handle.name}` : `f\t${(await handle.getFile()).size}\t${handle.name}`);
      }
      return lines.sort((a, b) => entryName(a).localeCompare(entryName(b))).join("\n");
    },
    async Java_omics_cheerp_Folder_inputs(): Promise<string> {
      return open().inputs.join("\n");
    },
    async Java_omics_cheerp_Folder_read(_lib: CheerpJLibrary, path: string, offset: number | bigint, length: number): Promise<Int8Array> {
      const file = await getFile(open().folder, path);
      const start = Number(offset);
      return new Int8Array(await file.slice(start, start + length).arrayBuffer());
    },
    async Java_omics_cheerp_Folder_create(_lib: CheerpJLibrary, path: string): Promise<void> {
      const current = open();
      await current.writers.get(path)?.abort();
      current.writers.set(path, await openWritable(current.folder, path, false));
    },
    async Java_omics_cheerp_Folder_write(_lib: CheerpJLibrary, path: string, data: Int8Array, length: number): Promise<void> {
      const writer = open().writers.get(path);
      if (!writer) throw new Error(`"${path}" is not open for writing.`);
      // `data` is a view of Java's array, which Java reuses for the next chunk: copy it.
      await writer.write(new Uint8Array(data.buffer, data.byteOffset, length).slice());
    },
    async Java_omics_cheerp_Folder_close(_lib: CheerpJLibrary, path: string): Promise<void> {
      const current = open();
      const writer = current.writers.get(path);
      if (!writer) return;
      current.writers.delete(path);
      await writer.close();
      current.written.push(path);
    },
    async Java_omics_cheerp_Folder_mkdir(_lib: CheerpJLibrary, path: string): Promise<void> {
      await getDirectory(open().folder, requireFolderPath(path), true);
    },
  };
}

/**
 * The folder files a command needs in /files/: every argument (or the value after "=" in
 * "--key=value") that names a file, together with the files next to it that share its name
 * (indexes such as reads.bam.bai, reads.bai, ref.fa.fai, ref.dict), and every file under an
 * argument that names a directory ("." is the whole folder).
 */
export async function inputsForArgs(folder: FileSystemDirectoryHandle, args: string[]): Promise<string[]> {
  const inputs = new Set<string>();
  for (const arg of args) {
    for (const candidate of new Set([arg, arg.slice(arg.indexOf("=") + 1)])) {
      if (!candidate || candidate.startsWith("-") || candidate.includes("://")) continue;
      const parts = folderPath(candidate.replace(/^\/files\//, ""));
      if (parts === null) continue;
      if (parts.length === 0) {
        await addDirectory(folder, "", inputs);
        continue;
      }
      const name = parts[parts.length - 1];
      const parent = await getDirectory(folder, parts.slice(0, -1)).catch(() => null);
      if (!parent) continue;
      const prefix = parts.slice(0, -1).map(part => `${part}/`).join("");
      const directory = await parent.getDirectoryHandle(name).catch(() => null);
      if (directory) {
        await addDirectory(directory, prefix + name, inputs);
        continue;
      }
      if (!(await parent.getFileHandle(name).catch(() => null))) continue;
      const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".") + 1) : `${name}.`;
      for await (const handle of parent.values()) {
        if (handle.kind === "file" && (handle.name === name || handle.name.startsWith(`${name}.`) || handle.name.startsWith(stem))) {
          inputs.add(prefix + handle.name);
        }
      }
    }
  }
  return [...inputs];
}

async function addDirectory(directory: FileSystemDirectoryHandle, path: string, inputs: Set<string>): Promise<void> {
  for await (const handle of directory.values()) {
    const child = path ? `${path}/${handle.name}` : handle.name;
    if (handle.kind === "file") inputs.add(child);
    else await addDirectory(handle, child, inputs);
  }
}

function entryName(line: string): string {
  return line.slice(line.lastIndexOf("\t") + 1);
}
