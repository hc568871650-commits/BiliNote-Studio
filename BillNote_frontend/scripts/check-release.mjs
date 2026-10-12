// Synthetic checks only: no backend, browser server, credentials or model calls.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const scripts = path.dirname(fileURLToPath(import.meta.url))
for (const file of readdirSync(scripts).filter(file => /^check-.*\.mjs$/.test(file) && file !== 'check-release.mjs').sort()) {
  console.log(`\nRunning ${file}`)
  const result = spawnSync(process.execPath, [path.join(scripts, file)], { stdio: 'inherit', cwd: path.dirname(scripts) })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
