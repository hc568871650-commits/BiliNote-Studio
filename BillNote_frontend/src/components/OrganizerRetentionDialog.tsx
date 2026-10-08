import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { OrganizerRetentionPreview } from '@/services/organizer'
import '@/pages/OrganizerPage/organizer.css'

export default function OrganizerRetentionDialog({ preview, busy, error, onCancel, onConfirm }: {
  preview: OrganizerRetentionPreview | null; busy: boolean; error?: string | null
  onCancel: () => void; onConfirm: () => void
}) {
  return <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open && !busy) onCancel() }}>
    <DialogContent className="organizer-retention-dialog" showCloseButton={!busy}>
      <DialogTitle>确认清理旧整理对话</DialogTitle>
      {preview && <p className="text-sm">{preview.operation === 'create' ? `已达到保留上限 ${preview.limit} 个。新建对话将覆盖最早的 ${preview.required_count} 个旧会话。` : `将保留数量从 ${preview.current_limit} 个调整为 ${preview.limit} 个，需要覆盖 ${preview.required_count} 个旧会话。`}</p>}
      <DialogDescription>将清理以下会话及聊天记录，待审批计划将作废，该对话中的撤销入口也会丢失。笔记、文件夹、已完成的整理结果不变，操作审计仍保留。</DialogDescription>
      <ul className="organizer-retention-list">{preview?.evictions.map(item => <li key={item.session_id}><strong>{item.title || '新对话'}</strong><span>{new Date(item.updated_at * 1000).toLocaleString('zh-CN')} · {item.message_count} 条消息</span>{item.has_pending_plan && <span>待确认计划将作废</span>}{item.loses_undo && <span>此会话的撤销入口将移除</span>}</li>)}</ul>
      {error && <p role="alert" className="organizer-error">{error}</p>}
      <div className="organizer-retention-actions"><button disabled={busy} onClick={onCancel}>取消</button><button className="organizer-primary" disabled={busy} onClick={onConfirm}>{busy ? '正在处理…' : '确认清理并继续'}</button></div>
    </DialogContent>
  </Dialog>
}
