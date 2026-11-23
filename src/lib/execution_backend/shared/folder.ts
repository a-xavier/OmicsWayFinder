/**
 * Paths and handles in the folder the user selected (File System Access API), the same for every
 * backend. Paths are relative to the folder: "a/b.txt". Works on the main thread and in workers.
 */

/** Splits a folder path into names; null if it could leave the folder (absolute, or ".."). */
export function folderPath(path: string): string[] | null {
  if (path.startsWith("/")) return null;
  const parts = path.split("/").filter(part => part && part !== ".");
  return parts.includes("..") ? null : parts;
}

/** Like folderPath, but throws for a path that could leave the folder. */
export function requireFolderPath(path: string): string[] {
  const parts = folderPath(path);
  if (parts === null) throw new Error(`Invalid path (outside the folder): ${path}`);
  return parts;
}

/** The directory at `parts` under `root`; `create` also creates missing directories. */
export async function getDirectory(root: FileSystemDirectoryHandle, parts: string[], create = false): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

/** The parent directory of a file path and the file's name; `create` creates missing parents. */
export async function getParent(
  root: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
  const parts = requireFolderPath(path);
  const name = parts.pop();
  if (!name) throw new Error(`Not a file path: "${path}"`);
  return { parent: await getDirectory(root, parts, create), name };
}

/** A file's contents (a File is a lazy, sliceable Blob). */
export async function getFile(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const { parent, name } = await getParent(root, path);
  return (await parent.getFileHandle(name)).getFile();
}

/** A file or directory handle; "" is the folder itself. */
export async function getEntry(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle | FileSystemDirectoryHandle> {
  if (requireFolderPath(path).length === 0) return root;
  const { parent, name } = await getParent(root, path);
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    // TypeMismatchError: the entry exists but is a directory.
    if (error instanceof DOMException && error.name === "TypeMismatchError") return parent.getDirectoryHandle(name);
    throw error;
  }
}

/**
 * Opens a file for writing, creating it and its directories, as `> file` (replaced on close) or,
 * with `append`, `>> file` (written after its current end).
 */
export async function openWritable(root: FileSystemDirectoryHandle, path: string, append: boolean): Promise<FileSystemWritableFileStream> {
  const { parent, name } = await getParent(root, path, true);
  const handle = await parent.getFileHandle(name, { create: true });
  const writer = await handle.createWritable({ keepExistingData: append });
  if (append) await writer.seek((await handle.getFile()).size);
  return writer;
}
