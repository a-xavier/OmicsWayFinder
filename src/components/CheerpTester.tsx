import { useEffect, useRef, useState } from 'react'
import { folderPermission, loadFolder, pickFolder, requestFolderPermission, saveFolder } from '../lib/execution_backend/shared/folder-store'
import { initCheerpJ, javaFolderTree, JAVA_TOOLS, runJarCommand, runPublicToolCommand, type JavaRunResult } from '../lib/execution_backend/java/cheerpj'
// Same look as the Mayo tester: reuse its classes rather than a copy of its stylesheet.
import './MayoTester.css'

type LogEntry = { id: number; time: string; action: string; ok: boolean; output: string; seconds?: number }

/** Manual test harness for the CheerpJ (Java) backend. */
export default function CheerpTester() {
  const nextLogId = useRef(0)
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null)
  const [savedFolder, setSavedFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [treePath, setTreePath] = useState('')
  const [toolCommand, setToolCommand] = useState('gatk --help')
  const [jarCommand, setJarCommand] = useState('VarScan.jar mpileup2snp pileup.pileup --output-vcf 1 > snps.vcf')
  const [running, setRunning] = useState<{ action: string; start: number } | null>(null)
  const [live, setLive] = useState('')
  const [log, setLog] = useState<LogEntry[]>([])
  const busy = running !== null

  // The remembered folder is shared with the Mayo tester (same IndexedDB entry).
  useEffect(() => {
    let cancelled = false
    void loadFolder().then(async handle => {
      if (cancelled || !handle) return
      if ((await folderPermission(handle)) === 'granted') setDirectory(handle)
      else setSavedFolder(handle)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  function addLog(action: string, ok: boolean, output: string, seconds?: number) {
    const entry = { id: nextLogId.current++, time: new Date().toLocaleTimeString(), action, ok, output, seconds }
    setLog(previous => [entry, ...previous])
  }

  async function run(action: string, operation: () => Promise<string | JavaRunResult>) {
    const start = performance.now()
    setRunning({ action, start })
    setLive('')
    try {
      const result = await operation()
      const seconds = (performance.now() - start) / 1000
      if (typeof result === 'string') addLog(action, true, result, seconds)
      else addLog(action, result.exitCode === 0, formatRun(result), seconds)
    } catch (cause) {
      addLog(action, false, cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause), (performance.now() - start) / 1000)
    } finally {
      setRunning(null)
    }
  }

  const onOutput = (_fd: 1 | 2, text: string) => setLive(previous => (previous + text).slice(-4000))

  async function chooseDirectory() {
    try {
      const selected = await pickFolder()
      if (!selected) return
      setDirectory(selected)
      setSavedFolder(null)
      await saveFolder(selected).catch(() => undefined)
      addLog('Choose folder', true, `Selected "${selected.name}".`)
    } catch (cause) {
      addLog('Choose folder', false, cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function reconnect() {
    if (!savedFolder) return
    if (!(await requestFolderPermission(savedFolder).catch(() => false))) {
      addLog('Reconnect', false, `Permission for "${savedFolder.name}" was not granted.`)
      return
    }
    setDirectory(savedFolder)
    setSavedFolder(null)
  }

  return (
    <section className="mayo-tester cheerp-tester" aria-labelledby="cheerp-tester-title">
      <div className="mayo-tester__header">
        <h2 id="cheerp-tester-title">CheerpJ tester (Java)</h2>
        <p className="mayo-tester__note">
          Runs Java in the page with <a href="https://cheerpj.com/" target="_blank" rel="noopener noreferrer">CheerpJ</a> (Java 21).
          The JVM runs on the page's main thread and reaches the selected folder through native methods implemented in
          JavaScript. CheerpJ is free for non-commercial use only.
        </p>
      </div>

      <section className="mayo-tester__panel" aria-labelledby="cheerp-folder-title">
        <h3 id="cheerp-folder-title">Folder</h3>
        <p className="mayo-tester__selected">
          {directory ? <>Selected: <strong>{directory.name}</strong></> : savedFolder ? <>Remembered: <strong>{savedFolder.name}</strong> (needs permission)</> : 'No folder selected.'}
        </p>
        <div className="mayo-tester__row">
          <button type="button" className="mayo-tester__primary" onClick={() => void chooseDirectory()} disabled={busy}>
            Choose folder
          </button>
          {savedFolder && <button type="button" onClick={() => void reconnect()} disabled={busy}>Reconnect</button>}
          <button type="button" onClick={() => void run('Start JVM', async () => { await initCheerpJ(); return 'CheerpJ is ready (Java 21).' })} disabled={busy}>
            Start JVM
          </button>
        </div>
      </section>

      {directory && (
        <>
          <section className="mayo-tester__panel" aria-labelledby="cheerp-tree-title">
            <h3 id="cheerp-tree-title">1. Folder tree from Java</h3>
            <p className="mayo-tester__hint">
              <code>omics.cheerp.FolderTree</code> walks the folder by calling a native <code>list(path)</code> that
              JavaScript answers from the folder handle.
            </p>
            <form
              className="mayo-tester__command"
              onSubmit={event => {
                event.preventDefault()
                if (!busy) void run(`tree ${treePath || '.'}`, () => javaFolderTree(directory, treePath.trim(), onOutput))
              }}
            >
              <label>
                Path inside the folder (empty for the whole folder)
                <input value={treePath} placeholder="subfolder" spellCheck={false} onChange={event => setTreePath(event.target.value)} />
              </label>
              <button type="submit" className="mayo-tester__primary" disabled={busy}>Print tree</button>
            </form>
          </section>

          <section className="mayo-tester__panel" aria-labelledby="cheerp-tool-title">
            <h3 id="cheerp-tool-title">2. Run a bundled Java tool</h3>
            <p className="mayo-tester__hint">
              Available: {JAVA_TOOLS.map(tool => `${tool.name} ${tool.version}`).join(', ')}.
              The jar is loaded from the website; input files, output files and redirections use the selected folder.
              Files named in the arguments and their indexes are copied into CheerpJ before the run.
              Pipes are not supported.
            </p>
            <p className="mayo-tester__hint">
              SnpEff can download databases and report usage by default; use <code>-nodownload -noLog</code> to disable both.
            </p>
            <form
              className="mayo-tester__command"
              onSubmit={event => {
                event.preventDefault()
                if (!busy && toolCommand.trim()) void run(toolCommand.trim(), () => runPublicToolCommand(directory, toolCommand, onOutput))
              }}
            >
              <label>
                Bundled tool command
                <input value={toolCommand} spellCheck={false} onChange={event => setToolCommand(event.target.value)} />
              </label>
              <button type="submit" className="mayo-tester__primary" disabled={busy || !toolCommand.trim()}>Run tool</button>
            </form>
          </section>

          <section className="mayo-tester__panel" aria-labelledby="cheerp-jar-title">
            <h3 id="cheerp-jar-title">3. Run a jar from the folder</h3>
            <p className="mayo-tester__hint">
              <code>&lt;jar&gt; args…</code> runs the jar from the folder like <code>java -jar</code>, with the folder
              as its working directory. Files named in the arguments (and index files next to them, such
              as <code>.bai</code> or <code>.fai</code>; directories whole; <code>.</code> for everything) are copied
              into CheerpJ's <code>/files/</code> first; new and changed files are copied back afterwards.
              <code>&lt;</code>, <code>&gt;</code>, <code>&gt;&gt;</code>, <code>2&gt;</code> and <code>2&gt;&gt;</code> use
              files in the folder, as in Mayo; pipes are not supported yet. A tool appending to an existing file
              itself does not work (a CheerpJ bug: it writes at the start); <code>&gt;&gt;</code> does.
            </p>
            <form
              className="mayo-tester__command"
              onSubmit={event => {
                event.preventDefault()
                if (!busy && jarCommand.trim()) void run(`java -jar ${jarCommand.trim()}`, () => runJarCommand(directory, jarCommand, onOutput))
              }}
            >
              <label>
                Command
                <input value={jarCommand} spellCheck={false} onChange={event => setJarCommand(event.target.value)} />
              </label>
              <button type="submit" className="mayo-tester__primary" disabled={busy || !jarCommand.trim()}>Run jar</button>
            </form>
          </section>
        </>
      )}

      <div className={`mayo-tester__status ${running ? 'is-running' : ''}`} role="status" aria-live="polite">
        {running ? (
          <>
            <span className="mayo-tester__spinner" aria-hidden="true" />
            <span title={running.action}>Running <code>{running.action}</code></span>
          </>
        ) : (
          <span>Idle</span>
        )}
      </div>
      {running && live && <pre className="mayo-tester__live" aria-label="output so far">{live}</pre>}

      {log.length > 0 && (
        <section className="mayo-tester__panel" aria-labelledby="cheerp-output-title">
          <div className="mayo-tester__output-header">
            <h3 id="cheerp-output-title">Output</h3>
            <button type="button" className="mayo-tester__quiet" onClick={() => setLog([])}>Clear</button>
          </div>
          <ol className="mayo-tester__output" aria-live="polite">
            {log.map(entry => (
              <li key={entry.id} className={entry.ok ? 'is-ok' : 'is-error'}>
                <span className="mayo-tester__meta">
                  [{entry.time}] {entry.ok ? '✓' : '✗'} {entry.action}{entry.seconds === undefined ? '' : ` (${entry.seconds.toFixed(1)} s)`}
                </span>
                <pre>{entry.output}</pre>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  )
}

function formatRun(result: JavaRunResult): string {
  const files = (label: string, paths: string[]) => paths.length ? `\n${label}: ${paths.join(', ')}` : ''
  return `exit code ${result.exitCode}${files('copied in', result.inputs)}${files('written to the folder', result.written)}\n--- stdout ---\n${result.stdout.slice(0, 8000)}--- stderr ---\n${result.stderr.slice(0, 8000)}`
}
