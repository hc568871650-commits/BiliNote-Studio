import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { compatibilityStorage } from './desktop_storage_compatibility.mjs'

const [action, port, destination] = process.argv.slice(2)
if (!['inspect', 'upgrade', 'downgrade'].includes(action) || !/^19\d{3}$/.test(port) || !path.isAbsolute(destination)) throw new Error('Expected inspect|upgrade|downgrade, loopback port 19xxx, absolute output directory')
const output = path.resolve(destination)
await fs.mkdir(output, { recursive: false })
const require = createRequire(process.env.BILINOTE_TEST_RUNTIME_PACKAGE || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json')
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
try {
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => /^https?:\/\/tauri\.localhost\//.test(page.url()))
  if (pages.length !== 1) throw new Error('Expected exactly one native application page')
  const page = pages[0]
  if (await page.locator('[aria-label="停止等待回答"]').count()) throw new Error('A reading request is active')
  await page.goto(new URL('/storage-maintenance.html', page.url()).href)
  if (await page.title() !== 'BiliNote 存储维护') throw new Error('Maintenance page unavailable; refusing storage access')
  const before = await page.evaluate(compatibilityStorage)
  // Private snapshots stay local beside this release and never go to stdout.
  await fs.writeFile(path.join(output, 'logical-storage-before.json'), JSON.stringify(before.states), { flag: 'wx' })
  if (action === 'downgrade') await page.evaluate(compatibilityStorage, { apply: true, expected: before.states })
  if (action === 'upgrade') {
    await page.addScriptTag({ path: new URL('./storage-upgrade.js', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1') })
    await page.evaluate(() => window.upgradeBiliNoteStorage())
  }
  const after = await page.evaluate(compatibilityStorage)
  const digest = states => crypto.createHash('sha256').update(JSON.stringify(states)).digest('hex')
  if (digest(before.states) !== digest(after.states)) throw new Error('Storage content changed during conversion')
  const summary = { action, tasks: after.tasks, sessions: after.sessions, beforeFormats: before.formats, afterFormats: after.formats,
    logicalSha256: digest(after.states), logicalContentPreserved: true }
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(summary, null, 2), { flag: 'wx' })
  console.log(JSON.stringify(summary))
} finally { await browser.close() }
