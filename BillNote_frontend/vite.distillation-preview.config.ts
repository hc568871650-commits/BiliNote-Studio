import { defineConfig, mergeConfig } from 'vite'
import uiPreview from './vite.ui-preview.config'

export default defineConfig(mergeConfig(uiPreview, {
  define: { __APP_VERSION__: JSON.stringify('distillation-preview-20261011'),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://127.0.0.1:25485/api') },
  cacheDir: '.cache/distillation-preview', build: { outDir: '.cache/distillation-preview-dist' },
  server: { host: '127.0.0.1', port: 25483, strictPort: true, open: false },
}))
