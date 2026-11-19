import { useEffect, useRef, useState } from 'react'
import FileValidatorPage from './pages/FileValidatorPage'
import HomePage from './pages/HomePage'
import AccessibilityPage from './pages/AccessibilityPage'
import AnalyserPage from './pages/AnalyserPage'
import ContractPage from './pages/ContractPage'
import './App.css'

const pages = [
  { id: 'home', label: 'Home' },
  { id: 'about', label: 'About' },
  { id: 'filevalidator', label: 'FileValidator' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'analyser', label: 'Analyser' },
  { id: 'accessibility', label: 'Accessibility' },
] as const

type Page = typeof pages[number]['id'] | 'not-found'

function getPage(): Page {
  const path = window.location.hash.slice(1) || '/home'
  return pages.find(page => `/${page.id}` === path)?.id ?? 'not-found'
}

function App() {
  const [page, setPage] = useState<Page>(getPage)
  const mainRef = useRef<HTMLElement>(null)
  const initialRender = useRef(true)

  useEffect(() => {
    const onHashChange = () => setPage(getPage())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (initialRender.current) {
      initialRender.current = false
      return
    }
    mainRef.current?.focus({ preventScroll: true })
  }, [page])

  

  return (
    <div className="app-shell">
      <a className="app-skip-link" href="#app-main" onClick={event => {
        event.preventDefault()
        mainRef.current?.focus()
      }}>Skip to content</a>
      <header className="app-header">
        <a className="app-brand" href="#/home">OmicsWayfinder</a>
        <nav className="app-nav" aria-label="Main navigation">
          {pages.map(item => (
            <a key={item.id} href={`#/${item.id}`} aria-current={page === item.id ? 'page' : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
        <label className="app-theme-toggle" title="Toggle dark mode">
          <input type="checkbox" role="switch" aria-label="Dark mode" />
          <span className="app-theme-toggle__track" aria-hidden="true">
            <span className="app-theme-toggle__sun">&#9728;</span>
            <span className="app-theme-toggle__moon">&#9790;</span>
          </span>
        </label>
      </header>

      <main id="app-main" ref={mainRef} tabIndex={-1}>

        {page === 'home' && (
          <HomePage />
        )}

        {page === 'filevalidator' && (
          <section className="app-validator" aria-label="File validator">
            <FileValidatorPage />
          </section>
        )}

        {page === 'about' && (
          <section className="app-page">
            <h1>About OmicsWayfinder</h1>
            <p>A research project exploring guided, reproducible biological analysis in the browser.</p>
            <p>The prototype investigates file evidence, experimental context, explicit scientific decisions,
              persistent local execution and accessible interaction. These are research objectives, not
              a validated end-to-end analysis service.</p>
            <a href="https://github.com/a-xavier/OmicsWayFinder#readme">Project overview</a>
          </section>
        )}

        {page === 'contracts' && (
          <ContractPage />
        )}

        {page === 'analyser' && (
          <section className="app-page">
            <AnalyserPage />
          </section>
        )}

        {page === 'accessibility' && (
          <section className="app-page">
            <AccessibilityPage />
          </section>
        )}

        {page === 'not-found' && (
          <section className="app-page">
            <h1>Page not found</h1>
            <a href="#/home">Return home</a>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
