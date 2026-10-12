import assert from 'node:assert/strict'
import { buildReadingOutline, type ReadingOutlineHeading } from '../src/utils/readingOutline'

const heading = (id: string, text: string, level = 2, time?: number): ReadingOutlineHeading => ({ id, text, level, time })
const ids = (items: readonly ReadingOutlineHeading[]) => items.map(item => item.id)
const complete = (input: readonly ReadingOutlineHeading[]) => {
  const before = JSON.stringify(input)
  const outline = buildReadingOutline(input)
  assert.deepEqual(ids(outline.groups.flatMap(group => group.items)), ids(outline.full), 'Groups preserve every visible heading in source order')
  assert.equal(JSON.stringify(input), before, 'Navigation never mutates input or body IDs')
  for (const group of outline.groups) assert.equal(group.title, group.items[0], 'Group title is a real first heading')
  return outline
}

for (const length of [24, 71, 116]) {
  const input = Array.from({ length }, (_, index) => heading(`body-${index}`, `知识点 ${index + 1}`, 2, index * 60))
  input.push(heading('last-h3', '末尾补充', 3, length * 60))
  const outline = complete(input)
  assert.ok(outline.grouped)
  assert.ok(outline.groups.length <= 12)
  assert.equal(outline.full.length, length + 1)
  assert.equal(outline.groups.at(-1)?.items.at(-1)?.id, 'last-h3')
}

const repeated = complete([
  heading('title-a', '课程名称', 1), heading('segment-a', '来源分段 1'), heading('first', '第一节'),
  heading('title-b', ' 课程名称 ', 1), heading('segment-b', '来源分段２', 3), heading('second', '第二节'),
])
assert.deepEqual(ids(repeated.full), ['first', 'second'])
assert.equal(repeated.grouped, false)

const hierarchy = complete([
  heading('orphan', '开篇三级标题', 3), heading('chapter-a', '第一章'), heading('child-a', '细节', 3),
  heading('deep-a', '更深细节', 4), heading('chapter-b', '第二章'), heading('child-b', '末尾细节', 3),
])
assert.deepEqual(hierarchy.groups.map(group => ids(group.items)), [['orphan'], ['chapter-a', 'child-a', 'deep-a'], ['chapter-b', 'child-b']])
assert.equal(hierarchy.grouped, false)

const sameNames = complete([heading('same-a', '重复名称', 2, 0), heading('same-b', '重复名称', 2, 100), heading('same-c', '重复名称', 3, 100)])
assert.deepEqual(ids(sameNames.full), ['same-a', 'same-b', 'same-c'])
assert.deepEqual(complete([heading('later', '后出现但时间早', 2, 10), heading('earlier', '先前内容的补充', 2, 0)]).full.map(item => item.time), [10, 0])
assert.deepEqual(complete([]), { full: [], groups: [], grouped: false })
assert.equal(complete([heading('segment', '来源分段 1')]).full.length, 0)
assert.equal(complete([heading('real', '来源分段 1 的说明')]).full.length, 1)
assert.deepEqual(ids(complete([heading('h1-a', '课程', 1), heading('h1-b', '课程', 1)]).full), ['h1-a', 'h1-b'])

const oneTitle = complete([heading('title', '单次文档标题', 1), heading('one', '第一章'), heading('two', '第二章'), heading('tail', '尾项', 3)])
assert.deepEqual(oneTitle.groups.map(group => ids(group.items)), [['title'], ['one'], ['two', 'tail']])
const longWithTitle = complete([heading('long-title', '长篇标题', 1), ...Array.from({ length: 116 }, (_, index) => heading(`long-${index}`, `章节 ${index}`))])
assert.ok(longWithTitle.groups.length <= 12, 'Document title is included in the compact group budget')
const short = complete(Array.from({ length: 12 }, (_, index) => heading(`short-${index}`, `短篇 ${index}`)))
assert.equal(short.groups.length, 12)
assert.equal(short.grouped, false)
const withSubchapters = complete(Array.from({ length: 24 }, (_, index) => [
  heading(`parent-${index}`, `章节 ${index}`, 2),
  heading(`child-${index}-a`, '细节 A', 3),
  heading(`child-${index}-b`, '细节 B', 3),
]).flat())
assert.ok(withSubchapters.grouped, 'Many chapter children must not prevent a compact overview')
assert.equal(withSubchapters.full.length, 72)
assert.ok(withSubchapters.groups.length <= 12)
assert.equal(withSubchapters.groups.at(-1)?.items.at(-1)?.id, 'child-23-b')
console.log('PASS: 24/71/116 flat headings, wrapper filtering, hierarchy/orphans, duplicates and timestamps, title-only/empty/short documents, immutable IDs')
