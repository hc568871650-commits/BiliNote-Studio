import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/work-progress-check.cjs')
await build({ entryPoints: [path.join(root, 'tests/work-progress.tsx')], outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty' }, alias: { '@': path.join(root, 'src'), 'react-hot-toast': path.join(root, 'tests/shims/toast.ts') }, define: { 'import.meta.env': '{}' }, logLevel: 'warning' })
const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
process.exitCode = result.status ?? 1
