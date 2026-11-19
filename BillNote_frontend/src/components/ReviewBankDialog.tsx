import { useEffect, useState } from 'react'
import { AlertTriangle, BookMarked, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchReviewBank, type ReviewBankItem, type ReviewBankResponse } from '@/services/note'
import { useTaskStore } from '@/store/taskStore'
import { useNavigate } from 'react-router-dom'

type FilterKind = 'all' | 'wrong_quiz' | 'pit'

export default function ReviewBankDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const [kind, setKind] = useState<FilterKind>('all')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<ReviewBankResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError('')
    void fetchReviewBank({ kind, limit: 80 })
      .then(result => {
        if (active) setData(result)
      })
      .catch(() => {
        if (active) setError('暂无法读取复习库，请稍后重试')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    const visibleItems = (data?.items || []).filter(item => {
    if (kind === 'all') return true
    if (kind === 'wrong_quiz') return item.kind === 'wrong_quiz'
    return item.kind === 'pit_annotation'
  })

  return () => { active = false }
  }, [open, kind])

  const openNote = (item: ReviewBankItem) => {
    useTaskStore.getState().setCurrentTask(item.task_id)
    onOpenChange(false)
    navigate('/?view=read')
  }

  const visibleItems = (data?.items || []).filter(item => {
    if (kind === 'all') return true
    if (kind === 'wrong_quiz') return item.kind === 'wrong_quiz'
    return item.kind === 'pit_annotation'
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[82dvh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookMarked size={17} strokeWidth={1.6} />
            <span>错题与高频避坑回顾</span>
          </DialogTitle>
          <DialogDescription>
            汇总全库未答对的自测题与重点避坑批注，点击可直达对应笔记。
          </DialogDescription>
        </DialogHeader>

        <div className="codex-segmented shrink-0" role="tablist" aria-label="复习类型" data-active-index={kind === 'all' ? 0 : kind === 'wrong_quiz' ? 1 : 2} style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {([
            { id: 'all', label: `全部${data ? ` (${data.total})` : ''}` },
            { id: 'wrong_quiz', label: `错题${data ? ` (${data.wrong_quiz_count})` : ''}` },
            { id: 'pit', label: `高频避坑${data ? ` (${data.pit_count})` : ''}` },
          ] as const).map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={kind === tab.id}
              className={`codex-segmented-tab text-xs ${kind === tab.id ? 'is-active' : ''}`}
              onClick={() => setKind(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1" role="tabpanel" aria-label="复习条目列表">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
              <Loader2 size={15} className="animate-spin" />
              <span>正在汇总复习条目…</span>
            </div>
          ) : error ? (
            <p className="py-10 text-center text-xs text-destructive" role="alert">{error}</p>
          ) : !visibleItems.length ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <CheckCircle2 size={22} strokeWidth={1.5} className="opacity-60" />
              <p className="text-xs">暂无待复习条目</p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--surface-hairline)]">
              {visibleItems.map((item, idx) => (
                <article key={`${item.task_id}-${item.section_id}-${idx}`} className="py-3 first:pt-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 font-medium text-foreground">
                          {item.kind === 'wrong_quiz' ? '错题' : <><AlertTriangle size={11} strokeWidth={1.7} />避坑</>}
                        </span>
                        <span className="truncate">{item.note_title}</span>
                        {item.section_title && <span className="truncate opacity-75">· {item.section_title}</span>}
                      </div>
                      <p className="mt-1.5 text-[13px] font-medium leading-snug text-foreground">
                        {item.kind === 'wrong_quiz' ? item.question : item.hint || item.detail}
                      </p>
                      {item.kind === 'wrong_quiz' && (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          已选 {item.picked_key || '-'} · 正解 {item.correct_key || '-'}
                          {item.explanation ? ` — ${item.explanation}` : ''}
                        </p>
                      )}
                      {item.kind === 'pit_annotation' && item.detail && item.detail !== item.hint && (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="workspace-topbar-btn shrink-0"
                      title="打开对应笔记"
                      onClick={() => openNote(item)}
                    >
                      <ExternalLink size={13} strokeWidth={1.6} />
                      <span>定位</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
