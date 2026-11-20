import MayoTester from '../components/MayoTester'
import './AnalyserPage.css'

export default function AnalyserPage() {
  return (
    <div className="app-page analyser-page">
      <h1>Analyser</h1>

      <p> This page tests the Mayo module</p>
      <a href="https://github.com/biowasm/aioli" target="_blank" rel="noopener noreferrer">Based on aioli</a>
      <p>Ideally we could reuse biowasm pre compiled tools</p>
      <p>The idea is:</p>
      <ol>
        <li>User selects a folder from their own computer</li>
        <li>Mayo mount the selected folder to make it accessible for processing as a filesystem</li>
        <li>The application can then perform operations on the mounted folder using Mayo</li>
      </ol>

      <p>It allows:</p>
      <ul>
        <li>Processing files directly from the user's filesystem</li>
        <li>Handling files larger than the available RAM</li>
        <li>Creating resumable pipelines for long-running tasks</li>
      </ul>

      <MayoTester />
    </div>
  )
}

