import { lazy, Suspense, useState, useEffect, useMemo, useCallback, memo, FC } from 'react'
import { useSourceNavigationStore } from '@/store/sourceNavigationStore'
import { resolveQuoteTargets } from '@/utils/quoteSource'
import { renderedNoteMarkdown, resolveSearchTarget, scrollToSearchMatch } from '@/utils/searchLocation'
import ReactMarkdown from 'react-markdown'
import { Play, ExternalLink, Sparkles, Loader2 } from 'lucide-react'
import { toast } from 'react-hot-toast'
import {
  createUserAnnotation,
  deleteUserAnnotation,
  getNoteLearningState,
  getNoteMediaInfo,
  noteMediaStreamUrl,
  translateNoteCaptions,
  updateNoteLearningState,
  updateUserAnnotation,
  upgradeNoteStructured,
  type NoteMediaInfo,
  type UserAnnotationRecord,
} from '@/services/note'
import { findSegmentIndexForTime, resolveOnlineVideoEmbed, resolveTimestampAction } from '@/utils/mediaTranscriptSync'
import MiniMediaPlayer, { type MediaSeekCommand } from './MiniMediaPlayer'
import { buildOriginTimeUrl } from '@/types/structuredNote'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import GenerationProgress from './GenerationProgress'
import CodeBlock from '@/components/CodeBlock'
import NoteImage from '@/components/NoteImage'
import { NoteImageChatContext, type NoteImageChatTarget } from '@/components/NoteImageChatContext'
import ReadingChatLayout from './ReadingChatLayout'
import gfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeSlug from 'rehype-slug'
import 'katex/dist/katex.min.css'
import 'github-markdown-css/github-markdown-light.css'
import { useTaskStore } from '@/store/taskStore'
import { noteStyles } from '@/constant/note.ts'
import { noteStyleLabel } from '@/utils/noteGeneration'
import { MarkdownHeader } from '@/pages/HomePage/components/MarkdownHeader.tsx'
import { scrollMotion } from '@/utils/motion'
import VideoBanner from '@/pages/HomePage/components/VideoBanner.tsx'
import ReaderPane from '@/pages/HomePage/components/ReaderPane'
import { rehypeNoteOutline, resolveChapter, scrollToChapter } from '@/utils/noteOutline'
import ReadingSelection, { rehypeReadingBlocks, type SelectionAnnotationDraft } from './ReadingSelection'
import RelatedNotesSection from './RelatedNotesSection'
import type { AssistantAnnotationDraft } from './ChatPanel'
import { useReadingAssistantStore, permanentSessionKey, type ReadingAttachment } from '@/store/readingAssistantStore'
import { resolveStructuredNote, structuredNoteToMindmapMarkdown, type StructuredNoteDocument } from '@/types/structuredNote'
import { useWorkspaceTopbar } from '@/layouts/WorkspaceTopbarContext'
import StructuredNoteReader, { type StructuredFocusAnchor } from './StructuredNoteReader/StructuredNoteReader'
import type { QuizAnswerPayload, QuizAskPayload } from './StructuredNoteReader/MorphingQuizCapsule'

const Idle = lazy(() => import('@/components/Lottie/Idle.tsx'))
const MarkmapEditor = lazy(() => import('@/pages/HomePage/components/MarkmapComponent.tsx'))
const RefineNoteDialog = lazy(() => import('./RefineNoteDialog'))
const ChatPanel = lazy(() => import('@/pages/HomePage/components/ChatPanel.tsx'))
const TranscriptViewer = lazy(() => import('@/pages/HomePage/components/transcriptViewer.tsx'))

interface VersionNote {
  ver_id: string
  content: string
  structured?: StructuredNoteDocument
  style: string
  model_name: string
  created_at?: string
}

interface MarkdownViewerProps {
  status: 'idle' | 'loading' | 'success' | 'failed'
}

const remarkPlugins = [gfm, remarkMath]
const rehypePlugins = [rehypeKatex, rehypeSlug, rehypeNoteOutline, rehypeReadingBlocks]
// Inserted by backend/app/gpt/universal_gpt.py when a long transcript is generated in parts.
const SEGMENT_NOTICE = '以下保留各来源分段的完整正文，未进行跨段模型合并。'
const SOURCE_SEGMENT = /^来源分段\s*\d+\s*$/
const plainText = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(plainText).join('')
  : node && typeof node === 'object' && 'props' in node ? plainText((node as { props?: { children?: unknown } }).props?.children) : ''

/**
 * 构建 ReactMarkdown components 对象，baseURL 用于修正图片路径。
 * 使用函数 + useMemo 避免每次渲染都创建新的函数实例。
 */
