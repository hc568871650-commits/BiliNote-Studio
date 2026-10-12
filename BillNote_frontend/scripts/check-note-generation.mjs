import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/note-generation-check.cjs')
await build({ entryPoints: [path.join(root, 'tests/note-generation.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' })
process.exitCode = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root }).status ?? 1
