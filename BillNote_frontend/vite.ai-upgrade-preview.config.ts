import { defineConfig, mergeConfig } from 'vite'
import uiPreview from './vite.ui-preview.config'
export default defineConfig(mergeConfig(uiPreview, {
  define:{__APP_VERSION__:JSON.stringify('ai-upgrade-preview-20261010'),'import.meta.env.VITE_API_BASE_URL':JSON.stringify('/__ai_upgrade_api')},
  cacheDir:'.cache/ai-upgrade-preview',build:{outDir:'.cache/ai-upgrade-preview-dist'},
  server:{host:'127.0.0.1',port:23483,strictPort:true,open:false},
}))
