import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  BookMarked,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react'
import { toast } from 'react-hot-toast'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  fetchReviewBank,
  submitReviewQuizPractice,
  updateReviewPitStatus,
  type ReviewBankItem,
  type ReviewBankResponse,
} from '@/services/note'
import { useTaskStore } from '@/store/taskStore'
import { useSourceNavigationStore } from '@/store/sourceNavigationStore'
import { useNavigate } from 'react-router-dom'

type FilterKind = 'all' | 'wrong_quiz' | 'pit'
type ReviewStatusFilter = 'pending' | 'mastered'

const FILTER_TABS: readonly FilterKind[] = ['all', 'wrong_quiz', 'pit']

const REVIEW_ACTION_BTN = 'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[var(--surface-border)] bg-[color-mix(in_srgb,var(--surface-raised)_82%,transparent)] px-2.5 text-[11.5px] font-medium text-foreground whitespace-nowrap transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-45'
const REVIEW_ACTION_ACCENT_BTN = 'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--reading-accent,var(--primary))_38%,transparent)] bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_12%,transparent)] px-2.5 text-[11.5px] font-medium text-[var(--reading-accent,var(--primary))] whitespace-nowrap transition-colors hover:bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_20%,transparent)] disabled:opacity-45'

function itemKeyOf(item: ReviewBankItem, idx: number): string {
  if (item.kind === 'wrong_quiz') {
    return `quiz:${item.task_id}:${item.section_id}`
  }
  return `pit:${item.task_id}:${item.section_id}:${item.annotation_id || idx}`
}

