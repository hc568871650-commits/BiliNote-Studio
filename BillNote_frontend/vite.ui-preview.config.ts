import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// UI-only sandbox: no proxy, no backend, no Tauri sidecar, isolated browser origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  define: { __APP_VERSION__: JSON.stringify('next-ui-preview'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/__ui_preview_api') },
  cacheDir: '.cache/ui-preview-v2',
  build: { target: 'esnext', outDir: '.cache/ui-preview-dist', rollupOptions: { input: path.resolve(import.meta.dirname, 'ui-preview.html') } },
  server: { host: '127.0.0.1', port: 19483, strictPort: true, open: false, watch: { usePolling: true, interval: 700, ignored: ['**/.cache/**', '**/dist/**', '**/.preview-settings-build/**'] } },
})
