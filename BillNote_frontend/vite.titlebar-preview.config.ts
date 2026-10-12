import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Isolated UI fixture: no backend proxy, sidecar, model call or production data.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  define: { __APP_VERSION__: JSON.stringify('titlebar-ui-fixture-20261011'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/__generation_preview_api') },
  cacheDir: '.cache/titlebar-preview-v1',
  build: { target: 'esnext', outDir: '.cache/titlebar-preview-dist', rollupOptions: { input: path.resolve(import.meta.dirname, 'ui-preview.html') } },
  server: { host: '127.0.0.1', port: 27483, strictPort: true, open: false, watch: { usePolling: true, interval: 700, ignored: ['**/.cache/**', '**/dist/**', '**/.preview-settings-build/**'] } },
})
