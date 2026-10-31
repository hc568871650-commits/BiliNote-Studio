import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { get } from 'idb-keyval'
import ChatPanel from '@/pages/HomePage/components/ChatPanel'
import { useReadingAssistantStore as reading, type ReadingAttachment } from '@/store/readingAssistantStore'
import { useInterfaceStore as ui } from '@/store/interfaceStore'
import { useProviderStore as providers } from '@/store/providerStore'
import { activeReadingMessages, wireHistory } from '@/utils/readingContext'
import { setChatStreamTransport, type ChatStreamEvent } from '@/services/chatStream'
import { defaultModelContext } from '@/services/modelContext'
import request from '@/utils/request'
import type { AskPayload } from '@/services/chat'

const model = { provider_id: 'fixture', model_name: 'fixture-model' }
const controls = { reasoning_effort: 'auto' as const, context_limit: 64000, web_search: false, web_search_mode: 'external' as const }
const attachments: ReadingAttachment[] = [
  { id: 'quote', type: 'quote', name: '两段引用', text: '引用第一段\n\n引用第二段', blockCount: 2, taskId: 'fixture', versionId: 'v1' },
  { id: 'image', type: 'image', name: '公开样例.png', data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', taskId: 'fixture', imageSource: { title: '公开测试图', path: '/sample.png' } },
]
const fresh = () => ({ messages: [], input: '', attachments: [], model, controls })
const audit = {
  requests: [] as AskPayload[],
  emit: (_event: ChatStreamEvent) => { void _event },
  close: () => {},
  switchNote: (_id: string) => { void _id },
  seed: () => reading.getState().patch('note:fixture', { ...fresh(), input: '查看这张图与引用', attachments }),
  draft: (input: string, items: ReadingAttachment[] = []) => reading.getState().patch('note:fixture', { input, attachments: items }),
  state: (key = 'note:fixture') => reading.getState().sessions[key],
  history: () => wireHistory(activeReadingMessages(reading.getState().sessions['note:fixture'])),
  saved: async () => JSON.parse(await get('bilinote-reading-assistant-v1')),
}
Object.assign(window, { recoveryAudit: audit })
request.defaults.adapter = async config => ({ data: { code: 0, data: config.url === '/model_capabilities'
  ? { provider_id: 'fixture', model_name: 'fixture-model', protocol: 'openai-chat', features: {}, external_search_available: false }
  : config.url?.startsWith('/model_context') ? defaultModelContext('fixture', 'fixture-model') : [] }, status: 200, statusText: 'OK', headers: {}, config })
setChatStreamTransport(async payload => {
  audit.requests.push(payload)
  return new Response(new ReadableStream({ start(controller) {
    audit.emit = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    audit.close = () => controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
})
export function Harness() {
  const [taskId, setTaskId] = useState('fixture')
  audit.switchNote = setTaskId
  return <BrowserRouter><main style={{ height: '96vh' }}><ChatPanel taskId={taskId} mode="full" onModeChange={() => {}} /></main></BrowserRouter>
}
async function start() {
  await reading.persist.rehydrate()
  await ui.persist.rehydrate()
  ui.setState({ streamReading: true })
  providers.setState({ provider: [{ id: 'fixture', name: '测试服务', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic', enabled: 1, type: 'custom' }] })
  if (!reading.getState().sessions['note:fixture']) reading.getState().patch('note:fixture', fresh())
  reading.getState().patch('note:other', { ...fresh(), input: '另一篇笔记的草稿' })
  createRoot(document.getElementById('root')!).render(<Harness />)
}
void start()
