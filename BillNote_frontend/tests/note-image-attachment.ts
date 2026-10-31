import assert from 'node:assert/strict'
import { noteImageUrl, readNoteImage } from '@/utils/noteImageAttachment'
import { MAX_IMAGE_BYTES, wireAttachment } from '@/utils/readingAttachments'
import { useReadingAssistantStore as store } from '@/store/readingAssistantStore'

const origin = 'http://127.0.0.1:28485'
const backend = 'http://127.0.0.1:29485/api'
const image = 'http://127.0.0.1:29485/api/notes/note-a/assets/images/picture.png'
assert.equal(noteImageUrl(image, 'note-a', backend, origin).pathname, '/api/notes/note-a/assets/images/picture.png')
assert.throws(() => noteImageUrl(image, 'note-b', backend, origin), /本地资源/)
assert.throws(() => noteImageUrl('https://outside.invalid/image.png', 'note-a', backend, origin), /本地资源/)
assert.throws(() => noteImageUrl('file:///C:/private/image.png', 'note-a', backend, origin), /本地资源/)
assert.throws(() => noteImageUrl('http://key:secret@127.0.0.1:29485/static/screenshots/a.png', 'note-a', backend, origin), /本地资源/)
assert.throws(() => noteImageUrl('http://127.0.0.1:29485/api/notes/note-a/assets/images/../_meta/manifest.json', 'note-a', backend, origin), /本地资源/)
assert.equal(noteImageUrl('http://127.0.0.1:29485/static/screenshots/old.png', 'note-a', backend, origin).pathname, '/static/screenshots/old.png')

Object.assign(globalThis, { window: { location: { origin } } })
class LocalFileReader {
  result: string | null = null
  onload?: () => void
  onerror?: () => void
  readAsDataURL(file: File) { void file.arrayBuffer().then(data => { this.result = `data:${file.type};base64,${Buffer.from(data).toString('base64')}`; this.onload?.() }).catch(() => this.onerror?.()) }
}
Object.assign(globalThis, { FileReader: LocalFileReader })
const originalFetch = globalThis.fetch
const input = { src: image, alt: '截图 [00:07]', taskId: 'note-a', versionId: 'v1', title: '教程', blockId: 'note-block-2' }
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
try {
  globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } })
  const attachment = await readNoteImage(input, new AbortController().signal)
  assert.equal(attachment.taskId, 'note-a')
  assert.equal(attachment.versionId, 'v1')
  assert.equal(attachment.imageSource?.timestamp, '00:07')
  assert.ok(attachment.data_url?.startsWith('data:image/png;base64,'))
  assert.deepEqual(Object.keys(wireAttachment(attachment)).sort(), ['data_url', 'name', 'type'], 'Local provenance never becomes backend paths or extra API fields')

  store.setState({ sessions: {} })
  store.getState().patch('note:note-a', { input: '保留已有问题', attachments: [{ id: 'q', type: 'quote', name: '已有引用', text: '原文' }] })
  store.getState().attach('note:note-a', [attachment])
  assert.equal(store.getState().sessions['note:note-a'].input, '保留已有问题')
  assert.equal(store.getState().sessions['note:note-a'].attachments[0].id, 'q')
  assert.equal(store.getState().sessions['note:note-b'], undefined)
  for (let index = 0; index < 6; index++) store.getState().attach('note:note-a', [{ ...attachment, id: `i-${index}` }])
  assert.throws(() => store.getState().attach('note:note-a', [attachment]), /8 份/)
  assert.equal(store.getState().sessions['note:note-a'].attachments.length, 8)
  store.getState().patch('note:large', { attachments: [{ ...attachment, data_url: 'x'.repeat(5 * 1024 * 1024) }] })
  assert.throws(() => store.getState().attach('note:large', [{ ...attachment, data_url: 'x'.repeat(4 * 1024 * 1024) }]), /总量过大/)
  assert.equal(store.getState().sessions['note:large'].attachments.length, 1, 'Rejected atomic append preserves prior draft')

  globalThis.fetch = async () => new Response('missing', { status: 404 })
  await assert.rejects(readNoteImage(input, new AbortController().signal), /读取失败/)
  globalThis.fetch = async () => new Response('svg', { headers: { 'content-type': 'image/svg+xml' } })
  await assert.rejects(readNoteImage(input, new AbortController().signal), /PNG/)
  globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) } })
  await assert.rejects(readNoteImage(input, new AbortController().signal), /2 MB/)
  globalThis.fetch = async () => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { 'content-type': 'image/png' } })
  await assert.rejects(readNoteImage(input, new AbortController().signal), /2 MB/, 'Streaming cap works without Content-Length')
  globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(readNoteImage(input, cancelled.signal), /abort/i)
  console.log('PASS note images: owned URLs, limits, cancellation, draft preservation, atomic caps, source identity and wire stripping')
} finally { globalThis.fetch = originalFetch }
