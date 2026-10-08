import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
for (const name of ['organizer-session', 'organizer-retention']) {
  const outfile = path.join(root, `.cache/${name}-check.cjs`)
  await build({ entryPoints: [path.join(root, `tests/${name}.ts`)], outfile, bundle: true, platform: 'node', format: 'cjs', alias: { '@': path.join(root, 'src'), 'react-hot-toast': path.join(root, 'tests/shims/toast.ts') }, define: { 'import.meta.env': '{}' }, logLevel: 'warning' })
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
}
