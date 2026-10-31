import { AxiosHeaders } from 'axios'
import type { AskPayload } from '@/services/chat'
import { previewAdapter } from './previewMock'

export function previewChatStream(payload: AskPayload, signal: AbortSignal): Promise<Response> {
  let cancelled = false
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: object) => { if (!cancelled && !signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
      try {
        emit({ type: 'start' })
        const response = await previewAdapter({ url: '/chat/ask', method: 'post', data: JSON.stringify(payload), signal, headers: new AxiosHeaders() })
        if (response.data.code !== 0) throw response.data
        const result = response.data.data
        if (result.tool_events?.length) {
          const progress = '我先检索资料，再核对相关网页。'
          result.work_log = [progress]
          emit({ type: 'delta', text: progress })
          emit({ type: 'work_log', text: progress })
          emit({ type: 'status', phase: 'searching' })
        }
        for (const record of result.tool_events || []) emit({ type: 'tool_event', event: record })
        emit({ type: 'status', phase: 'generating' })
        // Synthetic UI demonstration; no provider request or production fallback.
        const text = Array.from(result.answer as string)
        for (let offset = 0; offset < text.length; offset += 10) {
          if (cancelled || signal.aborted) return
          emit({ type: 'delta', text: text.slice(offset, offset + 10).join('') })
          await new Promise<void>(resolve => {
            const release = () => { clearTimeout(timer); signal.removeEventListener('abort', release); resolve() }
            const timer = setTimeout(release, 55)
            signal.addEventListener('abort', release, { once: true })
          })
        }
        emit({ type: 'done', result })
      } catch (error) {
        const failure = error as { msg?: string; message?: string; data?: unknown }
        emit({ type: 'error', msg: failure.msg || failure.message || '模拟回复失败', data: failure.data })
      } finally {
        if (!cancelled) controller.close()
      }
    },
    cancel() { cancelled = true },
  })
  return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
}
