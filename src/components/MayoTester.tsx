import { useEffect, useRef, useState } from 'react'
import { MAYO_CDN, Mayo, type MayoDirectory, type MayoEntry, type MayoToolInfo, type MayoToolSpec } from '../lib/execution_backend/emscripten/mayo'
import { folderPermission, forgetFolder, loadFolder, requestFolderPermission, saveFolder } from '../lib/execution_backend/emscripten/mayo-folder-store'
import { useLeaveGuard } from '../lib/useLeaveGuard'
import './MayoTester.css'

type DirectoryPickerWindow = typeof window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

type LogEntry = { id: number; time: string; action: string; ok: boolean; output: string; seconds?: number }

/** One entry of public/tools/manifest.json, written by scripts/fetch-biowasm-tools.mjs. */
type ManifestTool = { tool: string; version: string; programs: string[]; description: string }

const TOOLS_URL = `${import.meta.env.BASE_URL}tools`

/** Manual test harness: each button calls one Mayo method and logs its result or error. */
export default function MayoTester() {
  const mayoRef = useRef<Mayo | null>(null)
  const nextLogId = useRef(0)
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null)
  // A remembered folder that needs permission again (a click on "Reconnect").
  const [savedFolder, setSavedFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [remembered, setRemembered] = useState(false)
  const [path, setPath] = useState('mayo-test.txt')
  const [content, setContent] = useState('Hello from Mayo')
  const [manifest, setManifest] = useState<ManifestTool[]>([])
  const [manifestError, setManifestError] = useState('')
  const [toolFilter, setToolFilter] = useState('')
  // Selected programs as "<tool>/<program>".
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['samtools/samtools']))
  // Every program registered in the worker (as returned by loadTools).
  const [tools, setTools] = useState<MayoToolInfo[]>([])
  const loaded = new Set(tools.map(tool => `${tool.tool}/${tool.program}`))
  const [source, setSource] = useState<'local' | 'cdn'>('local')
  const [command, setCommand] = useState('samtools view /shared/samtools/examples/toy.sam')
  const [running, setRunning] = useState<{ action: string; start: number; exec: boolean } | null>(null)
  const [now, setNow] = useState(() => performance.now())
  const busy = running !== null
  // Closing or reloading the tab terminates the Mayo worker and kills the program mid-run.
  useLeaveGuard(running?.exec ?? false)
  const [log, setLog] = useState<LogEntry[]>([])

  useEffect(() => {
    fetch(`${TOOLS_URL}/manifest.json`)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<ManifestTool[]>
      })
      .then(setManifest)
      .catch((cause: unknown) => setManifestError(`Could not load the tool list: ${String(cause)}`))
  }, [])

  // Reopen the folder from the last visit. Without a stored "Allow on every visit" grant,
  // permission is "prompt" and needs a click, so show a Reconnect button instead.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const handle = await loadFolder()
        if (cancelled || !handle) return
        setRemembered(true)
        if ((await folderPermission(handle)) !== 'granted') {
          if (!cancelled) setSavedFolder(handle)
          return
        }
        if (cancelled) return
        setDirectory(handle)
        await run(`init (remembered "${handle.name}")`, () => initFolder(handle))
      } catch (cause) {
        if (!cancelled) addLog('Restore folder', false, cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Tick the elapsed time while an operation runs. The work happens in workers, so the page stays responsive.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(performance.now()), 100)
    return () => clearInterval(timer)
  }, [running])

  // Terminate the worker on unmount. App keeps the Analyser mounted across page changes, so this
  // only happens when the app itself goes away (or in StrictMode's test unmount).
  useEffect(() => () => {
    mayoRef.current?.close()
    mayoRef.current = null
  }, [])

  // A closed instance rejects every request, so create a fresh one on demand.
  function getMayo() {
    mayoRef.current ??= new Mayo()
    return mayoRef.current
  }

  function addLog(action: string, ok: boolean, output: string, seconds?: number) {
    const entry = { id: nextLogId.current++, time: new Date().toLocaleTimeString(), action, ok, output, seconds }
    setLog(previous => [entry, ...previous])
  }

  /** The operation returns its output, or `{ output, ok: false }` for a run that completed but failed (non-zero exit code). */
  async function run(action: string, operation: () => Promise<string | { output: string; ok: boolean }>, exec = false) {
    const start = performance.now()
    setNow(start)
    setRunning({ action, start, exec })
    const seconds = () => (performance.now() - start) / 1000
    try {
      const result = await operation()
      if (typeof result === 'string') addLog(action, true, result, seconds())
      else addLog(action, result.ok, result.output, seconds())
    } catch (cause) {
      addLog(action, false, cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause), seconds())
    } finally {
      setRunning(null)
    }
  }

  async function initFolder(handle: FileSystemDirectoryHandle): Promise<string> {
    try {
      return formatTree(await getMayo().init(handle))
    } catch (cause) {
      // The remembered folder was deleted or moved.
      if (cause instanceof Error && cause.name === 'NotFoundError') {
        await forgetFolder()
        setRemembered(false)
        setDirectory(null)
      }
      throw cause
    }
  }

  async function reconnect() {
    if (!savedFolder) return
    const handle = savedFolder
    // requestPermission must run first in the click, before any other await.
    const granted = await requestFolderPermission(handle).catch(() => false)
    if (!granted) {
      addLog('Reconnect', false, `Permission for "${handle.name}" was not granted.`)
      return
    }
    setSavedFolder(null)
    setDirectory(handle)
    await run(`init (reconnected "${handle.name}")`, () => initFolder(handle))
  }

  async function forget() {
    try {
      await forgetFolder()
      setSavedFolder(null)
      setRemembered(false)
      addLog('Forget folder', true, 'The folder will not be reopened on the next visit. The current session keeps using it.')
    } catch (cause) {
      addLog('Forget folder', false, cause instanceof Error ? cause.message : String(cause))
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
      setSavedFolder(null)
      let saved = ''
      try {
        await saveFolder(selected)
        setRemembered(true)
        saved = ' It will be reopened on the next visit.'
      } catch (cause) {
        saved = ` It could not be remembered: ${cause instanceof Error ? cause.message : String(cause)}`
      }
      addLog('Choose folder', true, `Selected "${selected.name}".${saved}`)
      await run(`init "${selected.name}"`, () => initFolder(selected))
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      addLog('Choose folder', false, cause instanceof Error ? cause.message : String(cause))
    }
  }

  function closeMayo() {
    mayoRef.current?.close()
    mayoRef.current = null
    setTools([])
    addLog('close', true, 'Worker terminated. The next action starts a new, uninitialized worker.')
  }

  function toggle(keys: string[], on: boolean) {
    setSelected(previous => {
      const next = new Set(previous)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }

  // Selected programs that are not loaded yet; the rest are skipped.
  const toLoad = [...selected].filter(key => !loaded.has(key))

  function loadSelected() {
    const skipped = [...selected].filter(key => loaded.has(key))
    const specs: MayoToolSpec[] = manifest.flatMap(entry => entry.programs
      .filter(program => toLoad.includes(`${entry.tool}/${program}`))
      .map(program => ({
        tool: entry.tool,
        program,
        version: entry.version,
        urlPrefix: source === 'local' ? `${TOOLS_URL}/${entry.tool}/${entry.version}` : undefined,
      })))
    if (specs.length === 0) return
    void run(`loadTools ${toLoad.join(' ')} (${source})`, async () => {
      const result = await getMayo().loadTools(specs)
      setTools(result)
      return `${skipped.length > 0 ? `Skipped (already loaded): ${skipped.join(', ')}\n` : ''}${formatTools(result)}`
    })
  }

  const filter = toolFilter.trim().toLowerCase()
  const visibleTools = manifest.filter(entry => !filter
    || entry.tool.toLowerCase().includes(filter)
    || entry.description.toLowerCase().includes(filter)
    || entry.programs.some(program => program.toLowerCase().includes(filter)))

  return (
    <section className="mayo-tester" aria-labelledby="mayo-tester-title">
      <header className="mayo-tester__header">
        <h2 id="mayo-tester-title">Mayo test bench</h2>
        <p className="mayo-tester__note">
          Runs biowasm tools in a worker, directly on a folder of your computer. Tools work in that folder
          (<code>/shared/data</code>), so relative paths read and write your files:
          {' '}<code>samtools index reads.bam</code> creates <code>reads.bam.bai</code> next to it.
        </p>
        <p className={`mayo-tester__isolation ${crossOriginIsolated ? 'is-ok' : 'is-error'}`} role="status">
          Cross-origin isolated: <strong>{crossOriginIsolated ? 'yes' : 'no'}</strong>
          {!crossOriginIsolated && ' (synchronous file access is unavailable; serve the page with COOP/COEP headers)'}
        </p>
      </header>

      <section className="mayo-tester__panel" aria-labelledby="mayo-folder-title">
        <h3 id="mayo-folder-title">Folder</h3>
        <p className="mayo-tester__selected">
          {directory
            ? <>Working in <strong>{directory.name}</strong>{remembered && ' (reopened on your next visit)'}</>
            : savedFolder
              ? <>Last folder: <strong>{savedFolder.name}</strong>. The browser needs your permission again.</>
              : 'Choose the folder that holds your data. Outputs are written there too.'}
        </p>
        <div className="mayo-tester__row">
          {savedFolder && (
            <button type="button" className="mayo-tester__primary" onClick={() => void reconnect()} disabled={busy}>
              Reconnect to {savedFolder.name}
            </button>
          )}
          <button
            type="button"
            className={directory || savedFolder ? undefined : 'mayo-tester__primary'}
            onClick={() => void chooseDirectory()}
            disabled={busy}
          >
            {directory || savedFolder ? 'Choose a different folder' : 'Choose folder'}
          </button>
          {remembered && (
            <button type="button" className="mayo-tester__quiet" onClick={() => void forget()} disabled={busy}>
              Forget folder
            </button>
          )}
        </div>
        {directory && (
          <div className="mayo-tester__row" role="group" aria-label="Folder operations">
            <button type="button" disabled={busy} onClick={() => void run('init', () => initFolder(directory))}>
              init
            </button>
            <button type="button" disabled={busy} onClick={() => void run('getTree', async () => formatTree(await getMayo().getTree()))}>
              getTree
            </button>
            <button type="button" disabled={busy} onClick={() => void run('refreshTree', async () => formatTree(await getMayo().refreshTree()))}>
              refreshTree
            </button>
          </div>
        )}
      </section>

      {directory && (
        <>
          <section className="mayo-tester__panel" aria-labelledby="mayo-files-title">
            <h3 id="mayo-files-title">Files</h3>
            <p className="mayo-tester__hint">
              Paths are relative to the folder and go through the synchronous I/O worker. writeFile replaces the whole
              file and parent folders must exist; removeFile only removes files.
            </p>
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
          </section>

          <section className="mayo-tester__panel" aria-labelledby="mayo-tools-title">
            <h3 id="mayo-tools-title">Tools</h3>
            <p className="mayo-tester__hint">
              Tick the programs you need and load them; load more at any time. The first program loaded owns the
              shared <code>/shared</code> folder. Local copies live in <code>public/tools</code>
              (<code>npm run fetch:tools</code> updates them).
            </p>
            <div className="mayo-tester__fields">
              <label>
                Filter tools
                <input value={toolFilter} placeholder="e.g. vcf, align, bcftools" onChange={event => setToolFilter(event.target.value)} />
              </label>
              <label>
                Load from
                <select value={source} onChange={event => setSource(event.target.value as 'local' | 'cdn')}>
                  <option value="local">This site (public/tools)</option>
                  <option value="cdn">biowasm CDN</option>
                </select>
              </label>
            </div>

            {manifestError && <p className="mayo-tester__isolation is-error">{manifestError}</p>}
            <fieldset className="mayo-tester__tools">
              <legend className="mayo-tester__visually-hidden">Tools to load</legend>
              {visibleTools.length === 0 && <p className="mayo-tester__empty">No tool matches “{toolFilter}”.</p>}
              {visibleTools.map(entry => {
                const keys = entry.programs.map(program => `${entry.tool}/${program}`)
                const count = keys.filter(key => selected.has(key)).length
                return (
                  <div key={entry.tool} className="mayo-tester__tool">
                    <label className="mayo-tester__tool-name" title={entry.description}>
                      <input
                        type="checkbox"
                        checked={count === keys.length}
                        ref={element => { if (element) element.indeterminate = count > 0 && count < keys.length }}
                        onChange={event => toggle(keys, event.target.checked)}
                      />
                      <strong>{entry.tool}</strong> <span>{entry.version}</span>
                      {entry.programs.length === 1 && loaded.has(keys[0]) && <em>loaded</em>}
                    </label>
                    {entry.programs.length > 1 && (
                      <span className="mayo-tester__programs">
                        {entry.programs.map((program, index) => (
                          <label key={program}>
                            <input type="checkbox" checked={selected.has(keys[index])} onChange={event => toggle([keys[index]], event.target.checked)} />
                            {program}
                            {loaded.has(keys[index]) && <em>loaded</em>}
                          </label>
                        ))}
                      </span>
                    )}
                    <span className="mayo-tester__description">{entry.description}</span>
                  </div>
                )
              })}
            </fieldset>
            <div className="mayo-tester__row">
              <button
                type="button"
                className="mayo-tester__primary"
                disabled={busy || toLoad.length === 0}
                onClick={loadSelected}
              >
                {toLoad.length === 0
                  ? selected.size === 0 ? 'Select programs to load' : 'Selected programs are loaded'
                  : `Load ${toLoad.length} program${toLoad.length === 1 ? '' : 's'}`}
              </button>
              {selected.size > toLoad.length && toLoad.length > 0 && (
                <span className="mayo-tester__hint">{selected.size - toLoad.length} already loaded, skipped</span>
              )}
            </div>

            <div className="mayo-tester__loaded">
              <h4>Loaded ({tools.length})</h4>
              {tools.length === 0 ? (
                <p className="mayo-tester__hint">No tools loaded yet.</p>
              ) : (
                <ul>
                  {tools.map(tool => (
                    <li key={tool.program} title={tool.urlPrefix}>
                      <strong>{tool.program}</strong>
                      <span>{tool.tool} {tool.version}</span>
                      <span>{tool.urlPrefix.startsWith(MAYO_CDN) ? 'CDN' : 'local'}</span>
                      {tool.base && <em>base</em>}
                      {!tool.loaded && <span>lazy</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="mayo-tester__panel" aria-labelledby="mayo-run-title">
            <h3 id="mayo-run-title">Run</h3>
            <p className="mayo-tester__hint">
              One loaded program per command. <code>&gt;</code>, <code>&gt;&gt;</code> and <code>2&gt;</code> write
              to files in the folder; pipes and <code>&amp;&amp;</code> are not supported yet.
            </p>
            <form
              className="mayo-tester__command"
              onSubmit={event => {
                event.preventDefault()
                if (busy) return
                void run(`exec ${command}`, async () => {
                  const result = await getMayo().exec(command)
                  return {
                    ok: result.exitCode === 0,
                    output: `exit code ${result.exitCode}\n--- stdout ---\n${result.stdout.slice(0, 4000)}--- stderr ---\n${result.stderr.slice(0, 4000)}`,
                  }
                }, true)
              }}
            >
              <label>
                Command
                <input value={command} spellCheck={false} onChange={event => setCommand(event.target.value)} />
              </label>
              <button type="submit" className="mayo-tester__primary" disabled={busy}>
                exec
              </button>
              <button
                type="button"
                className="mayo-tester__quiet"
                onClick={closeMayo}
                title="Terminates the worker; also stops a running command"
              >
                {busy ? 'Stop (close worker)' : 'close worker'}
              </button>
            </form>
          </section>

          <div className={`mayo-tester__status ${running ? 'is-running' : ''}`} role="status" aria-live="polite">
            {running ? (
              <>
                <span className="mayo-tester__spinner" aria-hidden="true" />
                <span title={running.action}>
                  Running <code>{running.action}</code>
                </span>
                <span className="mayo-tester__elapsed">{formatSeconds((now - running.start) / 1000)}</span>
              </>
            ) : (
              <span title={log[0]?.action}>Idle{log[0] ? ` — last: ${log[0].action} (${log[0].ok ? 'ok' : 'failed'}${log[0].seconds === undefined ? '' : `, ${formatSeconds(log[0].seconds)}`})` : ''}</span>
            )}
          </div>
        </>
      )}

      {(directory || log.length > 0) && (
        <section className="mayo-tester__panel" aria-labelledby="mayo-output-title">
          <div className="mayo-tester__output-header">
            <h3 id="mayo-output-title">Output</h3>
            <button type="button" className="mayo-tester__quiet" onClick={() => setLog([])} disabled={log.length === 0}>Clear</button>
          </div>
          <ol className="mayo-tester__output" aria-live="polite">
            {log.length === 0 && <li className="mayo-tester__empty">No output yet.</li>}
            {log.map(entry => (
              <li key={entry.id} className={entry.ok ? 'is-ok' : 'is-error'}>
                <span className="mayo-tester__meta">[{entry.time}] {entry.ok ? '✓' : '✗'} {entry.action}{entry.seconds === undefined ? '' : ` (${formatSeconds(entry.seconds)})`}</span>
                <pre>{entry.output}</pre>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  )
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  return `${Math.floor(seconds / 60)} min ${(seconds % 60).toFixed(0).padStart(2, '0')} s`
}

function formatTools(tools: MayoToolInfo[]): string {
  return tools
    .map(tool => `${tool.tool}/${tool.program}/${tool.version}${tool.base ? ' (base)' : ''} ${tool.loaded ? 'loaded' : 'lazy, not loaded'}\n  ${tool.urlPrefix}`)
    .join('\n')
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
