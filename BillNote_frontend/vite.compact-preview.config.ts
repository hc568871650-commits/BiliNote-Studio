import { defineConfig, mergeConfig } from 'vite'
import uiPreview from './vite.ui-preview.config'

export default defineConfig(mergeConfig(uiPreview, {
  define: { __APP_VERSION__: JSON.stringify('compact-chat-preview') },
  cacheDir: '.cache/compact-preview-v1',
  build: { outDir: '.cache/compact-preview-dist' },
  server: { host: '127.0.0.1', port: 20483, strictPort: true },
}))
