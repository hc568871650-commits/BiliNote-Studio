import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
export default defineConfig({
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  define: { __APP_VERSION__: JSON.stringify('compact-note-preview-20261012'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/__generation_usage_fixture') },
  cacheDir: '.cache/generation-usage-preview',
  build: { target:'esnext', outDir:'.cache/generation-usage-preview-dist', rollupOptions:{input:path.resolve(import.meta.dirname,'ui-preview.html')} },
  server: { host:'127.0.0.1', port:29483, strictPort:true, open:false },
})
