import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  define: { __APP_VERSION__: JSON.stringify('outline-preview-20261011'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/__outline_fixture_no_backend') },
  cacheDir: '.cache/outline-preview',
  build: { target:'esnext', outDir:'.cache/outline-preview-dist', rollupOptions:{ input:path.resolve(import.meta.dirname,'outline-preview.html') } },
  server: { host:'127.0.0.1', port:28483, strictPort:true, open:false },
})
