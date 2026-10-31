import type { ReadingAttachment } from '@/store/readingAssistantStore'

export const MAX_ATTACHMENTS = 8
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export function validateReadingAttachments(attachments: ReadingAttachment[]) {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('每条消息最多 8 份引用或附件')
  if (new TextEncoder().encode(JSON.stringify(attachments)).byteLength > MAX_ATTACHMENT_BYTES) throw new Error('本条消息附件总量过大，请减少图片')
}
export async function readAttachment(file: File): Promise<ReadingAttachment> {
  const id = crypto.randomUUID()
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('每张图片最多 2 MB，请压缩后再添加')
    const data_url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file) })
    return { id, type: 'image', name: file.name || '粘贴的图片', data_url }
  }
  if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new Error('目前支持 PNG、JPEG、WebP、GIF 图片和 TXT、Markdown 文本；暂不支持 PDF')
  if (file.size > 200 * 1024) throw new Error('文本附件最多 200 KB')
  const text = await file.text()
  if (!text.trim()) throw new Error('附件内容为空')
  if (text.includes('\u0000') || text.includes('\ufffd')) throw new Error('请使用 UTF-8 编码的文本文件')
  if (text.length > 50000) throw new Error('文本附件最多 5 万字')
  return { id, type: 'text', name: file.name, text }
}
export function wireAttachment(a: ReadingAttachment) {
  return a.type === 'image' ? { type: a.type, name: a.name.slice(0, 200), data_url: a.data_url } : { type: a.type, name: a.name.slice(0, 200), text: a.text }
}
