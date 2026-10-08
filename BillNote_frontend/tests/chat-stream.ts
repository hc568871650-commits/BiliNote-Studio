import assert from 'node:assert/strict'
import { readEventStream } from '../src/utils/eventStream'
import { quotePreview } from '../src/utils/quotePreview'
import { activeReadingMessages } from '../src/utils/readingContext'
import { askQuestionStream, setChatStreamTransport } from '../src/services/chatStream'
const encoder = new TextEncoder()
const wire = ': heartbeat\r\n\r\ndata: {"type":"delta","text":"中文🙂"}\r\n\r\ndata: {"type":"done","result":{"answer":"中文🙂","sources":[]}}\r\n\r\n'
const bytes = encoder.encode(wire)
let cancelled = false
const response = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1)) }, cancel() { cancelled = true } }))
const events: string[] = []
await readEventStream(response, event => { events.push(event.type); if (event.type === 'delta') assert.equal(event.text, '中文🙂'); return event.type === 'done' })
assert.deepEqual(events, ['delta', 'done'])
assert(cancelled, 'done cancels the reader without waiting for EOF')
let closed = false
await assert.rejects(readEventStream(new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"type":"error","msg":"502"}\n\n')) }, cancel() { closed = true } })), event => { throw new Error(event.msg) }), /502/)
assert(closed, 'error releases reader')
const abort = new AbortController()
let blockedClosed = false
const blocked = new Response(new ReadableStream({ cancel() { blockedClosed = true } }))
const waiting = readEventStream(blocked, () => {}, abort.signal)
abort.abort()
await assert.rejects(waiting, { name: 'AbortError' })
assert(blockedClosed, 'cancel interrupts a pending read')
assert.equal(quotePreview('# 第一个段落\n另一个段落'), '第一个段落')
assert.equal(Array.from(quotePreview('🙂'.repeat(30))).length, 20)
assert.equal(activeReadingMessages({ messages: [{ id: 'u', role: 'user', content: '问题' }, { id: 'a', role: 'assistant', content: '未完成', incomplete: true }], input: '', attachments: [] }).length, 1)
const payload = { task_id: 'sample', question: 'test', provider_id: 'sample', model_name: 'sample', history: [] }
let calls = 0
setChatStreamTransport(async () => { calls++; return new Response('data: {"type":"delta","text":"partial"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) })
let partial = ''
await assert.rejects(askQuestionStream(payload, event => { partial += event.text || '' }), /未收到完整结果/)
assert.equal(partial, 'partial')
assert.equal(calls, 1, 'no silent non-stream retry on premature EOF')
setChatStreamTransport(async () => new Response('data: {"type":"done","result":{"answer":"ok","sources":[]}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
assert.equal((await askQuestionStream(payload, () => {})).answer, 'ok')
setChatStreamTransport(async () => new Response('data: {"type":"error","msg":"502","data":{"error_details":{"http_status":502}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
await assert.rejects(askQuestionStream(payload, () => {}), (error: any) => error.data.error_details.http_status === 502)
console.log('PASS: SSE byte boundaries/UTF-8/CRLF/heartbeat/done/error/cancel; quote preview; interrupted context')
