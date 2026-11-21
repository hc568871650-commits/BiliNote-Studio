import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')
const indexPath = path.join(distDir, 'index.html')

const MAX_INITIAL_JS_BYTES = 1350 * 1024
const FORBIDDEN_INITIAL_PATTERNS = [/markmap/i, /syntax[-_]?highlighter/i, /prism/i]

if (!fs.existsSync(indexPath)) {
  console.error(`[bundle-budget] 找不到 ${indexPath}，请先执行 pnpm.cmd build`)
  process.exit(1)
}

const html = fs.readFileSync(indexPath, 'utf-8')
const refs = new Set()

for (const match of html.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/gi)) {
  refs.add(match[1])
}
for (const match of html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/gi)) {
  if (match[1].endsWith('.js')) refs.add(match[1])
}

let totalBytes = 0
const files = []
const forbiddenHits = []

for (const rawRef of refs) {
  const rel = rawRef.replace(/^\.?\//, '')
  const full = path.join(distDir, rel)
  if (!fs.existsSync(full)) continue
  const size = fs.statSync(full).size
  totalBytes += size
  files.push({ file: rel, size })
  if (FORBIDDEN_INITIAL_PATTERNS.some((re) => re.test(rel))) {
    forbiddenHits.push(rel)
  }
}

files.sort((a, b) => b.size - a.size)

console.log('[bundle-budget] 首屏直载 JS 清单:')
for (const item of files) {
  console.log(`  - ${item.file}: ${(item.size / 1024).toFixed(1)} KB`)
}
console.log(
  `[bundle-budget] 首屏直载 JS 总计: ${(totalBytes / 1024).toFixed(1)} KB / 预算 ${(MAX_INITIAL_JS_BYTES / 1024).toFixed(0)} KB`,
)

let failed = false
if (totalBytes > MAX_INITIAL_JS_BYTES) {
  console.error(
    `[bundle-budget] FAILED: 首屏直载 JS 超出预算（${(totalBytes / 1024).toFixed(1)} KB > ${(MAX_INITIAL_JS_BYTES / 1024).toFixed(0)} KB）`,
  )
  failed = true
}
if (forbiddenHits.length > 0) {
  console.error(`[bundle-budget] FAILED: 首屏直载命中禁用重型分包: ${forbiddenHits.join(', ')}`)
  failed = true
}

if (failed) process.exit(1)
console.log('[bundle-budget] PASS')
