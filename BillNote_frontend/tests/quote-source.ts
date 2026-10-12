import assert from 'node:assert/strict'
import { quoteParts, resolveQuoteTargets } from '../src/utils/quoteSource'
import type { ReadingAttachment } from '../src/store/readingAssistantStore'

const attachment = (values: Partial<ReadingAttachment>): ReadingAttachment => ({ id: 'quote', type: 'quote', name: '引用', ...values })
const texts = Array.from({ length: 12 }, (_, index) => `原文 ${index}`)
texts[3] = '| 名称 | 数量 |\n| --- | --- |\n| UV | 2 |'
texts[8] = '```ts\nconst value = 1 + 2\n```'
let offset = 0
const blocks = texts.map((text, index) => {
  const range = { blockId: `b${index}`, start: offset, end: offset + text.length }
  offset = range.end + 2
  return range
})
const merged = attachment({ text: texts.join('\n\n'), blocks })
assert.deepEqual(quoteParts(merged), texts.map((text, index) => ({ blockId: `b${index}`, text })), 'All 12 ranges, including Markdown tables/code, remain intact')
assert.equal(Object.keys(blocks[0]).includes('text'), false, 'Ranges do not duplicate stored text')
assert.deepEqual(quoteParts(attachment({ text: 'abcdef', blocks: [
  { start: -1, end: 2 }, { start: 0.5, end: 2 }, { start: 0, end: Number.MAX_SAFE_INTEGER + 1 },
  { start: 0, end: 7 }, { start: 0, end: 0 }, { start: 1, end: 3 },
  { start: 2, end: 4 }, { start: 0, end: 1 }, { start: 3, end: 6 },
] })), [{ blockId: undefined, text: 'bc' }, { blockId: undefined, text: 'def' }], 'Invalid, overlapping and out-of-order ranges cannot slice past bounds')
assert.deepEqual(quoteParts(attachment({ text: 'legacy', blockId: 'old', blocks: [{ start: 3, end: 2 }] })), [{ blockId: 'old', text: 'legacy' }])
assert.deepEqual(quoteParts(attachment({ text: '框选原文', blockId: 'old' })), [{ blockId: 'old', text: '框选原文', partial: true }])
assert.deepEqual(quoteParts(attachment({ text: '  ' })), [])

// Lightweight DOM fixtures exercise root scoping and control removal without
// loading browser/server state or adding a DOM dependency.
const block = (id: string, text: string, raw = true) => ({
  dataset: { noteBlock: id, ...(raw ? { noteText: text } : {}) },
  textContent: `${text}+`,
  cloneNode: () => {
    const clone = { textContent: `${text}+`, querySelectorAll: () => [{ remove: () => { clone.textContent = text } }] }
    return clone
  },
}) as unknown as HTMLElement
const elements = texts.map((text, index) => block(`b${index}`, text))
const repeatedA = block('repeat-a', '重复文本')
const repeatedB = block('repeat-b', '重复文本')
const fallback = block('plain', '  正文 + 数字\n 2  ', false)
const emphasis = block('emphasis', '前段 **强调文字** 后段')
emphasis.cloneNode = (() => {
  const clone = { textContent: '前段 强调文字 后段+', querySelectorAll: () => [{ remove: () => { clone.textContent = '前段 强调文字 后段' } }] }
  return clone
}) as typeof emphasis.cloneNode
const all = [...elements, repeatedA, repeatedB, fallback, emphasis]
const root = { querySelectorAll: (selector: string) => {
  assert.equal(selector, '[data-note-block]')
  return all
} } as unknown as HTMLElement
assert.deepEqual(resolveQuoteTargets(root, quoteParts(merged)), elements)
assert.deepEqual(resolveQuoteTargets(root, [{ blockId: 'b1', text: texts[2] }]), [elements[2]], 'Drifted ID uses only unique exact content')
assert.deepEqual(resolveQuoteTargets(root, [{ blockId: 'b1', text: '已删除原文' }]), [], 'Same ID with different text must not jump')
assert.deepEqual(resolveQuoteTargets(root, [{ text: '重复文本' }]), [], 'Ambiguous text is unresolved')
assert.deepEqual(resolveQuoteTargets(root, [{ blockId: 'repeat-b', text: '重复文本' }]), [repeatedB], 'Verified ID disambiguates repetition')
assert.deepEqual(resolveQuoteTargets(root, [{ blockId: 'missing', text: '重复文本' }]), [])
assert.deepEqual(resolveQuoteTargets(root, [{ text: '正文 + 数字 2' }]), [fallback], 'Fallback strips selection button and normalizes whitespace')
assert.deepEqual(resolveQuoteTargets(root, [
  { blockId: 'b8', text: texts[8] }, { blockId: 'b2', text: texts[2] }, { blockId: 'b8', text: texts[8] },
]), [elements[8], elements[2]], 'Preserve source-part order and deduplicate targets')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(attachment({ text: texts.join('\n\n'), blockId: 'b0', blockCount: 12 }))), [elements[0]], 'Legacy merged quote recovers only its start')
assert.deepEqual(resolveQuoteTargets(root, [{ blockId: 'b0', text: '原文 00 extra' }]), [], 'A lexical prefix is not a complete block prefix')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(attachment({ blockId: 'plain', text: '数字' }))), [fallback], 'A selected substring resolves within its verified block')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(attachment({ blockId: 'emphasis', text: '段 强调文字 后' }))), [emphasis], 'Visible selection can cross Markdown emphasis syntax')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(attachment({ text: '段 强调文字 后' }))), [emphasis], 'Unique visible substring works without a block ID')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(attachment({ text: '重复' }))), [], 'Ambiguous selected substrings must not jump')
const containsRoot = { querySelectorAll: () => [block('exact', '部分'), block('longer', '这也是部分文本')] } as unknown as HTMLElement
assert.deepEqual(resolveQuoteTargets(containsRoot, quoteParts(attachment({ text: '部分' }))), [], 'One exact text match still cannot disambiguate a partial quote contained by another block')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(attachment({ blockId: 'repeat-b', text: '重复' }))), [repeatedB], 'Verified block ID disambiguates selected substrings')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(attachment({ blockId: 'plain', text: '数字', blockCount: 2 }))), [], 'Legacy merged quotes never use partial substring matching')
const otherRoot = { querySelectorAll: () => [] } as unknown as HTMLElement
const generated = block('toc', '目录 学习方法', false)
generated.dataset.noteText = ''
assert.deepEqual(resolveQuoteTargets({ querySelectorAll: () => [generated] } as unknown as HTMLElement, [{ blockId: 'toc', text: '目录 学习方法' }]), [generated], 'Generated blocks with an empty Markdown range use visible text')
const spanning = attachment({ blockId: 'emphasis', text: '段 强调文字 后段\n下一段的文字', sourceText: '段 强调文字 后段' })
assert.equal(quoteParts(spanning)[0].text, spanning.text, 'Cross-block selection retains the entire quote')
assert.deepEqual(resolveQuoteTargets(root, quoteParts(spanning)), [emphasis], 'Cross-block mouse selection verifies the captured starting excerpt')
assert.deepEqual(resolveQuoteTargets(root, quoteParts({ ...spanning, sourceText: '不存在的原文' })), [], 'A changed start must not jump by ID alone')
assert.deepEqual(resolveQuoteTargets(otherRoot, quoteParts(merged)), [], 'Never resolve outside the given source root')
console.log('quote source: 12 complete ranges, Markdown preservation, corrupt ranges, legacy start, scoped text/ID matching, ambiguity and ordered deduplication passed')
