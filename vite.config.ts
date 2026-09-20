import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The RS repair path is a tight scalar loop over ~12k blocks per 3 MB. The
  // default build target downlevels spread/iteration into helper calls, which
  // measured ~3.5x slower than dev on the repair path. This app already
  // requires module workers and WebCrypto, so nothing older can run it anyway.
  build: { target: 'esnext' },
  worker: { format: 'es' },
})
