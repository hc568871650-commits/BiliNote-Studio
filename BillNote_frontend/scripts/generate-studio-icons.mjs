// One vector source for the title-bar mark, favicon and Windows app resources.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mark = readFileSync(resolve(frontend, 'src/assets/studio-mark.svg'), 'utf8')
const body = mark.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim()
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 415 415" fill="none">
  <rect width="415" height="415" rx="28" fill="#202020"/>
  ${body}
</svg>\n`
writeFileSync(resolve(frontend, 'public/studio-icon.svg'), appIcon)
const output = resolve(frontend, '.cache/studio-icons')
mkdirSync(output, { recursive: true })
execFileSync(process.execPath, [resolve(frontend, 'node_modules/@tauri-apps/cli/tauri.js'),
  'icon', resolve(frontend, 'public/studio-icon.svg'), '--output', output], { cwd: frontend, stdio: 'inherit' })
for (const extension of ['ico', 'png']) {
  copyFileSync(resolve(output, `icon.${extension}`), resolve(frontend, `src-tauri/icons/studio.${extension}`))
}
