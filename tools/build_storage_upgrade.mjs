import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs/promises'
const [source, release] = process.argv.slice(2)
const require = createRequire(path.join(source, 'BillNote_frontend/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const frontend = path.join(source, 'BillNote_frontend')
await build({ stdin: { contents: `import { createTaskStorage } from '@/utils/taskStorage';
import { createReadingSessionStorage } from '@/utils/readingSessionStorage';
window.upgradeBiliNoteStorage = async () => {
  for (const [name, storage] of [['task-storage', createTaskStorage()], ['bilinote-reading-assistant-v1', createReadingSessionStorage()]]) {
    const value = await storage.getItem(name);
    if (value) await storage.setItem(name, value);
  }
};`, resolveDir: frontend, loader: 'ts' }, outfile: path.join(release, 'storage-upgrade.js'),
  bundle: true, platform: 'browser', format: 'iife', alias: { '@': path.join(frontend, 'src') }, logLevel: 'warning' })
await fs.access(path.join(release, 'storage-upgrade.js'))
console.log('Native storage migration uses the staged production adapters')
