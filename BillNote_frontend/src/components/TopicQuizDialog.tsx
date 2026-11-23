import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, CheckCircle2, Clock, ExternalLink, Folder, Layers, Loader2, Play, RotateCcw, X } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchTopicQuiz, submitReviewQuizPractice, type TopicQuizQuestion } from '@/services/note'
import { DEFAULT_FOLDER_ID, useFolderStore } from '@/store/folderStore'
import { useTaskStore } from '@/store/taskStore'
import { useSourceNavigationStore } from '@/store/sourceNavigationStore'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFolderId?: string | null
  initialTaskIds?: string[]
  onCompleted?: () => void
}

type Stage = 'setup' | 'running' | 'summary'

interface AnswerRecord {
  question: TopicQuizQuestion
  pickedKey: string
  isCorrect: boolean
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function TopicQuizDialog({
  open,
  onOpenChange,
  initialFolderId,
  initialTaskIds,
  onCompleted,
}: Props) {
  const navigate = useNavigate()
  const folders = useFolderStore(state => state.folders)
  const tasks = useTaskStore(state => state.tasks)
  const activeTasks = useMemo(() => tasks.filter(t => !t.archived_at && t.status === 'SUCCESS'), [tasks])

  const [scopeMode, setScopeMode] = useState<'folder' | 'notes'>('folder')
  const [selectedFolder, setSelectedFolder] = useState<string>(initialFolderId || 'all')
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>(initialTaskIds || [])
  const [showTimer, setShowTimer] = useState(false)
  const [stage, setStage] = useState<Stage>('setup')
  const [loading, setLoading] = useState(false)
  const [questions, setQuestions] = useState<TopicQuizQuestion[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<number, AnswerRecord>>({})
  const [submitting, setSubmitting] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    if (!open) return
    setStage('setup')
    setQuestions([])
    setCurrentIndex(0)
    setAnswers({})
    setElapsedSec(0)
    if (initialTaskIds && initialTaskIds.length > 0) {
      setScopeMode('notes')
      setSelectedTaskIds(initialTaskIds)
    } else if (initialFolderId) {
      setScopeMode('folder')
      setSelectedFolder(initialFolderId)
    } else {
      setScopeMode('folder')
      setSelectedFolder('all')
    }
  }, [open, initialFolderId, initialTaskIds])

  useEffect(() => {
    if (!open || stage !== 'running' || !showTimer) return
    const timer = window.setInterval(() => setElapsedSec(sec => sec + 1), 1000)
    return () => window.clearInterval(timer)
  }, [open, stage, showTimer])

