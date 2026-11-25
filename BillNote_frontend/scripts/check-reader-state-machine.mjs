import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const browserPath = edgeCandidates.find(candidate => existsSync(candidate))
if (!browserPath) {
  throw new Error('未找到可用的本地 Edge/Chrome 浏览器，无法运行真实 React DOM 状态机测试')
}

const dir = mkdtempSync(path.join(tmpdir(), 'bilinote-reader-sm-'))
try {
  const bundlePath = path.join(dir, 'bundle.js')
  await build({
    entryPoints: [path.join(root, 'tests/reader-state-machine.browser.tsx')],
    outfile: bundlePath,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: {
      '@': path.join(root, 'src'),
      'react-hot-toast': path.join(root, 'tests/shims/toast.ts'),
    },
    define: {
      'import.meta.env': JSON.stringify({ VITE_API_BASE_URL: '/api' }),
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'warning',
  })

  const htmlPath = path.join(dir, 'index.html')
  writeFileSync(
    htmlPath,
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><script src="${pathToFileURL(bundlePath).href}"></script></body></html>`,
  )

  const proc = spawn(
    browserPath,
    [
      '--headless',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--virtual-time-budget=12000',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ],
    { windowsHide: true },
  )

  let out = ''
  let err = ''
  proc.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
  proc.stderr.setEncoding('utf8').on('data', chunk => { err += chunk })
  const code = await new Promise((resolve, reject) => {
    proc.on('close', resolve)
    proc.on('error', reject)
  })
  const match = out.match(/<pre id="state-machine-result">([\s\S]*?)<\/pre>/)
  if (code || !match) {
    throw new Error(`Browser runner failed (exit ${code}): ${err.slice(-2000)}\n${out.slice(-2000)}`)
  }
  const decoded = match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  const payload = JSON.parse(decoded)
  if (!payload.ok) {
    throw new Error(payload.error || 'Reader state machine test failed')
  }
  for (const line of payload.results) {
    console.log(line)
  }
  console.log('PASS: reader-state-machine browser suite')
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
}