function createMarkdownComponents(baseURL: string, resourceBase?: string) {
  return {
    h1: ({ children, ...props }: any) => (
      <h1
        className="text-primary my-6 scroll-m-20 text-3xl font-extrabold tracking-tight lg:text-4xl"
        {...props}
      >
        {children}
      </h1>
    ),
    h2: ({ children, ...props }: any) => SOURCE_SEGMENT.test(plainText(children)) ? (
      <h2 className="note-source-segment" {...props}>{children}</h2>
    ) : (
      <h2
        className="text-primary mt-10 mb-4 scroll-m-20 border-b pb-2 text-2xl font-semibold tracking-tight first:mt-0"
        {...props}
      >
        {children}
      </h2>
    ),
    h3: ({ children, ...props }: any) => (
      <h3
        className="text-primary mt-8 mb-4 scroll-m-20 text-xl font-semibold tracking-tight"
        {...props}
      >
        {children}
      </h3>
    ),
    h4: ({ children, ...props }: any) => (
      <h4
        className="text-primary mt-6 mb-2 scroll-m-20 text-lg font-semibold tracking-tight"
        {...props}
      >
        {children}
      </h4>
    ),
    p: ({ children, ...props }: any) => (
      <p className="leading-7 [&:not(:first-child)]:mt-6" {...props}>
        {children}
      </p>
    ),
    a: ({ href, children, ...props }: any) => {
      const isOriginLink =
        typeof children[0] === 'string' &&
        (children[0] as string).startsWith('原片 @')

      if (isOriginLink) {
        const timeMatch = (children[0] as string).match(/原片 @ (\d{2}:\d{2})/)
        const timeText = timeMatch ? timeMatch[1] : '原片'

        return (
          <span className="origin-link my-2 inline-flex">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100"
              {...props}
            >
              <Play className="h-3.5 w-3.5" />
              <span>原片（{timeText}）</span>
            </a>
          </span>
        )
      }

      // 处理笔记内部锚点链接（如目录跳转）
      if (href?.startsWith('#')) {
        const handleAnchorClick = (e: React.MouseEvent) => {
          e.preventDefault()
          const link = e.currentTarget as HTMLElement
          const root = link.closest<HTMLElement>('.markdown-body')
          const target = root ? resolveChapter(root, href, link.textContent || '') : null
          if (target) {
            scrollToChapter(target, scrollMotion())
          } else {
            toast.error('未找到对应章节')
          }
        }

        return (
          <a
            href={href}
            onClick={handleAnchorClick}
            className="text-primary hover:text-primary/80 inline-flex items-center gap-0.5 font-medium underline underline-offset-4"
            {...props}
          >
            {children}
          </a>
        )
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:text-primary/80 inline-flex items-center gap-0.5 font-medium underline underline-offset-4"
          {...props}
        >
          {children}
          {href?.startsWith('http') && (
            <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
          )}
        </a>
      )
    },
    img: ({ node, ...props }: any) => {
      let src = String(props.src || '')
      if (resourceBase && !/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(src)) {
        src = new URL(src, new URL(baseURL + resourceBase, window.location.origin)).toString()
      } else if (src.startsWith('/api/') && baseURL) {
        src = baseURL + src
      } else if (src.startsWith('/') && !src.startsWith('/api/')) {
        src = baseURL + src
      }
      props.src = src

      return (
        <NoteImage {...props} />
      )
    },
    strong: ({ children, ...props }: any) => (
      <strong className="text-primary font-bold" {...props}>
        {children}
      </strong>
    ),
    li: ({ children, ordered: _ordered, index: _index, node: _node, ...props }: any) => {
      const rawText = String(children)
      const isFakeHeading = /^(\*\*.+\*\*)$/.test(rawText.trim())

      if (isFakeHeading) {
        return (
          <div className="text-primary my-4 text-lg font-bold">{children}</div>
        )
      }

      return (
        <li className="my-1" {...props}>
          {children}
        </li>
      )
    },
    ul: ({ children, ordered: _ordered, depth: _depth, node: _node, ...props }: any) => (
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ordered: _ordered, depth: _depth, node: _node, ...props }: any) => (
      <ol className="my-6 ml-6 list-decimal [&>li]:mt-2" {...props}>
        {children}
      </ol>
    ),
    blockquote: ({ children, ...props }: any) => (
      <blockquote
        className="mt-6 rounded-xl border border-[var(--surface-hairline)] bg-[var(--surface-panel)]/75 px-4 py-3 text-muted-foreground"
        // Pipeline notice for chunked long videos; kept in the DOM so search offsets stay valid.
        hidden={plainText(children).trim() === SEGMENT_NOTICE || undefined}
        {...props}
      >
        {children}
      </blockquote>
    ),
    code: ({ inline, className, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(className || '')
      const codeContent = String(children).replace(/\n$/, '')

      if (!inline && match) {
        return <CodeBlock language={match[1]} code={codeContent} />
      }

      return (
        <code
          className="bg-muted relative rounded px-[0.3rem] py-[0.2rem] font-mono text-sm"
          {...props}
        >
          {children}
        </code>
      )
    },
    table: ({ children, ...props }: any) => (
      <div className="note-legacy-table-wrap my-6 w-full overflow-x-auto">
        <table className="note-legacy-table w-full border-collapse text-sm" {...props}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, isHeader: _isHeader, node: _node, ...props }: any) => (
      <th
        className="border-muted-foreground/20 border px-4 py-2 text-left font-medium whitespace-nowrap [&[align=center]]:text-center [&[align=right]]:text-right"
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, isHeader: _isHeader, node: _node, ...props }: any) => (
      <td
        className="border-muted-foreground/20 border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right"
        {...props}
      >
        {children}
      </td>
    ),
    hr: ({ ...props }: any) => (
      <hr className="border-muted-foreground/20 my-8" {...props} />
    ),
  }
}

// Toolbar/reading-state changes must not reparse and highlight the entire note.
const MarkdownContent = memo(function MarkdownContent({ content, components }: {
  content: string; components: ReturnType<typeof createMarkdownComponents>
}) {
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
    {renderedNoteMarkdown(content)}
  </ReactMarkdown>
})

