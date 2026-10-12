import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { noteExportContent, noteMenuPosition, noteVersions } from '../src/utils/noteActions'
import NoteActionsPopover from '../src/pages/HomePage/components/NoteActionsPopover'
import type { Markdown } from '../src/store/taskStore'

const version = (id: string, content: string, date: string): Markdown => ({ ver_id: id, content, created_at: date, model_name: `model-${id}`, style: 'concise' })
const reading = { markdown: [version('reading', 'READING BODY', '2026-10-12T12:00:00Z')] }
const clicked = { markdown: [version('old', 'CLICKED OLD BODY', '2026-10-10T12:00:00Z'), version('new', 'CLICKED NEW BODY', '2026-10-11T12:00:00Z')] }
assert.equal(noteVersions(clicked)[0].ver_id, 'new')
assert.equal(noteExportContent(clicked, noteVersions(clicked)[0].ver_id), 'CLICKED NEW BODY')
assert.equal(noteExportContent(clicked, 'old'), 'CLICKED OLD BODY')
assert.equal(noteExportContent(clicked, 'reading'), '')
assert.equal(noteExportContent(reading, 'reading'), 'READING BODY')
assert.equal(clicked.markdown[0].ver_id, 'old', 'version sorting must preserve the stored array')
assert.equal(noteExportContent({ markdown: 'legacy body' }, ''), 'legacy body')
assert.equal(noteExportContent({ markdown: 'loading' }, ''), '')
assert.equal(noteExportContent({ markdown: 'empty' }, ''), '')
assert.deepEqual(noteVersions({ markdown: [] }), [])
assert.deepEqual(noteMenuPosition({ left: 300, right: 326, top: 200, bottom: 228 }, { width: 248, height: 156 }, { width: 800, height: 600 }), { left: 78, top: 232 })
assert.deepEqual(noteMenuPosition({ left: 8, right: 34, top: 570, bottom: 598 }, { width: 248, height: 156 }, { width: 320, height: 600 }), { left: 8, top: 410 })
assert.deepEqual(noteMenuPosition({ left: 300, right: 326, top: 16, bottom: 44 }, { width: 248, height: 156 }, { width: 320, height: 120 }), { left: 64, top: 8 })
const closed = renderToStaticMarkup(<NoteActionsPopover title="clicked note" open={false} onOpenChange={() => {}} actions={[{ label: '导出', icon: null, onSelect: () => {} }]} />)
assert.match(closed, /aria-expanded="false"/)
assert.match(closed, /aria-haspopup="menu"/)
assert.match(closed, /absolute right-1 top-1/)
assert.doesNotMatch(closed, /role="menu"|<details|<summary/)
console.log('note-actions: target/version export, legacy note, popup bounds and closed row checks passed')
