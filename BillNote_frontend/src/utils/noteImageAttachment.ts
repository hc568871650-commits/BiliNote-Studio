import { MAX_IMAGE_BYTES, readAttachment } from '@/utils/readingAttachments'
import type { ReadingAttachment } from '@/store/readingAssistantStore'

export interface NoteImageInput { src: string; alt: string; taskId: string; versionId: string; title: string; blockId?: string }
const imageTypes: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export function noteImageUrl(src: string, taskId: string, apiBase: string, pageOrigin: string) {
  const url = new URL(src, pageOrigin)
  const backend = new URL(apiBase || '/api', pageOrigin)
  const notePath = `/api/notes/${encodeURIComponent(taskId)}/assets/images/`
  const owned = url.pathname.startsWith(notePath)
  const legacy = /^\/static\/(screenshots|cover)\/[^/]+$/.test(url.pathname)
  if (url.origin !== backend.origin || url.username || url.password || (!owned && !legacy)) {
    throw new Error('此图片不是本篇的本地资源，请用附件按钮添加图片')
  }
  return url
}

export async function readNoteImage(input: NoteImageInput, signal: AbortSignal): Promise<ReadingAttachment> {
  const url = noteImageUrl(input.src, input.taskId, import.meta.env.VITE_API_BASE_URL || '/api', window.location.origin)
  let response: Response
  // A thumbnail may have cached an opaque cross-origin response. Read a fresh
  // CORS response when turning the explicitly selected image into an attachment.
  try { response = await fetch(url.href, { signal, credentials: 'omit', cache: 'no-store' }) }
  catch (error) {
    if (signal.aborted) throw error
    throw new Error('图片读取失败，请检查连接后重试')
  }
  if (!response.ok) throw new Error('图片读取失败，请重新打开图片后再试')
  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase().trim()
  if (!imageTypes[type]) throw new Error('目前支持 PNG、JPEG、WebP、GIF 图片')
  if (Number(response.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) throw new Error('每张图片最多 2 MB，请压缩后再添加')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const reader = response.body?.getReader()
  let size = 0
  if (reader) {
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('每张图片最多 2 MB，请压缩后再添加') }
        chunks.push(new Uint8Array(part.value))
      }
    } finally { reader.releaseLock() }
  } else {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('每张图片最多 2 MB，请压缩后再添加')
    chunks.push(new Uint8Array(bytes))
  }
  signal.throwIfAborted()
  const file = new File(chunks, `${input.alt.trim().slice(0, 100) || '笔记截图'}.${imageTypes[type]}`, { type })
  if (!file.size) throw new Error('图片内容为空，请重新打开图片后再试')
  const attachment = await readAttachment(file)
  signal.throwIfAborted()
  return { ...attachment, taskId: input.taskId, versionId: input.versionId, blockId: input.blockId,
    imageSource: { path: url.pathname, title: input.title,
      timestamp: input.alt.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/)?.[0] } }
}