const MarkdownViewer: FC<MarkdownViewerProps> = memo(({ status }) => {
  const source = useSourceNavigationStore(state => state.source)
  const [versionSelection, setVersionSelection] = useState({ taskId: '', versionId: '' })
  const [refinement, setRefinement] = useState<{ taskId: string; versionId: string; texts: string[]; sectionIds?: string[] } | null>(null)
  // 确保baseURL没有尾部斜杠
  const baseURL = (String(import.meta.env.VITE_API_BASE_URL || '').replace('/api','') || '').replace(/\/$/, '')
  const currentTask = useTaskStore(state => state.getCurrentTask())
  const currentTaskId = currentTask?.id || ''
  const currentVerId = source?.note_id === currentTaskId ? source.version_id || ''
    : versionSelection.taskId === currentTaskId ? versionSelection.versionId : ''
  const setCurrentVerId = useCallback((versionId: string) => {
    setVersionSelection(previous => previous.taskId === currentTaskId && previous.versionId === versionId
      ? previous : { taskId: currentTaskId, versionId })
  }, [currentTaskId])
  useEffect(() => { setRefinement(null) }, [currentTask?.id, currentVerId])
  const retryTask = useTaskStore.getState().retryTask
  const isMultiVersion = Array.isArray(currentTask?.markdown)
  const selectedVersion = currentTask && Array.isArray(currentTask.markdown) ? currentTask.markdown.find(v => v.ver_id === currentVerId) || currentTask.markdown[0] : null
  const activeVersionId = selectedVersion?.ver_id || ''
  const selectedContent = typeof currentTask?.markdown === 'string' ? currentTask.markdown : selectedVersion?.content || ''
  const structuredNote = useMemo(
    () => resolveStructuredNote(selectedVersion, selectedContent),
    [selectedVersion, selectedContent],
  )
  const mindmapMarkdown = useMemo(
    () => (structuredNote ? structuredNoteToMindmapMarkdown(structuredNote) : selectedContent),
    [structuredNote, selectedContent],
  )
  const workspaceTopbar = useWorkspaceTopbar()
  const viewerActive = !workspaceTopbar || workspaceTopbar.active
  const modelName = selectedVersion?.model_name || currentTask?.formData?.model_name || ''
  const refinementProvider = selectedVersion?.provider_id || currentTask?.formData?.provider_id || ''
  const style = selectedVersion?.style || currentTask?.formData?.style || ''
  const styleLabel = noteStyles.find(v => v.value === style)?.label || (style ? noteStyleLabel(style) : '')
  const createTime = selectedVersion?.created_at || currentTask?.createdAt || ''
  const resourceBase = selectedVersion?.resource_base || currentTask?.resource_base
  const [rightDockTab, setRightDockTab] = useState<'chat' | 'transcript' | null>(null)
  const [chatLayoutMode, setChatLayoutMode] = useState<'half' | 'full'>('half')
  const [transcriptJumpTime, setTranscriptJumpTime] = useState<number | null>(null)
  const [mediaInfo, setMediaInfo] = useState<NoteMediaInfo | null>(null)
  const [miniPlayerOpen, setMiniPlayerOpen] = useState(false)
  const [mediaSeekCommand, setMediaSeekCommand] = useState<MediaSeekCommand | null>(null)
  const [playbackTime, setPlaybackTime] = useState<number | null>(null)
  const [structuredAnchor, setStructuredAnchor] = useState<StructuredFocusAnchor | null>(null)
  const [upgradingStructured, setUpgradingStructured] = useState(false)
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({})
  const [userAnnotations, setUserAnnotations] = useState<UserAnnotationRecord[]>([])
  const [annoDraft, setAnnoDraft] = useState<SelectionAnnotationDraft | null>(null)
  const [annoTitleInput, setAnnoTitleInput] = useState('')
  const [annoDetailInput, setAnnoDetailInput] = useState('')
  const [annoSaving, setAnnoSaving] = useState(false)
  const defaultGenerationModel = usePurposeModelStore(state => state.defaults.generation)

  useEffect(() => {
    setMiniPlayerOpen(false)
    setMediaSeekCommand(null)
    setPlaybackTime(null)
    setTranscriptJumpTime(null)
    if (!currentTaskId) {
      setMediaInfo(null)
      return
    }
    let active = true
    void getNoteMediaInfo(currentTaskId)
      .then(info => {
        if (active) setMediaInfo(info)
      })
      .catch(() => {
        if (active) setMediaInfo({ available: false, media_type: null, size: 0, url: null })
      })
    return () => { active = false }
  }, [currentTaskId])

  useEffect(() => {
    setAnnoDraft(null)
    if (!currentTaskId) {
      setQuizAnswers({})
      setUserAnnotations([])
      return
    }
    let active = true
    void getNoteLearningState(currentTaskId)
      .then(state => {
        if (!active) return
        const mapped: Record<string, string> = {}
        for (const [secId, record] of Object.entries(state?.quiz_attempts || {})) {
          const picked = record?.picked_key || record?.selected_key
          if (picked) mapped[secId] = picked
        }
        setQuizAnswers(mapped)
        setUserAnnotations(Array.isArray(state?.user_annotations) ? state.user_annotations : [])
      })
      .catch(() => {
        if (active) {
          setQuizAnswers({})
          setUserAnnotations([])
        }
      })
    return () => { active = false }
  }, [currentTaskId])

  const openSelectionAnnotator = useCallback((draft: SelectionAnnotationDraft) => {
    setAnnoDraft(draft)
    const compact = draft.text.replace(/\s+/g, ' ').trim()
    setAnnoTitleInput(compact.slice(0, 24) + (compact.length > 24 ? '…' : ''))
    setAnnoDetailInput('')
  }, [])

  const submitManualAnnotation = useCallback(async () => {
    if (!currentTaskId || !annoDraft || !annoDetailInput.trim() || annoSaving) return
    setAnnoSaving(true)
    try {
      const created = await createUserAnnotation(currentTaskId, {
        section_id: annoDraft.sectionId || structuredNote?.sections?.[0]?.id || '',
        section_title: annoDraft.sectionTitle || structuredNote?.sections?.[0]?.title || '',
        block_id: annoDraft.blockId || '',
        anchor_text: annoDraft.text.slice(0, 240),
        title: annoTitleInput.trim(),
        detail: annoDetailInput.trim(),
        source: 'manual',
      })
      setUserAnnotations(prev => [...prev, created])
      setAnnoDraft(null)
      setAnnoTitleInput('')
      setAnnoDetailInput('')
      toast.success('已添加正文批注')
    } catch {
      toast.error('保存批注失败，请重试')
    } finally {
      setAnnoSaving(false)
    }
  }, [annoDetailInput, annoDraft, annoSaving, annoTitleInput, currentTaskId, structuredNote])

  const handleSaveAssistantAnnotation = useCallback(async (draft: AssistantAnnotationDraft) => {
    if (!currentTaskId) return
    let sectionId = structuredNote?.sections?.[0]?.id || ''
    let sectionTitle = structuredNote?.sections?.[0]?.title || ''
    if (draft.blockId) {
      const blockEl = document.getElementById(draft.blockId)
      const secEl = blockEl?.closest<HTMLElement>('[data-section-id]')
      if (secEl?.dataset.sectionId) {
        sectionId = secEl.dataset.sectionId
        sectionTitle = secEl.querySelector<HTMLElement>('[data-note-heading]')?.dataset.noteLabel
          || secEl.querySelector<HTMLElement>('[data-note-heading]')?.textContent?.trim()
          || sectionTitle
      }
    }
    try {
      const created = await createUserAnnotation(currentTaskId, {
        section_id: sectionId,
        section_title: sectionTitle,
        block_id: draft.blockId || '',
        anchor_text: draft.anchorText || '',
        title: draft.title,
        detail: draft.detail,
        source: 'assistant',
      })
      setUserAnnotations(prev => [...prev, created])
      toast.success('已沉淀为正文批注')
    } catch {
      toast.error('沉淀批注失败，请重试')
      throw new Error('save failed')
    }
  }, [currentTaskId, structuredNote])

  const handleEditUserAnnotation = useCallback(async (annotationId: string, payload: { title: string; detail: string }) => {
    if (!currentTaskId) return
    try {
      const updated = await updateUserAnnotation(currentTaskId, annotationId, payload)
      setUserAnnotations(prev => prev.map(item => (item.id === annotationId ? updated : item)))
      toast.success('批注已更新')
    } catch {
      toast.error('更新批注失败，请重试')
    }
  }, [currentTaskId])

  const handleDeleteUserAnnotation = useCallback(async (annotationId: string) => {
    if (!currentTaskId) return
    try {
      await deleteUserAnnotation(currentTaskId, annotationId)
      setUserAnnotations(prev => prev.filter(item => item.id !== annotationId))
      toast.success('批注已删除')
    } catch {
      toast.error('删除批注失败，请重试')
    }
  }, [currentTaskId])

  const handleAnswerQuiz = useCallback((payload: QuizAnswerPayload) => {
    if (!currentTaskId) return
    setQuizAnswers(prev => ({ ...prev, [payload.sectionId]: payload.pickedKey }))
    void updateNoteLearningState(currentTaskId, {
      quiz_attempts: {
        [payload.sectionId]: {
          picked_key: payload.pickedKey,
          correct_key: payload.correctKey,
          is_correct: payload.isCorrect,
          question: payload.question,
          section_title: payload.sectionTitle,
          explanation: payload.explanation,
        },
      },
    }).catch(() => undefined)
  }, [currentTaskId])

  const handleUpgradeStructured = async () => {
    if (!currentTask || upgradingStructured) return
    const targetProvider = defaultGenerationModel?.provider_id || refinementProvider
    const targetModel = defaultGenerationModel?.model_name || modelName
    setUpgradingStructured(true)
    try {
      const updated = await upgradeNoteStructured(currentTask.id, {
        provider_id: targetProvider || undefined,
        model_name: targetModel || undefined,
        style: style === 'knowledge' ? 'knowledge' : 'tutorial',
      })
      useTaskStore.setState(state => ({
        tasks: state.tasks.map(task => (task.id === updated.id ? updated : task)),
      }))
      if (Array.isArray(updated.markdown) && updated.markdown[0]?.ver_id) {
        setCurrentVerId(updated.markdown[0].ver_id)
      }
      toast.success('已升级为结构化笔记新版本，原有版本已保留')
    } catch (error) {
      const e = error as { msg?: string; message?: string }
      toast.error(e?.msg || e?.message || '升级失败，请检查模型配置或缓存字幕')
    } finally {
      setUpgradingStructured(false)
    }
  }
  const showTranscribe = rightDockTab === 'transcript'
  const showChat: false | 'half' | 'full' = rightDockTab === 'chat' ? chatLayoutMode : false
  const layoutMode: 'closed' | 'half' | 'full' =
    rightDockTab === null ? 'closed' : rightDockTab === 'chat' ? chatLayoutMode : 'half'
  const setShowTranscribe = useCallback((open: boolean) => {
    if (open) {
      setChatLayoutMode(prev => (prev === 'full' ? 'half' : prev))
      setRightDockTab('transcript')
    } else {
      setRightDockTab(prev => (prev === 'transcript' ? null : prev))
    }
  }, [])
  const setShowChat = useCallback((next: false | 'half' | 'full') => {
    if (!next) {
      setRightDockTab(prev => (prev === 'chat' ? null : prev))
      return
    }
    setChatLayoutMode(next)
    setRightDockTab('chat')
  }, [])
  useEffect(() => {
    if (!viewerActive || !currentTask) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return
      if ((event.ctrlKey || event.metaKey) && event.key === '.') {
        if (document.querySelector('[role="dialog"], .fixed.z-40[aria-label="笔记阅读器"]')) return
        event.preventDefault()
        setRightDockTab(prev => (prev === 'chat' ? null : 'chat'))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewerActive, currentTask])
  const imageChatTarget = useMemo<NoteImageChatTarget | null>(() => {
    if (!currentTask) return null
    const taskId = currentTask.id
    const sessionKey = permanentSessionKey(taskId)
    return { identity: `${taskId}:${activeVersionId}:${sessionKey}`, taskId, versionId: activeVersionId,
      title: currentTask.audioMeta?.title || '笔记', attach: attachment => {
        if (useTaskStore.getState().currentTaskId !== taskId) throw new Error('已切换笔记，请重新选择图片')
        useReadingAssistantStore.getState().attach(sessionKey, [attachment])
        setRightDockTab('chat')
      } }
  }, [currentTask, activeVersionId])
  const addQuotes = (quotes: ReadingAttachment[], openChat = true) => {
    if (!currentTask) return false
    if (quotes.some(q => (q.text?.length || 0) > 50000)) { toast.error('单次引用最多 5 万字，请减少选中内容'); return false }
    const key = permanentSessionKey(currentTask.id)
    const current = useReadingAssistantStore.getState().sessions[key]?.attachments || []
    if (current.length + quotes.length > 8) { toast.error('每条消息最多 8 份引用或附件，每次选段合为 1 份'); return false }
    useReadingAssistantStore.getState().attach(key, quotes)
    if (openChat) {
      setRightDockTab('chat')
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-reading-chat-panel] textarea')?.focus())
    } else {
      toast.success('已加入对话引用')
    }
    return true
  }
  const [viewMode, setViewMode] = useState<'map' | 'preview'>('preview')
  const [mountedDockTabs, setMountedDockTabs] = useState<{ chat: boolean; transcript: boolean }>({ chat: false, transcript: false })
  useEffect(() => {
    if (rightDockTab === 'chat') {
      setMountedDockTabs(prev => (prev.chat ? prev : { ...prev, chat: true }))
    } else if (rightDockTab === 'transcript') {
      setMountedDockTabs(prev => (prev.transcript ? prev : { ...prev, transcript: true }))
    }
  }, [rightDockTab])
  const readerIdentity = `${currentTaskId}:${activeVersionId}`

  // 缓存 ReactMarkdown components，仅在 baseURL 变化时重建
  const markdownComponents = useMemo(() => createMarkdownComponents(baseURL, resourceBase), [baseURL, resourceBase])

  useEffect(() => {
    const versions = currentTask?.markdown
    if (Array.isArray(versions) && versions.length && (versionSelection.taskId !== currentTaskId || versionSelection.versionId !== activeVersionId)) {
      // Commit a source-selected version before the navigation request clears.
      setCurrentVerId(activeVersionId)
    }
  }, [currentTaskId, currentTask?.markdown, activeVersionId, versionSelection.taskId, versionSelection.versionId, setCurrentVerId])
  useEffect(() => {
    if (!source || !currentTask || source.note_id !== currentTask.id || !selectedContent) return
    const clear = useSourceNavigationStore.getState().clear
    if (source.version_id && Array.isArray(currentTask.markdown)) {
      if (!currentTask.markdown.some(version => version.ver_id === source.version_id)) { toast.error('来源版本已不可用，原引用片段仍保留在对话中'); clear(); return }
      if (currentVerId !== source.version_id) { setCurrentVerId(source.version_id); return }
    }
    if (source.metadata_only) { clear(); return }
    setViewMode('preview')
    if ((source.section_id || source.quiz_id || source.annotation_id) && structuredNote) {
      if (rightDockTab === 'chat' && chatLayoutMode === 'full') {
        setChatLayoutMode('half')
      }
      setStructuredAnchor({
        sectionId: source.section_id,
        quizId: source.quiz_id,
        annotationId: source.annotation_id,
        nonce: Date.now(),
      })
      clear()
      return
    }
    if (source.start_time != null) {
      setTranscriptJumpTime(source.start_time)
      setChatLayoutMode(prev => (prev === 'full' ? 'half' : prev))
      setRightDockTab('transcript')
    } else if (rightDockTab === 'chat' && chatLayoutMode === 'full') {
      setChatLayoutMode('half')
    }
    let inner = 0
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => {
      let target: HTMLElement | undefined
      let quoteTargets: HTMLElement[] = []
      let searchTarget: ReturnType<typeof resolveSearchTarget> = null
      if (source.start_time != null) {
        target = Array.from(document.querySelectorAll<HTMLElement>('[data-transcript-start]')).find(el => Number(el.dataset.transcriptEnd) >= source.start_time!)
      } else {
        const root = Array.from(document.querySelectorAll<HTMLElement>('[data-note-task]')).find(el => el.dataset.noteTask === source.note_id)
        const clean = (value = '') => value.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
        if (source.image_source) {
          const matches = Array.from(root?.querySelectorAll<HTMLElement>('[data-note-image]') || []).filter(element => {
            try { return new URL(element.dataset.noteImage || '', window.location.origin).pathname === source.image_source!.path }
            catch { return false }
          })
          target = matches.find(element => element.closest<HTMLElement>('[data-note-block]')?.dataset.noteBlock === source.image_source?.blockId) || matches[0]
        } else if (source.search_match) {
          if (root) searchTarget = resolveSearchTarget(root, selectedContent, source.search_match)
          target = searchTarget?.element
        } else if (source.quote_parts) {
          if (root && (!source.version_id || root.dataset.noteVersion === source.version_id)) quoteTargets = resolveQuoteTargets(root, source.quote_parts)
          target = quoteTargets[0]
        } else {
          target = Array.from(root?.querySelectorAll<HTMLElement>('[data-note-heading]') || []).find(el => clean(el.dataset.noteLabel || el.textContent || '') === clean(source.section_title))
          if (!target && source.text) target = Array.from(root?.querySelectorAll<HTMLElement>('[data-note-block]') || []).find(el => clean(el.textContent || '').includes(clean(source.text).slice(0, 60)))
        }
      }
      if (target) {
        if (searchTarget) scrollToSearchMatch(searchTarget, scrollMotion())
        else if (source.quote_parts || source.image_source) scrollToChapter(target, scrollMotion())
        else target.scrollIntoView({behavior:scrollMotion(),block:'center'})
        const highlights = quoteTargets.length ? quoteTargets : [target]
        highlights.forEach(el => el.classList.add('reading-block--flash'))
        setTimeout(()=>highlights.forEach(el=>el.classList.remove('reading-block--flash')),2400)
      }
      else toast(source.image_source ? '原图位置已变化，附件中的图片仍保留' : source.search_match ? '正文位置已变化，请重新查找' : source.quote_parts ? '原文位置可能已变化，请检查对应笔记版本' : '已打开来源笔记，片段位置可能已变化，请参照对话中的原文核对')
      clear()
    }) })
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
  }, [source, currentTask?.id, currentVerId, selectedContent, rightDockTab, chatLayoutMode, viewMode, setCurrentVerId])
  if (status === 'idle') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center space-y-3 text-muted-foreground">
        <Suspense fallback={<div className="h-[180px]" aria-hidden="true" />}>
          <Idle />
        </Suspense>
        <div className="text-center">
          <p className="text-base font-medium text-foreground">粘贴链接或拖入本地文件开始生成</p>
          <p className="mt-1.5 text-xs text-muted-foreground">支持视频、X 推文、播客、网页与本地文档</p>
        </div>
      </div>
    )
  }

  const askQuizAssistant = (payload: QuizAskPayload) => {
    if (!currentTask) return
    const optionsText = payload.quiz.options.map(opt => `${opt.key}. ${opt.text}`).join('\n')
    const picked = payload.quiz.options.find(opt => opt.key === payload.pickedKey)
    const contextText = [
      `【章节自测：${payload.sectionTitle}】`,
      `题目：${payload.quiz.full_question}`,
      `选项：\n${optionsText}`,
      `我的选择：${payload.pickedKey}${picked ? `（${picked.text}）` : ''}（${payload.pickedKey === payload.quiz.correct_key ? '已答对' : `正确答案为 ${payload.quiz.correct_key}`}）`,
      `参考解析：${payload.quiz.explanation}`,
      payload.sectionSummary ? `所在章节核心内容：\n${payload.sectionSummary}` : '',
    ].filter(Boolean).join('\n\n')
    const attachment: ReadingAttachment = {
      id: crypto.randomUUID(),
      type: 'quote',
      name: `${currentTask.audioMeta?.title || '笔记'} · ${payload.sectionTitle} 自测`,
      text: contextText,
      taskId: currentTask.id,
      versionId: activeVersionId,
    }
    addQuotes([attachment], true)
  }

  const [translatingCaptions, setTranslatingCaptions] = useState(false)

  const handleTranslateCaptions = useCallback(async (options?: { force?: boolean }) => {
    if (!currentTaskId || translatingCaptions) return
    const force = Boolean(options?.force)
    setTranslatingCaptions(true)
    try {
      const res = await translateNoteCaptions(currentTaskId, { force })
      if (Array.isArray(res?.segments) && res.segments.length > 0) {
        useTaskStore.setState(state => ({
          tasks: state.tasks.map(t =>
            t.id === currentTaskId
              ? {
                  ...t,
                  transcript: {
                    ...(t.transcript || { full_text: '', language: '', raw: null, segments: [] }),
                    segments: res.segments,
                  },
                }
              : t,
          ),
        }))
        if (force) {
          toast.success(
            res.missing_count && res.missing_count > 0
              ? `已重译 ${res.translated_count ?? 0}/${res.total_count ?? res.segments.length} 句字幕（剩余可再次补译）`
              : '已重新翻译全部字幕',
          )
        } else if (res.missing_count && res.missing_count > 0) {
          toast.success(`已翻译 ${res.translated_count ?? 0}/${res.total_count ?? res.segments.length} 句字幕（剩余可再次点击补译）`)
        } else {
          toast.success(res.cached ? '已加载字幕中文译文' : '字幕已翻译为中英双语')
        }
      }
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } }; msg?: string; message?: string })
      toast.error(detail?.response?.data?.detail || detail?.msg || detail?.message || '字幕翻译失败，请稍后重试')
    } finally {
      setTranslatingCaptions(false)
    }
  }, [currentTaskId, translatingCaptions])

  const mediaSpliceSegments = useMemo(() => {
    if (Array.isArray(mediaInfo?.concat_segments) && mediaInfo.concat_segments.length >= 2) {
      return mediaInfo.concat_segments
    }
    const rawSegs = currentTask?.audioMeta?.raw_info?.concat_segments
    return Array.isArray(rawSegs) && rawSegs.length >= 2 ? rawSegs : []
  }, [mediaInfo, currentTask])

  const mediaAvailable = Boolean(mediaInfo?.available)
  const onlineEmbed = useMemo(() => {
    if (!currentTask) return null
    return resolveOnlineVideoEmbed({
      platform: currentTask.audioMeta?.platform || currentTask.formData?.platform,
      videoId: currentTask.audioMeta?.video_id,
      videoUrl: currentTask.formData?.video_url,
    })
  }, [currentTask])
  const playerAvailable = mediaAvailable || Boolean(onlineEmbed)
  const mediaSrc = currentTaskId && mediaAvailable
    ? (mediaInfo?.synthetic ? 'preview-synthetic-video' : noteMediaStreamUrl(baseURL, currentTaskId))
    : ''

  const seekLocalMedia = useCallback((seconds: number, autoPlay = true) => {
    if (!playerAvailable) return
    setMiniPlayerOpen(true)
    setMediaSeekCommand({ seconds: Math.max(0, seconds), autoPlay, nonce: Date.now() })
    setPlaybackTime(Math.max(0, seconds))
  }, [playerAvailable])

  const jumpNoteTime = useCallback((seconds: number, originUrl: string | null) => {
    if (!currentTask) return
    const segments = currentTask.transcript?.segments || []
    const hasTranscriptMatch = findSegmentIndexForTime(segments, seconds) >= 0
    const action = resolveTimestampAction({
      mediaAvailable,
      embedAvailable: Boolean(onlineEmbed),
      hasTranscriptMatch,
      originUrl,
    })

    if (action === 'play_local' || action === 'play_embed') {
      seekLocalMedia(seconds, true)
      if (hasTranscriptMatch) {
        setTranscriptJumpTime(seconds)
      }
      return
    }

    if (action === 'transcript_only') {
      setTranscriptJumpTime(seconds)
      setShowTranscribe(true)
      useSourceNavigationStore.getState().open({
        note_id: currentTask.id,
        version_id: activeVersionId,
        start_time: seconds,
      })
      return
    }

    if (action === 'open_external' && originUrl) {
      window.open(originUrl, '_blank', 'noopener,noreferrer')
    }
  }, [activeVersionId, currentTask, mediaAvailable, onlineEmbed, seekLocalMedia, setShowTranscribe])

  const playerExternalUrl = useMemo(() => {
    if (!currentTask) return null
    const sec = Math.floor(playbackTime ?? mediaSeekCommand?.seconds ?? 0)
    return buildOriginTimeUrl(
      currentTask.audioMeta?.platform || currentTask.formData?.platform,
      currentTask.audioMeta?.video_id,
      currentTask.formData?.video_url,
      sec,
    )
  }, [currentTask, playbackTime, mediaSeekCommand])

  const hasReadableBody = Boolean((selectedContent && selectedContent !== 'loading' && selectedContent !== 'empty') || structuredNote)

  return (
    <MarkdownHeader
      key={readerIdentity}
      currentTask={currentTask}
      isMultiVersion={isMultiVersion}
      currentVerId={activeVersionId}
      setCurrentVerId={setCurrentVerId}
      modelName={modelName}
      title={currentTask?.audioMeta?.title || '笔记'}
      showTranscribe={showTranscribe}
      setShowTranscribe={setShowTranscribe}
      showChat={showChat}
      setShowChat={setShowChat}
      viewMode={viewMode}
      setViewMode={setViewMode}
    >
      <ReadingChatLayout mode={layoutMode} dockKind={rightDockTab === 'transcript' ? 'transcript' : 'chat'} onCloseChat={() => setRightDockTab(null)} reader={
        <div className="reading-note-column relative flex min-h-0 min-w-0 flex-1 flex-col">
        {viewMode === 'map' ? (
          <div className="flex w-full flex-1 overflow-hidden bg-background">
            <div className={'w-full'}>
              <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">正在加载思维导图…</div>}>
                <MarkmapEditor
                  value={mindmapMarkdown}
                  onChange={() => {}}
                  height="100%"
                  title={currentTask?.audioMeta?.title || '思维导图'}
                />
              </Suspense>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden bg-background">
            {hasReadableBody ? (
              <ReaderPane key={`${currentTask?.id}:${activeVersionId}`} taskId={currentTask?.id || ''} versionId={activeVersionId} content={selectedContent || structuredNote?.title || ''} title={currentTask?.audioMeta?.title || '笔记'}>
                <VideoBanner
                  audioMeta={currentTask?.audioMeta}
                  videoUrl={currentTask?.formData?.video_url}
                  modelName={modelName}
                  styleLabel={styleLabel}
                  createdAt={createTime}
                />
                {!structuredNote && currentTask && !currentTask.archived_at && (
                  <div className="legacy-upgrade-bar">
                    <span>当前版本为旧版纯文本笔记，可基于已有缓存字幕免重跑升级。</span>
                    <button
                      type="button"
                      className="legacy-upgrade-btn"
                      disabled={upgradingStructured}
                      onClick={() => void handleUpgradeStructured()}
                    >
                      {upgradingStructured ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} strokeWidth={1.7} />}
                      <span>{upgradingStructured ? '正在升级结构化…' : '一键升级结构化笔记'}</span>
                    </button>
                  </div>
                )}
                <NoteImageChatContext.Provider value={imageChatTarget}>
                <ReadingSelection
                  key={`${currentTask?.id}:${activeVersionId}`}
                  taskId={currentTask?.id || ''}
                  versionId={activeVersionId}
                  title={currentTask?.audioMeta?.title || '笔记'}
                  onQuote={addQuotes}
                  onAnnotate={currentTask && !currentTask.archived_at ? openSelectionAnnotator : undefined}
                  onRefine={currentTask && !currentTask.archived_at ? texts => setRefinement({ taskId: currentTask.id, versionId: activeVersionId, texts }) : undefined}
                >
                <div className={'markdown-body select-text w-full px-2'}>
                  {structuredNote ? (
                    <StructuredNoteReader
                      doc={structuredNote}
                      baseURL={baseURL}
                      resourceBase={resourceBase}
                      videoUrl={currentTask?.formData?.video_url}
                      platform={currentTask?.audioMeta?.platform || currentTask?.formData?.platform}
                      videoId={currentTask?.audioMeta?.video_id}
                      checklistScopeKey={currentTask ? `${currentTask.id}:${activeVersionId}` : undefined}
                      initialQuizAnswers={quizAnswers}
                      userAnnotations={userAnnotations}
                      focusAnchor={structuredAnchor}
                      onJumpTime={jumpNoteTime}
                      onAskAssistant={askQuizAssistant}
                      onAnswerQuiz={handleAnswerQuiz}
                      onEditUserAnnotation={currentTask && !currentTask.archived_at ? handleEditUserAnnotation : undefined}
                      onDeleteUserAnnotation={currentTask && !currentTask.archived_at ? handleDeleteUserAnnotation : undefined}
                      onRefineSection={
                        currentTask && !currentTask.archived_at
                          ? sectionId => setRefinement({ taskId: currentTask.id, versionId: activeVersionId, texts: [], sectionIds: [sectionId] })
                          : undefined
                      }
                    />
                  ) : (
                    <>
                      <MarkdownContent content={selectedContent} components={markdownComponents} />
                      {userAnnotations.length > 0 && (
                        <section className="related-notes-strip" aria-label="个人批注">
                          <h4 className="related-notes-heading">个人批注 ({userAnnotations.length})</h4>
                          <div className="flex flex-col gap-2">
                            {userAnnotations.map(item => (
                              <div key={item.id} className="rounded-xl border border-[var(--surface-hairline)] bg-[var(--surface-raised)]/70 p-3 text-xs">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <span className="font-medium text-foreground">
                                    {item.source === 'assistant' ? '助手沉淀 · ' : ''}{item.title}
                                  </span>
                                  {currentTask && !currentTask.archived_at && (
                                    <button
                                      type="button"
                                      className="text-[11px] text-muted-foreground hover:text-destructive"
                                      onClick={() => void handleDeleteUserAnnotation(item.id)}
                                    >
                                      删除
                                    </button>
                                  )}
                                </div>
                                {item.anchor_text && <p className="mb-1 text-[11px] text-muted-foreground">“{item.anchor_text}”</p>}
                                <p className="whitespace-pre-wrap leading-relaxed text-foreground/90">{item.detail}</p>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                    </>
                  )}
                </div>
                </ReadingSelection>
                {currentTaskId && <RelatedNotesSection taskId={currentTaskId} />}
                </NoteImageChatContext.Provider>
              </ReaderPane>
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <p className="text-sm font-medium text-foreground">暂无可读笔记内容</p>
                <p className="text-xs">粘贴链接或拖入本地文件开始生成，支持视频、X 推文、播客、网页与文档</p>
              </div>
            )}
          </div>
        )}
        {!miniPlayerOpen && playerAvailable && (() => {
          const isAudioOnly = Boolean(mediaInfo?.media_type?.toLowerCase().startsWith('audio/') && !onlineEmbed)
          const reopenLabel = isAudioOnly ? '打开音频播放器' : '打开视频播放器'
          return (
            <button
              type="button"
              className="apple-pip-reopen-fab"
              aria-label={reopenLabel}
              title={reopenLabel}
              onClick={() => setMiniPlayerOpen(true)}
            >
              <Play size={15} strokeWidth={1.9} fill="currentColor" className="translate-x-[1px]" aria-hidden="true" />
            </button>
          )
        })()}
        <MiniMediaPlayer
          open={miniPlayerOpen && playerAvailable}
          src={mediaSrc}
          mediaType={mediaInfo?.media_type}
          synthetic={Boolean(mediaInfo?.synthetic)}
          onlineEmbed={mediaAvailable ? null : onlineEmbed}
          transcriptSegments={currentTask?.transcript?.segments || []}
          spliceSegments={mediaSpliceSegments}
          durationHint={currentTask?.audioMeta?.duration || 0}
          seekCommand={mediaSeekCommand}
          externalUrl={playerExternalUrl}
          translatingCaptions={translatingCaptions}
          onTranslateCaptions={currentTaskId ? handleTranslateCaptions : undefined}
          onTimeUpdate={setPlaybackTime}
          onUnavailable={() => {
            setMediaInfo({ available: false, media_type: null, size: 0, url: null })
            if (!onlineEmbed) {
              setMiniPlayerOpen(false)
            }
          }}
          onClose={() => setMiniPlayerOpen(false)}
        />
        </div>}
        chat={currentTask && (
          <div className="reading-dock-panes">
            <div className="reading-dock-pane" hidden={rightDockTab !== 'chat'}>
              {(rightDockTab === 'chat' || mountedDockTabs.chat) && (
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">正在加载阅读助手…</div>}>
                  <ChatPanel
                    key={currentTask.id}
                    taskId={currentTask.id}
                    active={rightDockTab === 'chat'}
                    mode={chatLayoutMode}
                    onModeChange={next => {
                      setChatLayoutMode(next)
                      setRightDockTab('chat')
                    }}
                    onSaveAssistantAnnotation={!currentTask.archived_at ? handleSaveAssistantAnnotation : undefined}
                    onClose={() => setRightDockTab(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className="reading-dock-pane" hidden={rightDockTab !== 'transcript'}>
              {(rightDockTab === 'transcript' || mountedDockTabs.transcript) && (
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">正在加载原文参照…</div>}>
                  <TranscriptViewer
                    taskId={currentTask.id}
                    baseURL={baseURL}
                    highlightTime={transcriptJumpTime}
                    playbackTime={playbackTime}
                    mediaAvailable={playerAvailable}
                    playerOpen={miniPlayerOpen}
                    translatingCaptions={translatingCaptions}
                    onTranslateCaptions={handleTranslateCaptions}
                    onSeekTime={(sec) => {
                      if (playerAvailable) {
                        seekLocalMedia(sec, true)
                      }
                    }}
                    onTogglePlayer={() => {
                      if (!playerAvailable) return
                      setMiniPlayerOpen(open => !open)
                    }}
                    onClose={() => setRightDockTab(null)}
                  />
                </Suspense>
              )}
            </div>
          </div>
        )}>
        {annoDraft && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px]"
            onClick={() => !annoSaving && setAnnoDraft(null)}
          >
            <div
              role="dialog"
              aria-label="添加正文批注"
              className="w-full max-w-md rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] p-4 shadow-xl backdrop-blur-xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">记批注</h3>
                {annoDraft.sectionTitle && (
                  <span className="max-w-[200px] truncate text-[11px] text-muted-foreground">{annoDraft.sectionTitle}</span>
                )}
              </div>
              <blockquote className="mb-3 line-clamp-2 rounded-lg border-l-2 border-[var(--reading-accent,var(--primary))] bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_8%,transparent)] px-2.5 py-1.5 text-xs text-muted-foreground">
                “{annoDraft.text}”
              </blockquote>
              <div className="space-y-2">
                <input
                  type="text"
                  maxLength={80}
                  placeholder="批注短标题（悬停预览显示）"
                  className="w-full rounded-xl border border-[var(--surface-hairline)] bg-[var(--surface-input)] px-3 py-1.5 text-xs text-foreground outline-none focus:border-[var(--reading-accent,var(--primary))]"
                  value={annoTitleInput}
                  onChange={e => setAnnoTitleInput(e.target.value)}
                />
                <textarea
                  autoFocus
                  rows={4}
                  maxLength={4000}
                  placeholder="写下你的理解、反例或待查事项…（Ctrl+Enter 保存）"
                  className="w-full resize-none rounded-xl border border-[var(--surface-hairline)] bg-[var(--surface-input)] px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus:border-[var(--reading-accent,var(--primary))]"
                  value={annoDetailInput}
                  onChange={e => setAnnoDetailInput(e.target.value)}
                  onKeyDown={e => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                      e.preventDefault()
                      void submitManualAnnotation()
                    }
                  }}
                />
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={annoSaving}
                  className="rounded-full border border-[var(--surface-hairline)] px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAnnoDraft(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={annoSaving || !annoDetailInput.trim()}
                  className="rounded-full bg-[var(--reading-accent,var(--primary))] px-3.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-45"
                  onClick={() => void submitManualAnnotation()}
                >
                  {annoSaving ? '保存中…' : '保存批注'}
                </button>
              </div>
            </div>
          </div>
        )}
        {refinement && currentTask && refinement.taskId === currentTask.id && refinement.versionId === (selectedVersion?.ver_id || currentVerId) && (
          <Suspense fallback={null}>
            <RefineNoteDialog key={`${refinement.taskId}:${refinement.versionId}:${(refinement.sectionIds || []).join(',')}`} task={currentTask} versionId={refinement.versionId} texts={refinement.texts} sectionIds={refinement.sectionIds} originalProtocol={selectedVersion?.protocol} originalModel={modelName && refinementProvider ? { provider_id: refinementProvider, model_name: modelName } : null} onClose={() => setRefinement(null)} onApplied={updated => {
              useTaskStore.setState(state => ({ tasks: state.tasks.map(task => task.id === updated.id ? updated : task) }))
              if (Array.isArray(updated.markdown)) setCurrentVerId(updated.markdown[0]?.ver_id || '')
              setRefinement(null)
              toast.success('已采纳修订稿并保存为新版本，原版本保留')
            }} />
          </Suspense>
        )}
      </ReadingChatLayout>
    </MarkdownHeader>
  )
})

MarkdownViewer.displayName = 'MarkdownViewer'

export default MarkdownViewer
