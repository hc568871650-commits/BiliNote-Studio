import { defineConfig, mergeConfig } from 'vite'
import uiPreview from './vite.ui-preview.config'

// Separate origin/storage and mocked API only; never starts a desktop sidecar.
export default defineConfig(mergeConfig(uiPreview, {
  define: { __APP_VERSION__: JSON.stringify('warm-startup-preview') },
  cacheDir: '.cache/warm-preview',
  build: { outDir: '.cache/warm-preview-dist' },
  server: { host: '127.0.0.1', port: 21483, strictPort: true },
}))
