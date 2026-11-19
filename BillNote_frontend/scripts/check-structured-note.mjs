import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')

function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(hexA, hexB) {
  const l1 = relativeLuminance(hexA)
  const l2 = relativeLuminance(hexB)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/types/structuredNote.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

assert.equal(mod.formatSeconds(728), '12:08')
assert.equal(mod.formatSeconds(3723), '01:02:03')

assert.equal(mod.parseTimeSearchQuery('14:05'), 845)
assert.equal(mod.parseTimeSearchQuery('01:02:03'), 3723)
assert.equal(mod.parseTimeSearchQuery('12:75'), null)
assert.equal(mod.parseTimeSearchQuery('连接池调优'), null)

const unitTokens = mod.splitNumericUnits('限制耗时 3000 ms 且推荐 CPU核数 × 2 + 1 核')
assert(unitTokens.some(t => t.nowrap && t.text === '3000 ms'))
assert(unitTokens.some(t => t.nowrap && t.text.includes('CPU核数')))

assert.equal(
  mod.buildOriginTimeUrl('bilibili', 'BV1demo_p2', '', 120),
  'https://www.bilibili.com/video/BV1demo?p=2&t=120',
)
assert.equal(
  mod.buildOriginTimeUrl('youtube', 'vid123', '', 45),
  'https://www.youtube.com/watch?v=vid123&t=45s',
)

const sampleDoc = {
  schema_version: 1,
  note_style: 'knowledge',
  title: '测试标题',
  sections: [{
    id: 'sec-1',
    title: '第一节',
    level: 2,
    time_ranges: [{ start: 10, end: 30, label: '00:10' }],
    core_takeaways: [{ spans: [{ text: '核心结论', emphasis: 'hl' }] }],
    blocks: [
      { type: 'paragraph', spans: [{ text: '主干内容。', emphasis: 'plain' }] },
      {
        type: 'checklist',
        title: '环境准备自查',
        items: [{ id: 'c1', spans: [{ text: '安装 Node.js 22', emphasis: 'code' }], checked: false }],
      },
    ],
    annotations: [],
    quiz: null,
  }],
}
assert.equal(mod.resolveStructuredNote({ structured: sampleDoc }, '# markdown')?.title, '测试标题')
assert.equal(mod.resolveStructuredNote(null, JSON.stringify(sampleDoc))?.title, '测试标题')
assert.equal(mod.resolveStructuredNote(null, '# 纯文本标题\n\n正文'), null)
assert.equal(mod.sectionPlainSummary(sampleDoc.sections[0]), '核心结论\n主干内容。\n环境准备自查：安装 Node.js 22')
const sampleMindmap = mod.structuredNoteToMindmapMarkdown(sampleDoc)
assert(sampleMindmap.includes('# 测试标题') && sampleMindmap.includes('## 第一节 (00:10)') && sampleMindmap.includes('- **核心结论**') && sampleMindmap.includes('- [自查] 安装 Node.js 22'))

const accentBundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/store/accentStore.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  logLevel: 'warning',
})
const accentMod = await import(`data:text/javascript;base64,${Buffer.from(accentBundled.outputFiles[0].text).toString('base64')}`)
const expectedIds = ['slate', 'blue', 'violet', 'teal', 'green', 'orange', 'rose']
assert.deepEqual(
  accentMod.accentColors.map(c => c.id),
  expectedIds,
)
for (const preset of accentMod.accentColors) {
  const lightContrast = contrastRatio(preset.light, '#ffffff')
  const darkContrastMain = contrastRatio(preset.dark, '#181818')
  const darkContrastReader = contrastRatio(preset.dark, '#1c1c1e')
  assert(
    lightContrast >= 4.5,
    `Preset ${preset.id} light ${preset.light} contrast ${lightContrast.toFixed(2)} < 4.5`,
  )
  assert(
    darkContrastMain >= 4.5 && darkContrastReader >= 4.5,
    `Preset ${preset.id} dark ${preset.dark} contrast ${Math.min(darkContrastMain, darkContrastReader).toFixed(2)} < 4.5`,
  )
}

const accentCss = readFileSync(fileURLToPath(new URL('../src/accent.css', import.meta.url)), 'utf8')
for (const id of [...expectedIds, 'custom']) {
  assert(accentCss.includes(`:root[data-accent="${id}"]`), `accent.css missing :root[data-accent="${id}"]`)
}
assert(accentCss.includes('--reading-accent-light:') && accentCss.includes('--reading-spot-dark:'))

const structuredCss = readFileSync(
  fileURLToPath(new URL('../src/pages/HomePage/components/StructuredNoteReader/structured-note.css', import.meta.url)),
  'utf8',
)
assert(structuredCss.includes('var(--reading-accent'))
assert(structuredCss.includes('var(--reading-spot'))
assert(structuredCss.includes('var(--ui-font'))
assert(structuredCss.includes('calc(0.5cap - var(--anno-size) / 2)'))
assert(!structuredCss.includes('.anno-dot::after'))
assert(!structuredCss.includes('text-box:'))
assert(structuredCss.includes('.note-p {\n  font-size: 1em;') || structuredCss.includes('.note-p {\r\n  font-size: 1em;'))
assert(!structuredCss.includes('.margin-rail'))
assert(!structuredCss.includes('.swatch-bar'))
assert(structuredCss.includes('.note-checklist-input'))
assert(structuredCss.includes('forced-colors: active'))
assert(structuredCss.includes('.sec-refine-btn'))

console.log('PASS: structuredNote helpers + global accent WCAG contrast & token sync')
