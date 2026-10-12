import { defineConfig, mergeConfig } from 'vite'
import uiPreview from './vite.ui-preview.config'

// Quote interaction fixtures only, with a separate origin and no backend proxy.
export default defineConfig(mergeConfig(uiPreview, {
  define: { __APP_VERSION__: JSON.stringify('quote-navigation-preview-20261010') },
  cacheDir: '.cache/quote-navigation-preview',
  build: { outDir: '.cache/quote-navigation-preview-dist' },
  server: { host: '127.0.0.1', port: 24483, strictPort: true, open: false },
}))
