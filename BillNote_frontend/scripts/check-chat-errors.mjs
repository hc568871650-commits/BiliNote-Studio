import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/chat-errors-check.cjs')
await build({ entryPoints: [path.join(root, 'tests/chat-errors.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', alias: { '@': path.join(root, 'src') }, define: { 'import.meta.env': '{}' }, logLevel: 'warning' })
const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
process.exitCode = result.status ?? 1
