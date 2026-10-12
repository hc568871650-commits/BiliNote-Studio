import assert from 'node:assert/strict'
import { normalizeNoteStyle, normalizeNoteFormats, noteStyleLabel } from '../src/utils/noteGeneration'

for (const style of ['minimal', 'detailed', 'task_oriented', 'tutorial', undefined, 'future-style']) assert.equal(normalizeNoteStyle(style), 'tutorial')
for (const style of ['academic', 'xiaohongshu', 'life_journal', 'business', 'meeting_minutes', 'knowledge']) assert.equal(normalizeNoteStyle(style), 'knowledge')
assert.equal(noteStyleLabel('academic'), '学术')
assert.equal(noteStyleLabel('knowledge'), '知识笔记')
assert.deepEqual(normalizeNoteFormats(['toc', 'summary']), ['link'])
assert.deepEqual(normalizeNoteFormats(['summary', 'screenshot', 'screenshot']), ['link', 'screenshot'])
assert.deepEqual(normalizeNoteFormats(undefined), ['link'])
console.log('note generation migration contracts passed')
