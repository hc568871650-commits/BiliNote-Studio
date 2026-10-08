import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/chat-stream-check.mjs')
await build({ entryPoints: [path.join(root, 'tests/chat-stream.ts')], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', alias: { '@': path.join(root, 'src') }, define: { 'import.meta.env': '{}' }, logLevel: 'warning' })
const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
process.exitCode = result.status ?? 1
