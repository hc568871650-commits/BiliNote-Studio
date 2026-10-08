import type { ChatStreamEvent } from '@/services/chatStream'

export async function readEventStream(response: Response, onEvent: (event: ChatStreamEvent) => boolean | void, signal?: AbortSignal) {
  if (!response.body) throw new Error('流式响应为空')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const processFrame = (frame: string) => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return false
    const event = JSON.parse(data) as ChatStreamEvent
    if (!['start', 'status', 'delta', 'done', 'error'].includes(event.type)) throw new Error('流式事件格式异常')
    return Boolean(onEvent(event))
  }
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('已停止回复', 'AbortError')
      const { value, done } = await reader.read()
      if (signal?.aborted) throw new DOMException('已停止回复', 'AbortError')
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 2 * 1024 * 1024) throw new Error('流式事件过大')
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (processFrame(frame)) return
      }
      if (done) { if (buffer.trim()) processFrame(buffer); return }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
