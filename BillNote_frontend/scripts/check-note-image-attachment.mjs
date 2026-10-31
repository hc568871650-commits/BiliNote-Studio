import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/note-image-attachment-check.mjs')
await build({ entryPoints: [path.join(root, 'tests/note-image-attachment.ts')], outfile, bundle: true, platform: 'node', format: 'esm',
  alias: { '@': path.join(root, 'src'), 'idb-keyval': path.join(root, 'tests/shims/idb-keyval.ts') },
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://127.0.0.1:29485/api') }, logLevel: 'warning' })
process.exitCode = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root }).status ?? 1
