import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const outfile = path.join(root, '.cache/generation-polling-check.mjs')
const shim = path.join(root, 'tests/shims/generation-polling.ts')
await build({ entryPoints: [path.join(root, 'tests/generation-polling.ts')], outfile, bundle: true,
  platform: 'node', format: 'esm', alias: { '@': path.join(root, 'src'), react: shim, 'react-hot-toast': shim, '@/store/taskStore': shim, '@/services/note': shim }, logLevel: 'warning' })
const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
process.exitCode = result.status ?? 1
if (!process.exitCode) {
  const homeFile = path.join(root, '.cache/generation-home-check.mjs')
  const homeShim = path.join(root, 'tests/shims/generation-home.ts')
  await build({ entryPoints: [path.join(root, 'tests/generation-home.tsx')], outfile: homeFile, bundle: true,
    platform: 'node', format: 'esm', alias: { '@': path.join(root, 'src'), react: homeShim, 'react/jsx-runtime': homeShim, 'react-router-dom': homeShim,
      '@/store/taskStore': homeShim, '@/store/interfaceStore': homeShim, '@/layouts/HomeLayout.tsx': homeShim,
      '@/pages/HomePage/components/NoteForm.tsx': homeShim, '@/pages/HomePage/components/MarkdownViewer.tsx': homeShim,
      '@/pages/HomePage/components/History.tsx': homeShim }, jsx: 'automatic', logLevel: 'warning' })
  process.exitCode = spawnSync(process.execPath, [homeFile], { stdio: 'inherit', cwd: root }).status ?? 1
}
if (!process.exitCode) {
  const progressFile = path.join(root, '.cache/generation-progress-check.mjs')
  await build({ entryPoints: [path.join(root, 'tests/generation-progress.tsx')], outfile: progressFile, bundle: true,
    platform: 'node', format: 'esm', alias: { '@': path.join(root, 'src') }, loader: { '.css': 'empty' }, jsx: 'automatic', logLevel: 'warning',
    banner: { js: "import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(import.meta.url);" } })
  process.exitCode = spawnSync(process.execPath, [progressFile], { stdio: 'inherit', cwd: root }).status ?? 1
}
if (!process.exitCode) {
  const storageFile = path.join(root, '.cache/generation-storage-check.mjs')
  await build({ entryPoints: [path.join(root, 'tests/generation-storage.ts')], outfile: storageFile, bundle: true,
    platform: 'node', format: 'esm', alias: { 'idb-keyval': path.join(root, 'tests/shims/generation-idb.ts') }, logLevel: 'warning' })
  process.exitCode = spawnSync(process.execPath, [storageFile], { stdio: 'inherit', cwd: root }).status ?? 1
}
if (!process.exitCode) {
  const storeFile = path.join(root, '.cache/generation-store-check.mjs')
  await build({ entryPoints: [path.join(root, 'tests/generation-store.ts')], outfile: storeFile, bundle: true,
    platform: 'node', format: 'esm', alias: { '@': path.join(root, 'src'), 'idb-keyval': path.join(root, 'tests/shims/generation-idb.ts'), 'react-hot-toast': path.join(root, 'tests/shims/toast.ts') },
    banner: { js: "import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(import.meta.url);" },
    define: { 'import.meta.env': '{}' }, logLevel: 'warning' })
  process.exitCode = spawnSync(process.execPath, [storeFile], { stdio: 'inherit', cwd: root }).status ?? 1
}
