import assert from 'node:assert/strict'
import request from '@/utils/request'
import { defaultLibraryEntry, useLibraryStore } from '@/store/libraryStore'
import { hasReadableContent } from '@/utils/readingStatus'
import { filterAndSortLibraryTasks, defaultLibraryFilters } from '@/utils/libraryFilters'
import type { Task } from '@/store/taskStore'
import type { NoteLibraryEntry } from '@/services/noteLibrary'

let remote: Record<string, NoteLibraryEntry> = {}
let writes = 0
let fail = false
let hold: Promise<void> | undefined
request.defaults.suppressToast = true
request.defaults.adapter = async config => {
  assert.equal(config.url, '/note_library/update', 'Tests must never call another API')
  writes++
  if (hold) await hold
  if (fail) throw new Error('Simulated save failure')
  const { task_ids, changes } = JSON.parse(config.data)
  for (const id of task_ids) remote[id] = { ...defaultLibraryEntry(), ...remote[id], ...changes }
  return { data: { code: 0, data: { entries: structuredClone(remote) } }, status: 200, statusText: 'OK', headers: {}, config }
}
const reset = (status: 'unread' | 'learning' | 'done') => {
  remote = { note: { ...defaultLibraryEntry(), learning_status: status } }
  useLibraryStore.setState({ entries: structuredClone(remote), loadState: 'ready', isMutating: false })
  writes = 0
  fail = false
  hold = undefined
}
async function run() {
  assert.equal(hasReadableContent({ markdown: '' }), false)
  assert.equal(hasReadableContent({ markdown: '  ' }), false)
  assert.equal(hasReadableContent({ markdown: 'loading' }), false)
  assert.equal(hasReadableContent({ markdown: '# A real note' }), true)
  const readable = { id: 'readable', markdown: '# Note', status: 'SUCCESS', createdAt: '2026-10-01', audioMeta: { title: 'Note' } } as Task
  const failed = { ...readable, id: 'failed', status: 'FAILED', markdown: '' }
  assert.deepEqual(filterAndSortLibraryTasks([failed, readable], {}, { ...defaultLibraryFilters, learningStatus: 'unread' }).map(task => task.id), ['readable'], 'Reading filters exclude failed tasks without content')
  reset('unread')
  await Promise.all([useLibraryStore.getState().startReading('note'), useLibraryStore.getState().startReading('note')])
  assert.equal(writes, 1, 'Repeated scroll callbacks must only start once')
  assert.equal(remote.note.learning_status, 'learning')
  reset('done')
  await useLibraryStore.getState().startReading('note')
  assert.equal(writes, 0, 'Re-reading must preserve completion')
  reset('unread')
  let release!: () => void
  hold = new Promise<void>(resolve => { release = resolve })
  const manual = useLibraryStore.getState().updateEntries(['note'], { learning_status: 'done' })
  const auto = useLibraryStore.getState().startReading('note')
  release()
  await Promise.all([manual, auto])
  assert.equal(remote.note.learning_status, 'done', 'Queued automatic update cannot overwrite manual completion')
  assert.equal(writes, 1)
  reset('unread')
  await Promise.all([useLibraryStore.getState().startReading('note'), useLibraryStore.getState().updateEntries(['note'], { learning_status: 'done' })])
  assert.equal(remote.note.learning_status, 'done', 'Explicit completion wins after an automatic update')
  reset('unread')
  fail = true
  await assert.rejects(useLibraryStore.getState().startReading('note'))
  assert.equal(useLibraryStore.getState().entries.note.learning_status, 'unread', 'Failed write must preserve old state')
  assert.equal(useLibraryStore.getState().isMutating, false)
  fail = false
  await useLibraryStore.getState().updateEntries(['note'], { learning_status: 'done' })
  assert.equal(remote.note.learning_status, 'done', 'Manual retry must work after failure')
  reset('unread')
  useLibraryStore.setState({ loadState: 'error' })
  await useLibraryStore.getState().startReading('note')
  assert.equal(writes, 0, 'Do not overwrite state before metadata has loaded')
  console.log('PASS: readable content, repeated scroll, completion preservation, both write orders, failed save, retry, unloaded metadata')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
