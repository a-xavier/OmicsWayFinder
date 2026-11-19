import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cross-origin isolation enables SharedArrayBuffer and Atomics.wait, which Mayo's
// synchronous file bridge needs. GitHub Pages cannot send headers, so production uses
// public/coi-serviceworker.js to add them instead.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  worker: { format: 'es' },
})
