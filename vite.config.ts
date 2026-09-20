import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // This app already requires module workers, WebCrypto and Blob, so nothing
  // that needs downlevelled output can run it. Emitting modern output keeps
  // the engine's hot loops free of transpiler helper shims.
  build: { target: 'esnext' },
  worker: { format: 'es' },
})
