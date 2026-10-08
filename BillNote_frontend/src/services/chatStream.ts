import request from '@/utils/request'
import type { AskPayload, AskResponse, ChatErrorDetails } from './chat'
import { readEventStream } from '@/utils/eventStream'

export interface ChatStreamEvent { type: 'start' | 'status' | 'delta' | 'done' | 'error'; text?: string; phase?: string; reset_text?: boolean; result?: AskResponse; msg?: string; data?: { error_details?: ChatErrorDetails } }
type StreamTransport = (payload: AskPayload, signal: AbortSignal) => Promise<Response>
let previewTransport: StreamTransport | undefined
// Installed only by the isolated preview entry; production never imports fixtures.
export const setChatStreamTransport = (transport: StreamTransport) => { previewTransport = transport }

export async function askQuestionStream(payload: AskPayload, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<AskResponse> {
  const abort = new AbortController()
  const cancel = () => abort.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  let timer: ReturnType<typeof setTimeout>
  const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; abort.abort() }, 120000) }
  armTimeout()
  let result: AskResponse | undefined
  try {
    const base = String(request.defaults.baseURL || '/api').replace(/\/$/, '')
    const response = await (previewTransport ? previewTransport(payload, abort.signal) : fetch(`${base}/chat/ask/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(payload), signal: abort.signal,
    }))
    if (!response.ok) {
      let error: { msg?: string; detail?: unknown } = {}
      try { error = await response.json() } catch { /* Non-JSON HTTP response. */ }
      throw { ...error, msg: error.msg || (typeof error.detail === 'string' ? error.detail : `流式请求失败 · HTTP ${response.status}`) }
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务未返回流式回复')
    await readEventStream(response, event => {
      armTimeout()
      if (event.type === 'error') throw event
      if (event.type === 'done') {
        if (typeof event.result?.answer !== 'string' || !event.result.answer.trim()) throw new Error('模型未返回有效回答')
        result = event.result
      }
      onEvent(event)
      return event.type === 'done'
    }, abort.signal)
    if (!result) throw new Error('回复连接中断，未收到完整结果')
    return result
  } catch (error) {
    if (timedOut) throw { msg: '回复等待超时', data: { error_details: { http_status: null, upstream_code: null, request_id: null, occurred_at: new Date().toISOString(), kind: 'client_timeout', detail: '连续 120 秒未收到流式数据，模型服务可能仍在处理。', protocol: payload.protocol || 'openai-chat' } } }
    throw error
  } finally {
    clearTimeout(timer!); signal?.removeEventListener('abort', cancel)
  }
}
