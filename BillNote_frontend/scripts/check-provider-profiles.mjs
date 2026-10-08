import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/provider-profiles-check.cjs')
await build({ entryPoints: [path.join(root, 'tests/provider-profiles.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', banner: { js: 'const testStorage = new Map(); globalThis.localStorage = { getItem: key => testStorage.get(key) ?? null, setItem: (key, value) => testStorage.set(key, value), removeItem: key => testStorage.delete(key) }; globalThis.window = { localStorage: globalThis.localStorage };' }, logLevel: 'warning' })
const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
process.exitCode = result.status ?? 1
