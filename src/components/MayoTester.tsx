import { useEffect, useRef, useState } from 'react'
import { Mayo, type MayoDirectory, type MayoEntry } from '../lib/execution_backend/emscripten/mayo'
import './MayoTester.css'

type DirectoryPickerWindow = typeof window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

type LogEntry = { id: number; time: string; action: string; ok: boolean; output: string }

/** Manual test harness: each button calls one Mayo method and logs its result or error. */
export default function MayoTester() {
  const mayoRef = useRef<Mayo | null>(null)
  const nextLogId = useRef(0)
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null)
  const [path, setPath] = useState('mayo-test.txt')
  const [content, setContent] = useState('Hello from Mayo')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])

  // Terminate the worker when leaving the page.
  useEffect(() => () => {
    mayoRef.current?.close()
    mayoRef.current = null
  }, [])

  // A closed instance rejects every request, so create a fresh one on demand.
  function getMayo() {
    mayoRef.current ??= new Mayo()
    return mayoRef.current
  }

  function addLog(action: string, ok: boolean, output: string) {
    const entry = { id: nextLogId.current++, time: new Date().toLocaleTimeString(), action, ok, output }
    setLog(previous => [entry, ...previous])
  }

  async function run(action: string, operation: () => Promise<string>) {
    setBusy(true)
    try {
      addLog(action, true, await operation())
    } catch (cause) {
      addLog(action, false, cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function chooseDirectory() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker
    if (!picker) {
      addLog('Choose folder', false, 'Directory selection is not supported in this browser.')
      return
    }
    try {
      const selected = await picker.call(window, { mode: 'readwrite' })
      setDirectory(selected)
      addLog('Choose folder', true, `Selected "${selected.name}". Click "init" to send it to the worker.`)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      addLog('Choose folder', false, cause instanceof Error ? cause.message : String(cause))
    }
  }

  function closeMayo() {
    mayoRef.current?.close()
    mayoRef.current = null
    addLog('close', true, 'Worker terminated. The next action starts a new, uninitialized worker.')
  }

  return (
    <section className="mayo-tester" aria-labelledby="mayo-tester-title">
      <h2 id="mayo-tester-title">Mayo test bench</h2>
      <p className="mayo-tester__note">
        Calls each Mayo method in its worker and prints the result. readFile reads synchronously through a second I/O worker; write and remove are still placeholders.
      </p>
      <p className={`mayo-tester__isolation ${crossOriginIsolated ? 'is-ok' : 'is-error'}`} role="status">
        Cross-origin isolated: <strong>{crossOriginIsolated ? 'yes' : 'no'}</strong>
        {!crossOriginIsolated && ' (synchronous file access is unavailable; serve the page with COOP/COEP headers)'}
      </p>

      <div className="mayo-tester__row">
        <button type="button" onClick={() => void chooseDirectory()} disabled={busy}>
          {directory ? 'Choose a different folder' : 'Choose folder'}
        </button>
        <span className="mayo-tester__selected">
          {directory ? <>Selected folder: <strong>{directory.name}</strong></> : 'No folder selected'}
        </span>
      </div>

      <div className="mayo-tester__row" role="group" aria-label="Tree operations">
        <button
          type="button"
          disabled={busy || !directory}
          onClick={() => directory && void run('init', async () => formatTree(await getMayo().init(directory)))}
        >
          init
        </button>
        <button type="button" disabled={busy} onClick={() => void run('getTree', async () => formatTree(await getMayo().getTree()))}>
          getTree
        </button>
        <button type="button" disabled={busy} onClick={() => void run('refreshTree', async () => formatTree(await getMayo().refreshTree()))}>
          refreshTree
        </button>
        <button type="button" disabled={busy} onClick={closeMayo}>
          close
        </button>
      </div>

      <div className="mayo-tester__fields">
        <label>
          Path
          <input value={path} onChange={event => setPath(event.target.value)} />
        </label>
        <label>
          Content to write
          <input value={content} onChange={event => setContent(event.target.value)} />
        </label>
      </div>

      <div className="mayo-tester__row" role="group" aria-label="File operations">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(`readFile ${path}`, async () => {
            const data = await getMayo().readFile(path)
            return `${data.byteLength} bytes\n${new TextDecoder().decode(data.subarray(0, 2000))}`
          })}
        >
          readFile
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(`writeFile ${path}`, async () => {
            const data = new TextEncoder().encode(content)
            await getMayo().writeFile(path, data)
            return `Wrote ${data.byteLength} bytes.`
          })}
        >
          writeFile
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(`removeFile ${path}`, async () => {
            await getMayo().removeFile(path)
            return 'Removed.'
          })}
        >
          removeFile
        </button>
      </div>

      <div className="mayo-tester__output-header">
        <h3>Output</h3>
        <button type="button" onClick={() => setLog([])} disabled={log.length === 0}>Clear</button>
      </div>
      <ol className="mayo-tester__output" aria-live="polite">
        {log.length === 0 && <li className="mayo-tester__empty">No output yet.</li>}
        {log.map(entry => (
          <li key={entry.id} className={entry.ok ? 'is-ok' : 'is-error'}>
            <span className="mayo-tester__meta">[{entry.time}] {entry.ok ? '✓' : '✗'} {entry.action}</span>
            <pre>{entry.output}</pre>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Render the snapshot like the `tree` command so nesting is easy to read. */
function formatTree(tree: MayoDirectory): string {
  const lines = [`${tree.name}/`]
  const walk = (entries: readonly MayoEntry[], prefix: string) => {
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1
      lines.push(`${prefix}${last ? '└── ' : '├── '}${entry.name}${entry.kind === 'directory' ? '/' : ''}`)
      if (entry.kind === 'directory') walk(entry.children, prefix + (last ? '    ' : '│   '))
    })
  }
  walk(tree.children, '')
  return lines.join('\n')
}