export default function ReviewBankDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const [kind, setKind] = useState<FilterKind>('all')
  const [statusFilter, setStatusFilter] = useState<ReviewStatusFilter>('pending')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<ReviewBankResponse | null>(null)
  const [error, setError] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({})
  const [practicePicked, setPracticePicked] = useState<Record<string, { key: string; isCorrect: boolean }>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const loadBank = useCallback(async (targetStatus: ReviewStatusFilter) => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchReviewBank({ kind: 'all', status: targetStatus, limit: 200 })
      setData(result)
    } catch {
      setError('暂无法读取复习库，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setExpandedKeys({})
    setPracticePicked({})
    void loadBank(statusFilter)
  }, [open, statusFilter, loadBank])

  const openNote = (item: ReviewBankItem) => {
    useTaskStore.getState().setCurrentTask(item.task_id)
    useSourceNavigationStore.getState().open({
      note_id: item.task_id,
      version_id: item.version_id || undefined,
      section_id: item.section_id || undefined,
      section_title: item.section_title || undefined,
      quiz_id: item.kind === 'wrong_quiz' ? (item.quiz_id || item.section_id) : undefined,
      annotation_id: item.kind === 'pit_annotation' ? item.annotation_id : undefined,
    })
    onOpenChange(false)
    navigate('/?view=read')
  }

  const toggleExpand = (key: string) => {
    setExpandedKeys(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handlePracticePick = async (item: ReviewBankItem, itemKey: string, optionKey: string) => {
    if (busyKey) return
    setBusyKey(itemKey)
    try {
      const result = await submitReviewQuizPractice({
        task_id: item.task_id,
        section_id: item.section_id,
        selected_key: optionKey,
      })
      setPracticePicked(prev => ({
        ...prev,
        [itemKey]: { key: optionKey, isCorrect: result.is_correct },
      }))
    } catch {
      const fallbackCorrect = Boolean(item.correct_key && optionKey === item.correct_key)
      setPracticePicked(prev => ({
        ...prev,
        [itemKey]: { key: optionKey, isCorrect: fallbackCorrect },
      }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleToggleMastered = async (item: ReviewBankItem, itemKey: string, nextMastered: boolean) => {
    if (busyKey) return
    setBusyKey(itemKey)
    try {
      if (item.kind === 'wrong_quiz') {
        await submitReviewQuizPractice({
          task_id: item.task_id,
          section_id: item.section_id,
          mastered: nextMastered,
        })
      } else if (item.annotation_id) {
        await updateReviewPitStatus({
          task_id: item.task_id,
          section_id: item.section_id,
          annotation_id: item.annotation_id,
          mastered: nextMastered,
        })
      }
      toast.success(nextMastered ? '已标为掌握' : '已移回待复习')
      await loadBank(statusFilter)
    } catch {
      toast.error('更新复习状态失败，请稍后重试')
    } finally {
      setBusyKey(null)
    }
  }

  const activeIndex = FILTER_TABS.indexOf(kind)
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? FILTER_TABS.length - 1
        : (activeIndex + (event.key === 'ArrowRight' ? 1 : -1) + FILTER_TABS.length) % FILTER_TABS.length
    setKind(FILTER_TABS[nextIndex])
  }

  const visibleItems = (data?.items || []).filter(item => {
    if (kind === 'all') return true
    if (kind === 'wrong_quiz') return item.kind === 'wrong_quiz'
    return item.kind === 'pit_annotation'
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[84dvh] flex flex-col gap-3">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex items-center gap-2">
              <BookMarked size={17} strokeWidth={1.6} />
              <span>错题与高频避坑回顾</span>
            </DialogTitle>
            <div
              className="inline-flex items-center rounded-full border border-[var(--surface-hairline)] bg-[var(--surface-input)] p-[3px] text-[11px]"
              role="radiogroup"
              aria-label="复习状态筛选"
            >
              <button
                type="button"
                role="radio"
                aria-checked={statusFilter === 'pending'}
                className={`inline-flex items-center justify-center rounded-full px-2.5 py-1 leading-none transition-colors ${statusFilter === 'pending' ? 'bg-[var(--surface-raised)] font-medium text-[var(--reading-accent,var(--primary))] shadow-[inset_0_0_0_1px_var(--surface-hairline)]' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setStatusFilter('pending')}
              >
                待复习{typeof data?.pending_total === 'number' ? ` (${data.pending_total})` : ''}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={statusFilter === 'mastered'}
                className={`inline-flex items-center justify-center rounded-full px-2.5 py-1 leading-none transition-colors ${statusFilter === 'mastered' ? 'bg-[var(--surface-raised)] font-medium text-[var(--reading-accent,var(--primary))] shadow-[inset_0_0_0_1px_var(--surface-hairline)]' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setStatusFilter('mastered')}
              >
                已掌握{typeof data?.mastered_total === 'number' ? ` (${data.mastered_total})` : ''}
              </button>
            </div>
          </div>
          <DialogDescription>
            点击卡片即可展开重练或自检；点击定位直达原笔记对应位置。
          </DialogDescription>
        </DialogHeader>

        <div
          className="codex-segmented shrink-0"
          role="tablist"
          aria-label="复习类型"
          data-active-index={activeIndex}
          style={{ '--segment-count': 3, '--segment-index': activeIndex } as CSSProperties}
          onKeyDown={handleTabKeyDown}
        >
          <span className="codex-segmented-thumb" aria-hidden="true" />
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

        <div key={`${statusFilter}:${kind}`} className="codex-segmented-panel min-h-0 flex-1 overflow-y-auto px-0.5 pr-2" role="tabpanel" aria-label="复习条目列表">
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
              <p className="text-xs">{statusFilter === 'pending' ? '当前没有待复习条目' : '暂未标记已掌握条目'}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 pb-1">
              {visibleItems.map((item, idx) => {
                const key = itemKeyOf(item, idx)
                const isExpanded = Boolean(expandedKeys[key])
                const picked = practicePicked[key]
                const busy = busyKey === key
                const isMastered = Boolean(item.mastered)
                const hasOptions = item.kind === 'wrong_quiz' && Array.isArray(item.options) && item.options.length > 0

                return (
                  <article
                    key={key}
                    className={`rounded-xl border transition-colors ${
                      isExpanded
                        ? 'border-[var(--surface-border)] bg-[color-mix(in_srgb,var(--surface-raised)_78%,transparent)]'
                        : 'border-[var(--surface-hairline)] bg-[color-mix(in_srgb,var(--surface-raised)_62%,transparent)] hover:border-[var(--surface-border)] hover:bg-[color-mix(in_srgb,var(--surface-raised)_74%,transparent)]'
                    }`}
                  >
                    <div
                      className="cursor-pointer p-3"
                      onClick={() => toggleExpand(key)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 font-medium text-foreground">
                            {item.kind === 'wrong_quiz' ? '错题' : <><AlertTriangle size={11} strokeWidth={1.7} />避坑</>}
                          </span>
                          <span className="truncate font-medium text-foreground/85">{item.note_title}</span>
                          {item.section_title && <span className="truncate opacity-75">· {item.section_title}</span>}
                          {item.review_count ? <span className="opacity-65">· 复习 {item.review_count} 次</span> : null}
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            className={REVIEW_ACTION_BTN}
                            title="直达原笔记定位"
                            onClick={(event) => {
                              event.stopPropagation()
                              openNote(item)
                            }}
                          >
                            <ExternalLink size={12} strokeWidth={1.65} />
                            <span>定位</span>
                          </button>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? '收起条目' : '展开条目'}
                            title={isExpanded ? '收起' : '展开'}
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleExpand(key)
                            }}
                          >
                            <ChevronDown size={14} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                          </button>
                        </div>
                      </div>

                      <p className="mt-2 text-[13px] font-medium leading-relaxed text-foreground">
                        {item.kind === 'wrong_quiz' ? item.question : item.hint || item.detail}
                      </p>
                    </div>

                    {/* 错题原位重练区：三级判题层次 */}
                    {item.kind === 'wrong_quiz' && isExpanded && (
                      <div className="space-y-2 border-t border-[var(--surface-hairline)] px-3 pt-2.5 pb-3">
                        {hasOptions ? (
                          <div className="space-y-1.5">
                            {item.options!.map(opt => {
                              const answered = Boolean(picked)
                              const isCorrectOpt = opt.key === item.correct_key
                              const isPickedWrong = answered && picked?.key === opt.key && !picked.isCorrect
                              const isCrossedOut = answered && !isCorrectOpt && !isPickedWrong

                              let optClass = 'border-[var(--surface-hairline)] bg-[var(--surface-page)]/70 hover:border-[var(--reading-accent,var(--primary))]'
                              if (answered && isCorrectOpt) {
                                optClass = 'border-[color-mix(in_srgb,var(--reading-accent,var(--primary))_40%,transparent)] bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_14%,transparent)] font-medium'
                              } else if (isPickedWrong) {
                                optClass = 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                              } else if (isCrossedOut) {
                                optClass = 'border-transparent bg-transparent opacity-40 line-through'
                              }

                              return (
                                <button
                                  key={opt.key}
                                  type="button"
                                  disabled={answered || busy}
                                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${optClass}`}
                                  onClick={() => void handlePracticePick(item, key, opt.key)}
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)] font-mono text-[11px] font-semibold">
                                      {opt.key}
                                    </span>
                                    <span className="min-w-0 leading-snug">{opt.text}</span>
                                  </span>
                                  {answered && isCorrectOpt && <Check size={14} className="shrink-0 text-[var(--reading-accent,var(--primary))]" />}
                                  {isPickedWrong && <X size={14} className="shrink-0 text-red-500" />}
                                </button>
                              )
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            上次作答 {item.picked_key || '-'} · 正确答案 {item.correct_key || '-'}
                          </p>
                        )}

                        {(picked || !hasOptions) && item.explanation && (
                          <p className="rounded-lg bg-[var(--surface-input)] px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                            <strong className="mr-1 font-medium text-foreground">解析：</strong>
                            {item.explanation}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                          {picked && !picked.isCorrect && (
                            <button
                              type="button"
                              className={REVIEW_ACTION_BTN}
                              onClick={() => setPracticePicked(prev => {
                                const next = { ...prev }
                                delete next[key]
                                return next
                              })}
                            >
                              <RotateCcw size={12} />
                              <span>再试一次</span>
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            className={isMastered ? REVIEW_ACTION_BTN : REVIEW_ACTION_ACCENT_BTN}
                            onClick={() => void handleToggleMastered(item, key, !isMastered)}
                          >
                            <CheckCircle2 size={12} />
                            <span>{isMastered ? '移回待复习' : '标为已掌握'}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 高频避坑翻卡自检区 */}
                    {item.kind === 'pit_annotation' && isExpanded && (
                      <div className="space-y-2 border-t border-[var(--surface-hairline)] px-3 pt-2.5 pb-3">
                        <p className="rounded-lg bg-[var(--surface-input)] px-2.5 py-2 text-xs leading-relaxed text-foreground/90">
                          {item.detail || item.hint}
                        </p>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>{item.timestamp_label ? `原片时间点 ${item.timestamp_label}` : '已对照理解后可标记掌握'}</span>
                          {item.annotation_id && (
                            <button
                              type="button"
                              disabled={busy}
                              className={isMastered ? REVIEW_ACTION_BTN : REVIEW_ACTION_ACCENT_BTN}
                              onClick={() => void handleToggleMastered(item, key, !isMastered)}
                            >
                              <CheckCircle2 size={12} />
                              <span>{isMastered ? '移回待复习' : '标为已掌握'}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
