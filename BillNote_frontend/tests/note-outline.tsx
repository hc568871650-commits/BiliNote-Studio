import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import { chapterKey, rehypeNoteOutline, resolveChapter, scrollToChapter } from '../src/utils/noteOutline'

const render = (source: string) => renderToStaticMarkup(<ReactMarkdown rehypePlugins={[rehypeSlug, rehypeNoteOutline]}>{source}</ReactMarkdown>)
// Optional read-only checks against user-selected legacy notes; never copy their
// content into fixtures or write a rendered tutorial to the repository.
for (const file of process.argv.slice(2)) {
  const html = render(readFileSync(file, 'utf8'))
  const ids = [...html.matchAll(/id="(note-chapter-\d+)"/g)].map(match => match[1])
  const links = [...html.matchAll(/href="#(note-chapter-\d+)"/g)].map(match => match[1])
  assert.ok(ids.length > 0)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(links.length >= ids.length)
  for (const target of links) assert.ok(ids.includes(target), `Unresolved chapter link: ${target}`)
  console.log(`Read-only note: ${basename(dirname(file))}: ${ids.length} unique headings, ${links.length} valid links`)
}
const body = '\n## 1. 准备：材质（01） *Content-[00:12]*\n\n第一节内容。\n\n## 2. UV & 烘焙！\n\n第二节内容。\n\n### 重复标题\n\n内容 A\n\n### 重复标题\n\n内容 B\n\n## 5. 最终检查\n\n第五节内容。'
for (const toc of [
  '## 目录\n\n- ## 1. 准备：材质（01）\n- ## 2. UV & 烘焙！\n- ## 5. 最终检查\n\n---\n',
  '## 目录\n\n- I. 准备：材质（01）\n- II. UV & 烘焙！\n- V. 最终检查\n\n---\n',
  '## 目录\n\n1. [准备](#错误锚点)\n2. [UV](#也不存在)\n\n---\n',
  '',
]) {
  const source = toc + body
  const html = render(source)
  assert.equal((html.match(/data-note-heading="true"/g) || []).length, 5, 'Directory entries are not body headings')
  assert.equal((html.match(/aria-label="笔记目录"/g) || []).length, 1)
  for (let index = 1; index <= 5; index++) {
    assert.ok(html.includes(`href="#note-chapter-${index}"`))
    assert.ok(html.includes(`id="note-chapter-${index}"`))
  }
  assert.ok(html.includes('第一节内容。') && html.includes('第五节内容。'))
  assert.equal(source, toc + body, 'Rendering does not mutate original Markdown')
  assert.ok(!html.includes('错误锚点'))
  assert.equal((html.match(/<h2/g) || []).length, 3)
}
assert.equal(chapterKey('2. UV & 烘焙！ Content-[00:12]'), chapterKey('II. UV ＆ 烘焙'))
assert.ok(render('## 目录\n\n- 唯一的列表内容').includes('唯一的列表内容'), 'List-only notes are preserved')
const repeatedBody = render('## 目录\n\n- 重复\n\n## 重复\n\n第一段内容\n\n## 重复\n\n第二段内容')
assert.equal((repeatedBody.match(/data-note-heading="true"/g) || []).length, 2, 'Repeated body headings with paragraphs are retained')
const headingToc = render('## 目录\n\n## 第一章\n\n## 第二章\n\n---\n\n## 第一章\n\n第一章正文\n\n## 第二章\n\n第二章正文')
assert.equal((headingToc.match(/data-note-heading="true"/g) || []).length, 2, 'Standalone headings in a directory are replaced')
const heading = (id: string, text: string, oldId = '') => ({ id, textContent: text, dataset: { noteLabel: text, noteOriginalId: oldId } })
const one = heading('note-chapter-1', '准备：材质（01）', '1-准备材质01-content-0012')
const two = heading('note-chapter-2', 'UV & 烘焙！')
const duplicateA = heading('note-chapter-3', '重复标题')
const duplicateB = heading('note-chapter-4', '重复标题')
const root = { querySelectorAll: () => [one, two, duplicateA, duplicateB] } as unknown as HTMLElement
assert.equal(resolveChapter(root, '#note-chapter-4', '重复标题'), duplicateB)
assert.equal(resolveChapter(root, '#错误锚点', 'II. UV ＆ 烘焙'), two)
assert.equal(resolveChapter(root, '#1-准备材质01-content-0012', ''), one)
assert.equal(resolveChapter(root, '#%E4%BF', 'UV & 烘焙！'), two, 'Malformed encoding does not throw')
assert.equal(resolveChapter(root, '#missing', '重复标题'), null, 'Ambiguous fallback must not jump to wrong chapter')
assert.equal(resolveChapter(root, '#UV', ''), null, 'Partial matches must not choose unrelated heading')
let scrolled: unknown
let event: Event | undefined
const viewport = { scrollTop: 200, clientTop: 1, getBoundingClientRect: () => ({ top: 100 }), dispatchEvent: (value: Event) => { event = value }, scrollTo: (value: unknown) => { scrolled = value } }
const target = { closest: () => viewport, getBoundingClientRect: () => ({ top: 600 }) } as unknown as HTMLElement
scrollToChapter(target, 'auto')
assert.deepEqual(scrolled, { top: 683, behavior: 'auto' })
assert.equal(event?.type, 'note-chapter-jump')
console.log('note outline: 4 render fixtures + unique/legacy/Chinese/duplicate/malformed links + scoped scrolling passed')
