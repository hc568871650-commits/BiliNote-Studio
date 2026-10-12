import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/generation-models-check.mjs')
await build({ entryPoints: [path.join(root, 'tests/generation-models.ts')], outfile, bundle: true, platform: 'node', format: 'esm',
  alias: { '@/services/model': path.join(root, 'tests/shims/generation-model-service.ts') }, logLevel: 'warning' })
process.exitCode = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root }).status ?? 1
