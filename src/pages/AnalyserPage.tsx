import { useState } from 'react'
import initFileGenerator, { run_file_generator } from '../wasm/file_generator/pkg/file_generator.js'
import fileGeneratorWasmUrl from '../wasm/file_generator/pkg/file_generator_bg.wasm?url'
import MayoTester from '../components/MayoTester'
import './AnalyserPage.css'

type DirectoryPickerWindow = typeof window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

const fileSizes = [
  { label: '1 MiB', mebibytes: 1 },
  { label: '1 GiB', mebibytes: 1024 },
  { label: '10 GiB', mebibytes: 10 * 1024 },
] as const

let fileGeneratorReady: Promise<unknown> | undefined

async function initializeFileGenerator() {
  fileGeneratorReady ??= initFileGenerator(fileGeneratorWasmUrl)
  await fileGeneratorReady
}

export default function AnalyserPage() {
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null)
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const [generatingBytes, setGeneratingBytes] = useState<number | null>(null)
  const [writtenBytes, setWrittenBytes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function chooseDirectory() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker
    if (!picker) {
      setError('Directory selection is not supported in this browser. Try a current Chromium-based desktop browser.')
      return
    }

    setSelectingDirectory(true)
    setError(null)
    setMessage(null)

    try {
      const selectedDirectory = await picker.call(window, { mode: 'readwrite' })
      setDirectory(selectedDirectory)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSelectingDirectory(false)
    }
  }

  async function generateFile(sizeMebibytes: number) {
    if (!directory || generatingBytes !== null) return

    const totalBytes = sizeMebibytes * 1024 * 1024
    setGeneratingBytes(totalBytes)
    setWrittenBytes(0)
    setError(null)
    setMessage(null)

    let writable: FileSystemWritableFileStream | null = null
    const filename = `${crypto.randomUUID()}.bin`

    try {
      await initializeFileGenerator()
      const fileHandle = await directory.getFileHandle(filename, { create: true })
      writable = await fileHandle.createWritable()
      await run_file_generator(
        ['generate_file', String(sizeMebibytes)],
        writable,
        (bytes: number) => setWrittenBytes(bytes)
      )
      await writable.close()
      writable = null
      setMessage(`Created ${filename} (${fileSizes.find(size => size.mebibytes === sizeMebibytes)?.label ?? 'file'}).`)
    } catch (cause) {
      if (writable) {
        try {
          await writable.abort()
        } catch {
          // Preserve the original write error.
        }
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGeneratingBytes(null)
    }
  }

  const progress = generatingBytes === null ? 0 : Math.floor((writtenBytes / generatingBytes) * 100)

  return (
    <div className="app-page analyser-page">
      <h1>Analyser</h1>
      <p>Select a destination folder. Generated files are written directly to that folder by the browser.</p>

      <section className="directory-generator" aria-labelledby="directory-generator-title">
        <h2 id="directory-generator-title">Rust/WASM file generator</h2>
        <p className="directory-generator__note">
          The Rust/WASM program accepts <code>generate_file &lt;size_mib&gt;</code> and writes generated data in 8 MiB chunks.
          The browser supplies the selected folder's writable stream and a UUID filename. Large files can take time and may exceed available disk space.
        </p>

        <button
          className="directory-generator__pick"
          type="button"
          onClick={() => void chooseDirectory()}
          disabled={selectingDirectory || generatingBytes !== null}
        >
          {selectingDirectory ? 'Selecting folder...' : directory ? 'Choose a different folder' : 'Choose output folder'}
        </button>

        {directory && <p className="directory-generator__selected">Selected folder: <strong>{directory.name}</strong></p>}

        {directory && (
          <div className="directory-generator__sizes" aria-label="Choose generated file size">
            {fileSizes.map(size => (
              <button
                key={size.mebibytes}
                type="button"
                onClick={() => void generateFile(size.mebibytes)}
                disabled={generatingBytes !== null}
              >
                Create {size.label} file
              </button>
            ))}
          </div>
        )}

        {generatingBytes !== null && (
          <div className="directory-generator__progress" role="status" aria-live="polite">
            <label htmlFor="file-generation-progress">
              Writing {_formatBytes(writtenBytes)} of {_formatBytes(generatingBytes)} ({progress}%)
            </label>
            <progress id="file-generation-progress" max={generatingBytes} value={writtenBytes} />
          </div>
        )}

        {error && <p className="directory-generator__error" role="alert">Could not generate file: {error}</p>}
        {message && <p className="directory-generator__message" role="status">{message}</p>}
      </section>

      <MayoTester />
    </div>
  )
}

function _formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1)
  const value = bytes / 1000 ** index
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${units[index]}`
}
