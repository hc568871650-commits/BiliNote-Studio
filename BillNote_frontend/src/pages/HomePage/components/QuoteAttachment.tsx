import { X } from 'lucide-react'
import type { ReadingAttachment } from '@/store/readingAssistantStore'
import { quoteParts, type QuotePart } from '@/utils/quoteSource'
import { quotePreview } from '@/utils/quotePreview'
import './quote-attachment.css'

interface Props {
  attachment: ReadingAttachment
  onOriginal: (parts: QuotePart[]) => void
  onRemove?: () => void
}

export default function QuoteAttachment({ attachment, onOriginal, onRemove }: Props) {
  const parts = quoteParts(attachment)
  const count = attachment.blockCount || parts.length || 1
  const label = count > 1
    ? `${count}段 · ${quotePreview(attachment.text, 22)}`
    : quotePreview(attachment.text, 28) || '引用'
  const tooltip = attachment.text?.trim()
    ? `${attachment.text.trim().slice(0, 160)}${attachment.text.trim().length > 160 ? '…' : ''}`
    : attachment.name

  return <div className="assistant-quote">
    <button
      type="button"
      className="assistant-quote-content"
      aria-label={`查看引用原文：${quotePreview(attachment.text, 24)}`}
      title={`点击回到原文 · ${tooltip}`}
      onClick={() => onOriginal(parts)}
    >
      {label}
    </button>
    {onRemove && (
      <button
        type="button"
        className="assistant-quote-remove"
        aria-label={`移除引用 ${quotePreview(attachment.text, 12)}`}
        title="移除引用"
        onClick={onRemove}
      >
        <X size={11} strokeWidth={1.6} aria-hidden="true" />
      </button>
    )}
  </div>
}