  const startQuiz = useCallback(async (overrideFolder?: string) => {
    if (scopeMode === 'notes' && selectedTaskIds.length === 0) {
      toast.error('请至少勾选一篇笔记')
      return
    }
    setLoading(true)
    try {
      const payload = scopeMode === 'notes'
        ? { task_ids: selectedTaskIds, limit: 15 }
        : { folder_id: overrideFolder ?? selectedFolder, limit: 15 }
      const res = await fetchTopicQuiz(payload)
      if (!res.questions.length) {
        toast.error('所选范围内暂无可用章节自测题')
        return
      }
      setQuestions(res.questions)
      setCurrentIndex(0)
      setAnswers({})
      setElapsedSec(0)
      setStage('running')
    } catch {
      toast.error('抽取专题自测题失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [scopeMode, selectedFolder, selectedTaskIds])

  const currentQuestion = questions[currentIndex]
  const currentAnswer = answers[currentIndex]

  const pickOption = async (optionKey: string) => {
    if (!currentQuestion || currentAnswer || submitting) return
    setSubmitting(true)
    try {
      const result = await submitReviewQuizPractice({
        task_id: currentQuestion.task_id,
        section_id: currentQuestion.section_id,
        selected_key: optionKey,
      })
      setAnswers(prev => ({
        ...prev,
        [currentIndex]: {
          question: currentQuestion,
          pickedKey: optionKey,
          isCorrect: result.is_correct,
        },
      }))
    } catch {
      const fallbackCorrect = optionKey === currentQuestion.correct_key
      setAnswers(prev => ({
        ...prev,
        [currentIndex]: {
          question: currentQuestion,
          pickedKey: optionKey,
          isCorrect: fallbackCorrect,
        },
      }))
    } finally {
      setSubmitting(false)
    }
  }

  const goNext = () => {
    if (currentIndex + 1 < questions.length) {
      setCurrentIndex(i => i + 1)
    } else {
      setStage('summary')
      onCompleted?.()
    }
  }

  const jumpToNote = (q: TopicQuizQuestion) => {
    useTaskStore.getState().setCurrentTask(q.task_id)
    useSourceNavigationStore.getState().open({
      note_id: q.task_id,
      version_id: q.version_id || undefined,
      section_id: q.section_id,
      section_title: q.section_title,
      quiz_id: q.section_id,
    })
    onOpenChange(false)
    navigate('/?view=read')
  }

  const answeredList = Object.values(answers)
  const correctCount = answeredList.filter(a => a.isCorrect).length
  const wrongList = answeredList.filter(a => !a.isCorrect)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[84dvh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers size={16} strokeWidth={1.7} />
            <span>专题综合自测</span>
            {stage === 'running' && (
              <span className="ml-auto mr-6 inline-flex items-center gap-2 text-xs font-normal text-muted-foreground tabular-nums">
                <span>{currentIndex + 1} / {questions.length}</span>
                {showTimer && (
                  <span className="inline-flex items-center gap-1">
                    <Clock size={12} />
                    {formatTimer(elapsedSec)}
                  </span>
                )}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {stage === 'setup'
              ? '按文件夹或多选笔记抽取章节自测题，答错将自动进入对应笔记复习本。'
              : stage === 'running'
                ? `${currentQuestion?.note_title || ''} · ${currentQuestion?.section_title || ''}`
                : '本次作答已同步写回各篇笔记的学习记录与错题池。'}
          </DialogDescription>
        </DialogHeader>

        {stage === 'setup' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            <div className="inline-flex w-fit items-center rounded-full border border-[var(--surface-hairline)] bg-[var(--surface-input)] p-[3px] text-xs">
              <button
                type="button"
                className={`rounded-full px-3 py-1 transition-colors ${scopeMode === 'folder' ? 'bg-[var(--surface-raised)] font-medium text-[var(--reading-accent,var(--primary))]' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setScopeMode('folder')}
              >
                按文件夹
              </button>
              <button
                type="button"
                className={`rounded-full px-3 py-1 transition-colors ${scopeMode === 'notes' ? 'bg-[var(--surface-raised)] font-medium text-[var(--reading-accent,var(--primary))]' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setScopeMode('notes')}
              >
                自选笔记 ({selectedTaskIds.length})
              </button>
            </div>

            {scopeMode === 'folder' ? (
              <div className="grid grid-cols-2 gap-2">
                {[{ id: 'all', name: '全部笔记' }, ...folders].map(folder => {
                  const active = selectedFolder === folder.id
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                        active
                          ? 'border-[color-mix(in_srgb,var(--reading-accent,var(--primary))_45%,transparent)] bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_10%,transparent)] font-medium text-[var(--reading-accent,var(--primary))]'
                          : 'border-[var(--surface-hairline)] bg-[var(--surface-raised)]/60 text-foreground hover:border-[var(--surface-border)]'
                      }`}
                      onClick={() => setSelectedFolder(folder.id)}
                    >
                      <Folder size={13} strokeWidth={1.65} className="shrink-0" />
                      <span className="truncate">{folder.id === DEFAULT_FOLDER_ID ? '默认文件夹' : folder.name}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-[var(--surface-hairline)] p-2">
                {activeTasks.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">暂无可用笔记</p>
                ) : (
                  activeTasks.map(task => {
                    const checked = selectedTaskIds.includes(task.id)
                    return (
                      <label
                        key={task.id}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--surface-hover)]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelectedTaskIds(prev =>
                              checked ? prev.filter(id => id !== task.id) : [...prev, task.id],
                            )
                          }}
                        />
                        <span className="truncate">{task.audioMeta?.title || task.id}</span>
                      </label>
                    )
                  })
                )}
              </div>
            )}

            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showTimer}
                onChange={e => setShowTimer(e.target.checked)}
              />
              <span>显示轻量用时（无压力不强制交卷）</span>
            </label>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                disabled={loading}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--reading-accent,var(--primary))] px-4 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                onClick={() => void startQuiz()}
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Play size={12} />}
                <span>{loading ? '正在抽题…' : '开始专题自测'}</span>
              </button>
            </div>
          </div>
        )}

        {stage === 'running' && currentQuestion && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            <p className="text-[13.5px] font-medium leading-relaxed text-foreground">
              {currentQuestion.full_question}
            </p>

            <div className="space-y-1.5">
              {currentQuestion.options.map(opt => {
                const answered = Boolean(currentAnswer)
                const isCorrectOpt = opt.key === currentQuestion.correct_key
                const isPickedWrong = answered && currentAnswer?.pickedKey === opt.key && !currentAnswer.isCorrect
                const isCrossedOut = answered && !isCorrectOpt && !isPickedWrong

                let optClass = 'border-[var(--surface-hairline)] bg-[var(--surface-page)]/70 hover:border-[var(--reading-accent,var(--primary))]'
                if (answered && isCorrectOpt) {
                  optClass = 'border-[color-mix(in_srgb,var(--reading-accent,var(--primary))_42%,transparent)] bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_16%,transparent)] font-medium'
                } else if (isPickedWrong) {
                  optClass = 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                } else if (isCrossedOut) {
                  optClass = 'border-transparent bg-transparent opacity-40 line-through'
                }

                return (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={answered || submitting}
                    className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors ${optClass}`}
                    onClick={() => void pickOption(opt.key)}
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

            {currentAnswer && currentQuestion.explanation && (
              <div className="rounded-xl bg-[var(--surface-input)] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                <strong className="mr-1 font-medium text-foreground">解析：</strong>
                {currentQuestion.explanation}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--surface-hairline)] px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground"
                onClick={() => jumpToNote(currentQuestion)}
              >
                <ExternalLink size={12} />
                <span>定位原文</span>
              </button>
              {currentAnswer && (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--reading-accent,var(--primary))] px-4 text-xs font-medium text-white hover:opacity-90"
                  onClick={goNext}
                >
                  <span>{currentIndex + 1 < questions.length ? '下一题' : '查看总结'}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {stage === 'summary' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            <div className="flex items-center justify-between rounded-xl border border-[var(--surface-hairline)] bg-[var(--surface-raised)]/75 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 size={20} className="text-[var(--reading-accent,var(--primary))]" />
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    答对 {correctCount} / {questions.length} 题（{Math.round((correctCount / Math.max(1, questions.length)) * 100)}%）
                  </p>
                  {showTimer && <p className="text-[11px] text-muted-foreground">用时 {formatTimer(elapsedSec)}</p>}
                </div>
              </div>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--surface-hairline)] px-3 text-xs hover:bg-[var(--surface-hover)]"
                onClick={() => setStage('setup')}
              >
                <RotateCcw size={12} />
                <span>再测一轮</span>
              </button>
            </div>

            {wrongList.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">本轮错题（已自动加入复习本）</p>
                {wrongList.map((item, idx) => (
                  <div
                    key={`${item.question.task_id}-${item.question.section_id}-${idx}`}
                    className="flex items-center justify-between gap-2 rounded-xl border border-[var(--surface-hairline)] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{item.question.full_question}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {item.question.note_title} · 你的选择 {item.pickedKey} / 正确 {item.question.correct_key}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[var(--surface-hairline)] px-2.5 text-[11px] hover:bg-[var(--surface-hover)]"
                      onClick={() => jumpToNote(item.question)}
                    >
                      <ExternalLink size={11} />
                      <span>回看</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
