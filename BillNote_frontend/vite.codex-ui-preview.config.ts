import { defineConfig, mergeConfig } from 'vite'
import uiPreview from './vite.ui-preview.config'

// UI fixtures only: a new origin, cache and build directory; no backend proxy.
export default defineConfig(mergeConfig(uiPreview, {
  define: { __APP_VERSION__: JSON.stringify('codex-color-preview-20261009') },
  cacheDir: '.cache/codex-color-preview',
  build: { outDir: '.cache/codex-color-preview-dist' },
  server: { host: '127.0.0.1', port: 22483, strictPort: true, open: false },
}))
