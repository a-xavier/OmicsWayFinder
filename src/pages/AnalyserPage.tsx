// Exploring OPFS + indexed DB workflow engine
import { useEffect, useState } from 'react'
import { _formatFileSize } from '../components/Dropzone'
import './AnalyserPage.css'

type OpfsEntry = {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  children?: OpfsEntry[]
}

async function readOpfsDirectory(directory: FileSystemDirectoryHandle, parentPath = ''): Promise<OpfsEntry[]> {
  const entries: OpfsEntry[] = []

  for await (const [name, handle] of directory.entries()) {
    const path = parentPath ? `${parentPath}/${name}` : name
    if (handle.kind === 'directory') {
      entries.push({
        name,
        path,
        kind: 'directory',
        children: await readOpfsDirectory(handle, path),
      })
    } else {
      const file = await handle.getFile()
      entries.push({ name, path, kind: 'file', size: file.size })
    }
  }

  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function OpfsTree({
  entries,
  disabled,
  onCreateFile,
  onCreateDirectory,
  onDelete,
}: {
  entries: OpfsEntry[]
  disabled: boolean
  onCreateFile: (path: string) => void
  onCreateDirectory: (path: string) => void
  onDelete: (path: string, kind: OpfsEntry['kind']) => void
}) {
  return (
    <ul className="opfs-tree">
      {entries.map(entry => (
        <li key={entry.name}>
          {entry.kind === 'directory' ? (
            <details>
              <summary>
                <span>{entry.name}</span>
                <span className="opfs-entry-kind">Folder</span>
              </summary>
              <div className="opfs-folder-actions">
                <button type="button" onClick={() => onCreateFile(entry.path)} disabled={disabled}>
                  Create 1 MiB file here
                </button>
                <button type="button" onClick={() => onCreateDirectory(entry.path)} disabled={disabled}>
                  Create subfolder
                </button>
                <button
                  className="opfs-delete-button"
                  type="button"
                  onClick={() => onDelete(entry.path, entry.kind)}
                  disabled={disabled}
                  aria-label={`Delete folder ${entry.path} and its contents`}
                >
                  Delete folder
                </button>
              </div>
              {entry.children?.length ? (
                <OpfsTree
                  entries={entry.children}
                  disabled={disabled}
                  onCreateFile={onCreateFile}
                  onCreateDirectory={onCreateDirectory}
                  onDelete={onDelete}
                />
              ) : (
                <p className="opfs-empty-folder">Empty folder</p>
              )}
            </details>
          ) : (
            <div className="opfs-file-entry">
              <span>{entry.name}</span>
              <span className="opfs-file-actions">
                <span className="opfs-file-size">{_formatFileSize(entry.size ?? 0)}</span>
                <button
                  className="opfs-delete-button"
                  type="button"
                  onClick={() => onDelete(entry.path, entry.kind)}
                  disabled={disabled}
                  aria-label={`Delete file ${entry.path}`}
                >
                  Delete
                </button>
              </span>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

export default function AnalyserPage() {
  const [storageRevision, setStorageRevision] = useState(0)
  const [storageBusy, setStorageBusy] = useState(false)

  function notifyStorageChanged() {
    setStorageRevision(revision => revision + 1)
  }

  return (
    <div className="app-page analyser-page">
      <h1>Analyser</h1>
      <p>This prototype explores browser storage for local workflow files.</p>
      <GetOPFSLimitsandFiles
        refreshKey={storageRevision}
        storageBusy={storageBusy}
        setStorageBusy={setStorageBusy}
        onStorageChange={notifyStorageChanged}
      />
      <ManipulateStorage
        refreshKey={storageRevision}
        storageBusy={storageBusy}
        setStorageBusy={setStorageBusy}
        onStorageChange={notifyStorageChanged}
      />
    </div>
  );
}

type StorageActionsProps = {
  refreshKey: number
  storageBusy: boolean
  setStorageBusy: (busy: boolean) => void
  onStorageChange: () => void
}

export function GetOPFSLimitsandFiles({
  refreshKey,
  storageBusy,
  setStorageBusy,
  onStorageChange,
}: StorageActionsProps) {
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const [requestingPersistence, setRequestingPersistence] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [persistenceMessage, setPersistenceMessage] = useState<string | null>(null)
  const [wipeMessage, setWipeMessage] = useState<string | null>(null)
  const [wipeError, setWipeError] = useState<string | null>(null)

  async function refreshStorageInfo() {
    setRefreshing(true)
    setEstimateError(null)

    try {
      const [storageEstimate, isPersistent] = await Promise.all([
        navigator.storage.estimate(),
        navigator.storage.persisted(),
      ])
      setEstimate(storageEstimate)
      setPersistent(isPersistent)
    } catch (error) {
      setEstimateError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void refreshStorageInfo()
  }, [refreshKey])

  async function requestPersistentStorage() {
    setRequestingPersistence(true)
    setPersistenceMessage(null)

    try {
      const granted = await navigator.storage.persist()
      setPersistent(granted)
      setPersistenceMessage(
        granted
          ? 'Persistent storage is enabled for this site.'
          : 'The browser did not grant persistent storage. Storage may still be cleared under browser policies.'
      )
    } catch (error) {
      setPersistenceMessage(
        `Could not request persistent storage: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setRequestingPersistence(false)
    }
  }

  async function wipeOpfs() {
    const confirmed = window.confirm(
      'Permanently delete every file and folder in this website’s OPFS storage? This cannot be undone. IndexedDB data will not be deleted.'
    )
    if (!confirmed) return

    setStorageBusy(true)
    setWipeError(null)
    setWipeMessage(null)

    try {
      const root = await navigator.storage.getDirectory()
      const entries: Array<{ name: string; kind: FileSystemHandle['kind'] }> = []
      for await (const [name, handle] of root.entries()) {
        entries.push({ name, kind: handle.kind })
      }

      for (const entry of entries) {
        if (entry.kind === 'directory') {
          await root.removeEntry(entry.name, { recursive: true })
        } else {
          await root.removeEntry(entry.name)
        }
      }

      setWipeMessage('All OPFS files and folders were deleted.')
      onStorageChange()
    } catch (cause) {
      setWipeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStorageBusy(false)
    }
  }

  return (
    <div>
      <div className="opfs-storage-heading">
        <h2>Browser storage</h2>
        <button type="button" onClick={() => void refreshStorageInfo()} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh storage info'}
        </button>
      </div>
      {estimateError ? (
        <p role="alert">Could not read storage estimate: {estimateError}</p>
      ) : (
        <>
          <p>Used: {estimate?.usage !== undefined ? _formatFileSize(estimate.usage) : 'Loading...'}</p>
          <p>Quota: {estimate?.quota !== undefined ? _formatFileSize(estimate.quota) : 'Loading...'}</p>
        </>
      )}
      <p>
        Persistent storage: {persistent === null ? 'Checking...' : persistent ? 'Granted' : 'Not granted'}
      </p>
      {!persistent && (
        <button type="button" onClick={requestPersistentStorage} disabled={requestingPersistence || storageBusy}>
          {requestingPersistence ? 'Requesting...' : 'Request persistent storage'}
        </button>
      )}
      {persistenceMessage && <p role="status">{persistenceMessage}</p>}
      <button
        className="opfs-danger-button"
        type="button"
        onClick={() => void wipeOpfs()}
        disabled={storageBusy || refreshing}
      >
        {storageBusy ? 'Deleting OPFS...' : 'Delete all OPFS data'}
      </button>
      {wipeError && <p className="opfs-error" role="alert">Could not clear OPFS: {wipeError}</p>}
      {wipeMessage && <p className="opfs-message" role="status">{wipeMessage}</p>}
    </div>
  )
}

export function ManipulateStorage({
  refreshKey,
  storageBusy,
  setStorageBusy,
  onStorageChange,
}: StorageActionsProps) {
  const [entries, setEntries] = useState<OpfsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function refreshDirectory() {
    setLoading(true)
    setError(null)

    try {
      const root = await navigator.storage.getDirectory()
      setEntries(await readOpfsDirectory(root))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshDirectory()
  }, [refreshKey])

  async function getTargetDirectory(path: string) {
    let directory = await navigator.storage.getDirectory()
    for (const segment of path.split('/').filter(Boolean)) {
      directory = await directory.getDirectoryHandle(segment)
    }
    return directory
  }

  async function findNextNumber(directory: FileSystemDirectoryHandle, pattern: RegExp) {
    let nextNumber = 1
    for await (const name of directory.keys()) {
      const match = pattern.exec(name)
      if (match) nextNumber = Math.max(nextNumber, Number(match[1]) + 1)
    }
    return nextNumber
  }

  async function createFile(directoryPath = '') {
    setCreating(true)
    setStorageBusy(true)
    setError(null)
    setMessage(null)

    try {
      const directory = await getTargetDirectory(directoryPath)
      const nextNumber = await findNextNumber(directory, /^omicswayfinder-(\d+)\.bin$/i)
      const name = `omicswayfinder-${String(nextNumber).padStart(4, '0')}.bin`
      const fileHandle = await directory.getFileHandle(name, { create: true })
      const writable = await fileHandle.createWritable()
      // Try 15 GB to get over quota and see what happens
      // IT FAILS in chrome
      // Cannot create more than 2GB
      await writable.write(new Uint8Array( 1024 * 1024 * 1024))
      await writable.close()
      setMessage(`Created ${directoryPath ? `${directoryPath}/` : ''}${name} (1 GiB).`)
      onStorageChange()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
      setStorageBusy(false)
    }
  }

  async function createDirectory(parentPath = '') {
    setCreating(true)
    setStorageBusy(true)
    setError(null)
    setMessage(null)

    try {
      const parent = await getTargetDirectory(parentPath)
      const nextNumber = await findNextNumber(parent, /^omicswayfinder-folder-(\d+)$/i)
      const name = `omicswayfinder-folder-${String(nextNumber).padStart(4, '0')}`
      await parent.getDirectoryHandle(name, { create: true })
      setMessage(`Created ${parentPath ? `${parentPath}/` : ''}${name}.`)
      onStorageChange()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
      setStorageBusy(false)
    }
  }

  async function deleteEntry(path: string, kind: OpfsEntry['kind']) {
    const label = kind === 'directory' ? 'folder and everything inside it' : 'file'
    if (!window.confirm(`Permanently delete this ${label}?\n\n${path}`)) return

    setCreating(true)
    setStorageBusy(true)
    setError(null)
    setMessage(null)

    try {
      const separator = path.lastIndexOf('/')
      const parentPath = separator === -1 ? '' : path.slice(0, separator)
      const name = separator === -1 ? path : path.slice(separator + 1)
      const parent = await getTargetDirectory(parentPath)

      if (kind === 'directory') {
        await parent.removeEntry(name, { recursive: true })
      } else {
        await parent.removeEntry(name)
      }

      setMessage(`Deleted ${path}.`)
      onStorageChange()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
      setStorageBusy(false)
    }
  }

  return (
    <section className="opfs-explorer" aria-labelledby="opfs-explorer-title">
      <div className="opfs-explorer__header">
        <div>
          <h2 id="opfs-explorer-title">Origin private file system</h2>
          <p>Create folders and 1 GiB test files in this site's private browser storage.</p>
        </div>
        <div className="opfs-explorer__actions">
          <button type="button" onClick={() => void refreshDirectory()} disabled={loading || creating || storageBusy}>
            Refresh
          </button>
          <button type="button" onClick={() => void createFile()} disabled={creating || loading || storageBusy}>
            Create 1 GiB file
          </button>
          <button type="button" onClick={() => void createDirectory()} disabled={creating || loading || storageBusy}>
            Create folder
          </button>
        </div>
      </div>

      {error && <p className="opfs-error" role="alert">Could not access OPFS: {error}</p>}
      {message && <p className="opfs-message" role="status">{message}</p>}
      {loading ? (
        <p role="status">Loading files...</p>
      ) : entries.length ? (
        <OpfsTree
          entries={entries}
          disabled={creating || storageBusy}
          onCreateFile={path => void createFile(path)}
          onCreateDirectory={path => void createDirectory(path)}
          onDelete={deleteEntry}
        />
      ) : (
        <p className="opfs-empty" role="status">No files or folders in this origin's OPFS yet.</p>
      )}
    </section>
  )
}

