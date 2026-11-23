import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowRight, BookmarkPlus, Check, ChevronRight, MessageSquare, X } from 'lucide-react'
import type { ReadingAttachment, ReadingMessage } from '@/store/readingAssistantStore'
import type { QuotePart } from '@/utils/quoteSource'
import type { ReadingRecoveryState } from '@/utils/readingRecovery'
import { chatProtocolLabels } from '@/services/chat'
import SourceList from '@/components/SourceList'
import WorkProgress from '@/components/WorkProgress'
import QuoteAttachment from './QuoteAttachment'

const durationLabel = (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟 ${seconds % 60} 秒`
const remarkPlugins = [remarkGfm]
interface AttachmentActions {
  onQuote: (attachment: ReadingAttachment, parts: QuotePart[]) => void
  onImage: (attachment: ReadingAttachment) => void
  onPreview: (attachment: ReadingAttachment) => void
}
export const ReadingAttachmentCard = memo(function ReadingAttachmentCard({ attachment: a, onQuote, onImage, onPreview, onRemove }: AttachmentActions & { attachment: ReadingAttachment; onRemove?: () => void }) {
  return a.type === 'quote' ? <QuoteAttachment attachment={a} onOriginal={parts => onQuote(a, parts)} onRemove={onRemove} /> : <div className={`assistant-attachment ${a.imageSource ? 'assistant-attachment--note-image' : ''}`} data-removable={Boolean(onRemove)}>
    <button className="assistant-attachment-content" onClick={() => onPreview(a)} title={a.imageSource ? `预览附件 · ${a.imageSource.title}${a.versionId ? ` · ${a.versionId}` : ''}` : '预览附件'}>
      {a.type === 'image' ? <img src={a.data_url} alt={a.name} /> : <MessageSquare size={15} />}
      <span><strong>{a.name}</strong><small>{a.imageSource ? `${a.imageSource.title}${a.versionId ? ` · ${a.versionId.slice(-6)}` : ''}${a.imageSource.timestamp ? ` · ${a.imageSource.timestamp}` : ''}` : a.type === 'image' ? '图片' : a.text?.slice(0, 20)}</small></span>
    </button>{a.imageSource && <button type="button" className="assistant-image-origin" aria-label={`回到原图：${a.name}`} title="回到笔记原图" onClick={() => onImage(a)}><ArrowRight size={13} /></button>}{onRemove && <button className="assistant-attachment-remove" aria-label={`移除 ${a.name}`} onClick={onRemove}><X size={13} /></button>}
  </div>
})

export const ReadingMessageItem = memo(function ReadingMessageItem({ message, recovery = 'unavailable', questionStatus, busy = false, onRestore, onQuote, onImage, onPreview, onSaveAnnotation, savedAsAnnotation = false, savingAnnotation = false }: AttachmentActions & {
  message: ReadingMessage
  recovery?: ReadingRecoveryState
  questionStatus?: ReadingMessage['delivery_status']
  busy?: boolean
  onRestore?: (id: string) => void
  onSaveAnnotation?: (message: ReadingMessage) => void
  savedAsAnnotation?: boolean
  savingAnnotation?: boolean
}) {
  if (message.role === 'user') {
    const compactQuotes = Boolean(message.attachments && message.attachments.length >= 2 && message.attachments.every(item => item.type === 'quote'))
    return <article className="reading-message reading-message--user">
      {!!message.attachments?.length && <div className="reading-message-attachments" data-compact-grid={compactQuotes ? 'true' : undefined}>{message.attachments.map(a => <ReadingAttachmentCard key={a.id} attachment={a} onQuote={onQuote} onImage={onImage} onPreview={onPreview} />)}</div>}
      {message.content.trim() && <div className="reading-user-bubble"><ReactMarkdown remarkPlugins={remarkPlugins}>{message.content}</ReactMarkdown></div>}
    </article>
  }
  return <article className="reading-message reading-message--assistant">
        {(message.elapsed_seconds != null || !!message.sources?.length || message.incomplete) && <details className="reading-reply-details">
          <summary aria-label={message.elapsed_seconds != null ? `用时 ${durationLabel(message.elapsed_seconds)}，展开详情` : '展开回复详情'} title="查看本轮详情"><span>{message.elapsed_seconds != null ? `用时 ${durationLabel(message.elapsed_seconds)}` : ''}{message.request?.web_search_used ? ' · 已联网检索' : ''}</span><ChevronRight size={13} /></summary>
          <div className="reading-reply-detail-content">
            {message.incomplete && <p>回复已中断</p>}
            {message.request?.model_name && <p>{message.request.model_name}{message.request.context_limit != null ? ` · 输入预算 ${message.request.context_limit.toLocaleString()}` : ''}{message.request.output_reserve != null ? ` · 输出预留 ${message.request.output_reserve.toLocaleString()}` : ''}</p>}
            {message.request && <><p>{chatProtocolLabels[message.request.protocol as keyof typeof chatProtocolLabels] || message.request.protocol} · {message.request.stream ? '流式' : '非流式'}</p><p>{message.request.web_search ? `${message.request.web_search_mode === 'external' ? '外部检索' : '原生联网'}：${message.request.web_search_used ? '已返回搜索来源' : '未返回可核验的搜索来源'}` : '本轮未开启联网'}</p>{message.request.request_id && <p>请求 ID：{message.request.request_id}</p>}</>}
            {message.sources?.length ? <SourceList sources={message.sources} /> : !message.incomplete && <p>未返回参考来源</p>}
          </div>
        </details>}
        <WorkProgress entries={message.work_log} events={message.tool_events} />
        {!!message.attachments?.length && <div className="reading-message-attachments">{message.attachments.map(a => <ReadingAttachmentCard key={a.id} attachment={a} onQuote={onQuote} onImage={onImage} onPreview={onPreview} />)}</div>}
        {message.content.trim() ? <ReactMarkdown remarkPlugins={remarkPlugins}>{message.content}</ReactMarkdown> : <p className="reading-chat-error">本轮未收到正文，可恢复原问题后手动重试。</p>}
        {!message.incomplete && message.content.trim() && onSaveAnnotation && (
          <div className="mt-2 flex items-center justify-end">
            <button
              type="button"
              disabled={savingAnnotation || savedAsAnnotation}
              onClick={() => onSaveAnnotation(message)}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--surface-hairline)] bg-[color-mix(in_srgb,var(--surface-raised)_72%,transparent)] px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-[color-mix(in_srgb,var(--reading-accent,var(--primary))_35%,transparent)] hover:text-[var(--reading-accent,var(--primary))] disabled:opacity-60"
            >
              {savedAsAnnotation ? <Check size={12} strokeWidth={1.7} /> : <BookmarkPlus size={12} strokeWidth={1.65} />}
              <span>{savedAsAnnotation ? '已沉淀为批注' : savingAnnotation ? '正在沉淀…' : '沉淀为正文批注'}</span>
            </button>
          </div>
        )}
        {message.incomplete && recovery !== 'unavailable' && <div className="reading-turn-recovery">
          <span>{questionStatus === 'cancelled' ? '已停止' : questionStatus === 'interrupted' ? '已中断' : '回复未完成'}</span>
          <button type="button" disabled={busy || recovery !== 'ready'}
            title={recovery === 'draft-conflict' ? '当前草稿已有内容，请先发送或清空草稿' : '恢复本轮问题、引用和图片，等待手动发送'}
            onClick={() => onRestore?.(message.id)}>{recovery === 'restored' ? '问题已在草稿中' : '恢复问题和附件'}</button>
          {recovery === 'draft-conflict' && <small>请先处理当前草稿</small>}
        </div>}
      </article>
})
