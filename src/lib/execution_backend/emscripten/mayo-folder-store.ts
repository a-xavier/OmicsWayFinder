/**
 * Remembers the folder the user selected, so it can be reopened on the next visit without the
 * folder picker. Directory handles cannot go in localStorage or sessionStorage (strings only),
 * but IndexedDB stores them as they are. Only the handle is stored, never file contents.
 *
 * The permission is not stored with the handle: on a new page load it is usually "prompt", and
 * requestPermission() only works during a user gesture (a click). Chrome can offer "Allow on
 * every visit", in which case it is already "granted" on load.
 */

const DB_NAME = "mayo";
const STORE = "handles";
const KEY = "folder";

type PermissionMode = { mode: "read" | "readwrite" };
/** queryPermission/requestPermission are not in TypeScript's DOM types yet. */
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options: PermissionMode): Promise<PermissionState>;
  requestPermission(options: PermissionMode): Promise<PermissionState>;
};

const READ_WRITE: PermissionMode = { mode: "readwrite" };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    db.close();
  }
}

/** Remember the selected folder for the next visit. */
export async function saveFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore("readwrite", store => store.put(handle, KEY));
}

/** The remembered folder, or undefined if none was saved. */
export async function loadFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  const handle = await withStore<unknown>("readonly", store => store.get(KEY));
  return handle instanceof FileSystemDirectoryHandle ? handle : undefined;
}

/** Forget the remembered folder. */
export async function forgetFolder(): Promise<void> {
  await withStore("readwrite", store => store.delete(KEY));
}

/** Current read-write permission, without prompting. */
export function folderPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return (handle as PermissionHandle).queryPermission(READ_WRITE);
}

/** Ask for read-write permission again. Must be called from a click (or other user gesture). */
export async function requestFolderPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permission = handle as PermissionHandle;
  if ((await permission.queryPermission(READ_WRITE)) === "granted") return true;
  return (await permission.requestPermission(READ_WRITE)) === "granted";
}
