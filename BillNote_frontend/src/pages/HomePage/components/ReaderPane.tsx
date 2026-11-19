import { ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ListTree, LoaderCircle, Minimize, RotateCcw, X } from 'lucide-react'
import ChoiceSelect from '@/components/ChoiceSelect'
import { useInterfaceStore } from '@/store/interfaceStore'
import { useLibraryStore } from '@/store/libraryStore'
import { readingLabels } from '@/utils/readingStatus'
import { scrollToChapter } from '@/utils/noteOutline'
import { findReadingAnchor, parseReadingPosition, trackReadingPosition, type ReadingPosition } from '@/utils/readingPosition'
import { prepareReadingRestore } from '@/utils/prepareReadingRestore'
import type { LearningStatus } from '@/services/noteLibrary'
import { useReaderToolbar, useToolbarFocusGroup, useWorkspaceTopbar } from '@/layouts/WorkspaceTopbarContext'
import '@/layouts/topbar.css'
import './reader.css'
import ReadingOutline from './ReadingOutline'
import ReadingOutlineRail from './ReadingOutlineRail'
import { attachReaderPan } from '@/utils/readerPan'
import ReaderDisplayMenu from './ReaderDisplayMenu'

const MemoizedOutline = memo(ReadingOutline)
const MemoizedOutlineRail = memo(ReadingOutlineRail)

interface Props {
  taskId: string
  versionId: string
  content: string
  title: string
  children: ReactNode
}

const SETTINGS_KEY = 'bilinote-reader-settings-v1'
function readJSON(key: string) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}
function fingerprint(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(36)
}

function collectAnchorBlocks(root: HTMLElement): HTMLElement[] {
  const structured = root.querySelector('.structured-note-shell')
  if (structured) {
    return Array.from(
      structured.querySelectorAll<HTMLElement>(
        '.note-sec-head, .note-p, .note-table-wrap, .flow-chain, .note-img-wrap, .quiz-anchor-slot',
      ),
    )
  }
  return Array.from(root.querySelectorAll<HTMLElement>('.markdown-body > *'))
}

export default function ReaderPane({ taskId, versionId, content, title, children }: Props) {
  const readerToolbar = useReaderToolbar()
  const workspaceTopbar = useWorkspaceTopbar()
  const reducedMotion = useInterfaceStore(state => state.reducedMotion)
  const scrollBehavior = useCallback((): ScrollBehavior => reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', [reducedMotion])
  const readingStatus = useLibraryStore(state => state.entries[taskId]?.learning_status || 'unread')
  const libraryReady = useLibraryStore(state => state.loadState === 'ready')
  const libraryMutating = useLibraryStore(state => state.isMutating)
  const updateEntries = useLibraryStore(state => state.updateEntries)
  const startReading = useLibraryStore(state => state.startReading)
  const autoAttempted = useRef(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [endDismissed, setEndDismissed] = useState(false)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const statusDisabled = !libraryReady || libraryMutating || statusBusy
  const changeReadingStatus = async (status: LearningStatus) => {
    if (statusDisabled) return
    autoAttempted.current = true
    setStatusBusy(true)
    setStatusError(false)
    try {
      await updateEntries([taskId], { learning_status: status })
      if (status === 'unread') setEndDismissed(true)
    } catch { setStatusError(true) } finally { setStatusBusy(false) }
  }

  const layoutRef = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLDivElement>(null)
  const fallbackToolbarRef = useRef<HTMLDivElement | null>(null)
  const [outlineOverlay, setOutlineOverlay] = useState(false)
  const anchorRef = useRef<{ element: HTMLElement; offset: number } | null>(null)
  const lastArticleWidthRef = useRef(0)
  const anchorTimerRef = useRef<number | undefined>(undefined)
  const [fontSize, setFontSize] = useState(() => {
    const size = readJSON(SETTINGS_KEY)?.fontSize
    return [14, 16, 18, 20, 22].includes(size) ? size : 16
  })
  const [wide, setWide] = useState(() => readJSON(SETTINGS_KEY)?.wide === true)
  const [focus, setFocus] = useState(false)
  const [progress, setProgress] = useState(0)
  const [savedProgress, setSavedProgress] = useState(0)
  const savedPosition = useRef<ReadingPosition | null>(null)
  const positionTracker = useRef<ReturnType<typeof trackReadingPosition> | null>(null)
  const [storageError, setStorageError] = useState(false)
  const [headings, setHeadings] = useState<{
    id: string; text: string; level: number; time?: number
    times?: number[]; ranges?: { start: number; end: number }[]; annoTimes?: number[]
    element: HTMLElement
  }[]>([])
  const headingNodes = useRef<HTMLElement[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineAnimate, setOutlineAnimate] = useState(false)
  const toggleOutline = useCallback((open: boolean) => {
    setOutlineAnimate(true)
    if (open) workspaceTopbar?.closeSidebar?.()
    setOutlineOpen(open)
  }, [workspaceTopbar])
  const closeOutline = useCallback(() => toggleOutline(false), [toggleOutline])
  useEffect(() => {
    const onCloseOutline = () => setOutlineOpen(false)
    window.addEventListener('bilinote-close-outline', onCloseOutline)
    return () => window.removeEventListener('bilinote-close-outline', onCloseOutline)
  }, [])
  const jumpToHeading = useCallback((id: string) => {
    const target = headingNodes.current.find(element => element.id === id)
    if (target) scrollToChapter(target, scrollBehavior())
  }, [scrollBehavior])
  const jumpFromOutline = useCallback((id: string) => {
    jumpToHeading(id)
    if (window.matchMedia('(max-width: 760px)').matches) toggleOutline(false)
  }, [jumpToHeading, toggleOutline])
  const [activeHeading, setActiveHeading] = useState('')
  const refreshActiveHeading = useCallback(() => {
    const element = viewport.current
    if (!element?.clientHeight) return
    const nodes = headingNodes.current
    const top = element.getBoundingClientRect().top + 36
    const current = nodes[Math.max(0, findReadingAnchor(nodes, top))]?.id || ''
    setActiveHeading(current)
  }, [])
  const readingKey = useMemo(() => `bilinote-reader-v1:${taskId}:${versionId}:${fingerprint(content)}`, [taskId, versionId, content])
  const openingPosition = useMemo(() => useInterfaceStore.getState().restoreReadingPosition ? parseReadingPosition(readJSON(readingKey)) : null, [readingKey])
  const [readyKey, setReadyKey] = useState<string | null>(null)
  const opening = Boolean(openingPosition) && readyKey !== readingKey
  const characterCount = useMemo(() => content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s/g, '').length, [content])
  const minutes = Math.max(1, Math.ceil(characterCount / 500))

  const useExternalToolbar = Boolean(readerToolbar) && !focus
  useEffect(() => {
    if (!readerToolbar) return
    readerToolbar.setHasReaderToolbar(!focus)
    return () => readerToolbar.setHasReaderToolbar(false)
  }, [readerToolbar, focus])
  useToolbarFocusGroup(fallbackToolbarRef, !useExternalToolbar)

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ fontSize, wide })) } catch { setStorageError(true) }
  }, [fontSize, wide])

  useLayoutEffect(() => {
    const element = viewport.current
    const body = article.current
    if (!element || !body) return
    const saved = parseReadingPosition(readJSON(readingKey))
    const autoRestore = useInterfaceStore.getState().restoreReadingPosition
    savedPosition.current = saved
    setSavedProgress(autoRestore ? 0 : saved?.progress || 0)
    const tracker = trackReadingPosition(element, body, {
      saved, autoRestore,
      onProgress: next => {
        setProgress(next)
        setShowBackToTop((element.scrollHeight - element.clientHeight) > 80 && element.scrollTop > 140)
      },
      onSave: position => { try { localStorage.setItem(readingKey, JSON.stringify(position)) } catch { setStorageError(true) } },
    })
    positionTracker.current = tracker
    const stopPreparing = openingPosition ? prepareReadingRestore(element, body, tracker.refresh, () => {
      refreshActiveHeading()
      setReadyKey(readingKey)
    }) : undefined
    return () => { stopPreparing?.(); tracker.dispose(); positionTracker.current = null }
  }, [readingKey, openingPosition, refreshActiveHeading])

  useLayoutEffect(() => {
    if (viewport.current) return attachReaderPan(viewport.current)
  }, [readingKey])

  const captureAnchor = useCallback(() => {
    const element = viewport.current
    const body = article.current
    if (!element || !body || !element.clientHeight) return
    if (element.scrollTop <= 4) {
      anchorRef.current = null
      return
    }
    const blocks = collectAnchorBlocks(body)
    if (!blocks.length) return
    const vpRect = element.getBoundingClientRect()
    const focusY = vpRect.top + Math.min(vpRect.height * 0.32, 220)
    const target = blocks[Math.max(0, findReadingAnchor(blocks, focusY))]
    if (!target) return
    anchorRef.current = {
      element: target,
      offset: target.getBoundingClientRect().top - vpRect.top,
    }
  }, [])

  const userInteractedRef = useRef(false)
  const handleViewportScroll = useCallback(() => {
    const element = viewport.current
    if (!element) return
    const max = element.scrollHeight - element.clientHeight
    setShowBackToTop(max > 80 && element.scrollTop > 140)
    // Only refresh the reading anchor when layout width is steady, never mid-reflow.
    const bodyWidth = article.current?.clientWidth || element.clientWidth
    if (Math.abs(bodyWidth - lastArticleWidthRef.current) <= 0.5) {
      window.clearTimeout(anchorTimerRef.current)
      anchorTimerRef.current = window.setTimeout(captureAnchor, 60)
    }
    if (element.clientHeight === 0 || max <= 0) return
    if (max > 40 && max - element.scrollTop <= 8) setReachedEnd(true)
    if (!userInteractedRef.current || element.scrollTop <= 0) return
    const state = useLibraryStore.getState()
    if (autoAttempted.current || state.loadState !== 'ready' || (state.entries[taskId]?.learning_status || 'unread') !== 'unread') return
    autoAttempted.current = true
    void startReading(taskId).catch(() => setStatusError(true))
  }, [taskId, startReading, captureAnchor])

  useLayoutEffect(() => {
    const element = viewport.current
    const body = article.current
    const layout = layoutRef.current
    if (!element || !body) return
    lastArticleWidthRef.current = body.clientWidth || element.clientWidth
    anchorRef.current = null

    const onResize = () => {
      if (layout) {
        if (window.matchMedia('(max-width: 760px)').matches) {
          setOutlineOverlay(true)
        } else if (layout.clientWidth >= 1040) {
          setOutlineOverlay(false)
        } else {
          const contentLeft = body.getBoundingClientRect().left + 20 - layout.getBoundingClientRect().left
          setOutlineOverlay(contentLeft < 10 + 268 + 8)
        }
      }
      const nextWidth = body.clientWidth || element.clientWidth
      if (!lastArticleWidthRef.current) {
        lastArticleWidthRef.current = nextWidth
        return
      }
      if (Math.abs(nextWidth - lastArticleWidthRef.current) <= 0.5) return
      lastArticleWidthRef.current = nextWidth
      const anchor = anchorRef.current
      if (opening || element.scrollTop <= 4 || !anchor?.element.isConnected) return
      const vpTop = element.getBoundingClientRect().top
      const delta = (anchor.element.getBoundingClientRect().top - vpTop) - anchor.offset
      if (Math.abs(delta) > 0.5) {
        const max = Math.max(0, element.scrollHeight - element.clientHeight)
        element.scrollTop = Math.max(0, Math.min(max, element.scrollTop + delta))
      }
    }

    onResize()
    const observer = new ResizeObserver(onResize)
    observer.observe(element)
    observer.observe(body)
    if (layout) observer.observe(layout)

    const snapshotBeforeAction = () => {
      const w = body.clientWidth || element.clientWidth
      if (Math.abs(w - lastArticleWidthRef.current) <= 0.5) captureAnchor()
    }
    window.addEventListener('pointerdown', snapshotBeforeAction, true)
    window.addEventListener('keydown', snapshotBeforeAction, true)
    return () => {
      observer.disconnect()
      window.clearTimeout(anchorTimerRef.current)
      window.removeEventListener('pointerdown', snapshotBeforeAction, true)
      window.removeEventListener('keydown', snapshotBeforeAction, true)
    }
  }, [readingKey, opening, captureAnchor])

  useEffect(() => {
    if (!outlineOpen || !outlineOverlay) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') toggleOutline(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [outlineOpen, outlineOverlay, toggleOutline])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    autoAttempted.current = false
    userInteractedRef.current = false
    setReachedEnd(false)
    setEndDismissed(false)
    setStatusError(false)
    setShowBackToTop(false)
    const markGesture = () => { userInteractedRef.current = true }
    element.addEventListener('wheel', markGesture, { passive: true })
    element.addEventListener('touchmove', markGesture, { passive: true })
    element.addEventListener('pointerdown', markGesture, { passive: true })
    element.addEventListener('keydown', markGesture)
    return () => {
      element.removeEventListener('wheel', markGesture)
      element.removeEventListener('touchmove', markGesture)
      element.removeEventListener('pointerdown', markGesture)
      element.removeEventListener('keydown', markGesture)
    }
  }, [readingKey, taskId])

  useLayoutEffect(() => {
    setOutlineAnimate(false)
    headingNodes.current = Array.from(article.current?.querySelectorAll<HTMLElement>('.markdown-body [data-note-heading]') || [])
    const parseNums = (raw?: string) => raw ? raw.split(',').map(Number).filter(Number.isFinite) : undefined
    const parseRanges = (raw?: string) => {
      if (!raw) return undefined
      try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    }
    setHeadings(headingNodes.current.map(element => ({
      id: element.id, text: element.dataset.noteLabel || element.textContent || '未命名章节', level: Number(element.tagName.slice(1)),
      time: element.dataset.noteTime ? Number(element.dataset.noteTime) : undefined,
      times: parseNums(element.dataset.noteTimes),
      ranges: parseRanges(element.dataset.noteRanges),
      annoTimes: parseNums(element.dataset.noteAnnoTimes),
      element,
    })))
  }, [readingKey])

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    let frame = 0
    let jumping = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      frame = 0
      if (jumping) return
      refreshActiveHeading()
    }
    const finishJump = () => { jumping = false; clearTimeout(settleTimer) }
    const schedule = () => {
      if (jumping) {
        clearTimeout(settleTimer)
        settleTimer = setTimeout(finishJump, 180)
      } else if (!frame) frame = requestAnimationFrame(update)
    }
    const jump = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (!id || !headings.some(heading => heading.id === id)) return
      jumping = true
      setActiveHeading(id)
      clearTimeout(settleTimer)
      settleTimer = setTimeout(finishJump, 180)
    }
    const interruptJump = () => { finishJump(); schedule() }
    const keyScroll = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interruptJump()
    }
    update()
    const geometry = new ResizeObserver(update)
    geometry.observe(element)
    if (article.current) geometry.observe(article.current)
    element.addEventListener('scroll', schedule, { passive: true })
    element.addEventListener('note-chapter-jump', jump)
    element.addEventListener('scrollend', finishJump)
    element.addEventListener('wheel', interruptJump, { passive: true })
    element.addEventListener('touchmove', interruptJump, { passive: true })
    element.addEventListener('pointerdown', interruptJump)
    element.addEventListener('keydown', keyScroll)
    element.addEventListener('load', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      geometry.disconnect()
      cancelAnimationFrame(frame); clearTimeout(settleTimer)
      element.removeEventListener('scroll', schedule); element.removeEventListener('note-chapter-jump', jump)
      element.removeEventListener('scrollend', finishJump); element.removeEventListener('wheel', interruptJump)
      element.removeEventListener('touchmove', interruptJump); element.removeEventListener('pointerdown', interruptJump)
      element.removeEventListener('keydown', keyScroll); element.removeEventListener('load', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [headings, outlineOpen, fontSize, wide, refreshActiveHeading])

  useEffect(() => {
    if (!focus) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setFocus(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [focus])

  const statusChoice = (
    <ChoiceSelect
      label="阅读状态"
      disabled={statusDisabled}
      value={readingStatus}
      onChange={value => void changeReadingStatus(value as LearningStatus)}
      className="reader-status-choice"
      options={Object.entries(readingLabels).map(([value, label]) => ({ value, label }))}
    />
  )

  const outlineButton = (
    <button
      type="button"
      className="workspace-topbar-btn reader-outline-button"
      aria-pressed={outlineOpen}
      title="目录"
      aria-label="目录"
      onClick={() => toggleOutline(!outlineOpen)}
    >
      <ListTree className="h-4 w-4" aria-hidden="true" />
      <span className="topbar-btn-label">目录</span>
    </button>
  )

  const progressPill = (
    <span className="reader-progress" title={`约 ${minutes} 分钟读完 · 已读 ${progress}%`}>
      {progress}%
    </span>
  )

  const externalControls = (
    <>
      {outlineButton}
      <ReaderDisplayMenu fontSize={fontSize} onFontSize={setFontSize} wide={wide} onWide={setWide} onFocus={() => setFocus(true)} />
      {progressPill}
    </>
  )

  return (
    <section
      aria-label="笔记阅读器"
      aria-busy={opening}
      data-reader-opening={opening}
      className={focus ? 'fixed inset-3 z-40 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl' : 'relative flex min-h-0 min-w-0 flex-1 flex-col'}
    >
      {opening && <div className="reader-opening" role="status" aria-label="正在恢复阅读位置"><LoaderCircle className="h-4 w-4 animate-spin" /></div>}
      {useExternalToolbar ? (
        <>
          {readerToolbar?.statusSlot && createPortal(statusChoice, readerToolbar.statusSlot)}
          {readerToolbar?.toolbarSlot && createPortal(externalControls, readerToolbar.toolbarSlot)}
        </>
      ) : (
        <header className="workspace-topbar workspace-topbar--standalone">
          <div className="workspace-tab" title={title}><span>{title}</span></div>
          <div className="workspace-topbar-left">{statusChoice}</div>
          <div
            ref={fallbackToolbarRef}
            role="toolbar"
            {...({ focusgroup: 'toolbar wrap' } as Record<string, string>)}
            aria-label="阅读工具栏"
            className="workspace-topbar-toolbar ml-auto"
          >
            {outlineButton}
            {focus ? (
              <button type="button" className="workspace-topbar-btn" title="退出专注阅读（Esc）" aria-label="退出专注阅读" onClick={() => setFocus(false)}>
                <Minimize className="h-4 w-4" aria-hidden="true" />
                <span className="topbar-btn-label">退出专注</span>
              </button>
            ) : (
              <ReaderDisplayMenu fontSize={fontSize} onFontSize={setFontSize} wide={wide} onWide={setWide} onFocus={() => setFocus(true)} />
            )}
            {progressPill}
          </div>
        </header>
      )}
      {statusError && <p role="alert" className="shrink-0 px-4 py-1.5 text-xs text-destructive">阅读状态保存失败，请重试</p>}
      {storageError && <p className="shrink-0 px-4 py-1 text-xs text-amber-600">本地存储不可用，阅读进度可能无法保留</p>}
      <div ref={layoutRef} className="reader-content-layout" data-reduced-motion={reducedMotion} aria-hidden={opening} inert={opening}>
        <div className={`reading-navigation ${outlineOpen ? 'is-open' : ''} ${headings.length ? '' : 'is-empty'}`} data-animate={outlineAnimate} data-outline-overlay={outlineOverlay ? 'true' : undefined}>
          <div className="reading-navigation-rail" aria-hidden={outlineOpen} inert={outlineOpen}>
            <MemoizedOutlineRail key={readingKey} active={!outlineOpen && !opening} storageKey={readingKey} headings={headings} activeId={outlineOpen ? '' : activeHeading} onJump={jumpToHeading} />
          </div>
          <div className={`reading-outline-shell ${outlineOpen ? 'is-open' : ''}`} aria-hidden={!outlineOpen} inert={!outlineOpen}>
            <MemoizedOutline key={readingKey} headings={headings} activeId={outlineOpen ? activeHeading : ''} onClose={closeOutline} onJump={jumpFromOutline} />
          </div>
        </div>
        <div ref={viewport} data-testid="reader-viewport" tabIndex={0} aria-label="笔记正文" onScroll={handleViewportScroll} onPointerDown={() => { if (outlineOpen && outlineOverlay) toggleOutline(false) }} className="reader-viewport min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
          <div ref={article} className={`reader-body mx-auto w-full px-4 pt-3 pb-16 ${wide ? '' : 'max-w-[860px]'}`} style={{ fontSize }}>{children}</div>
        </div>
        {savedProgress > 0.02 && (
          <div className="reader-float-pill reader-float-pill--top" role="status">
            <span className="reader-float-pill-text">上次读到 {Math.round(savedProgress * 100)}%</span>
            <button
              type="button"
              className="reader-float-pill-action"
              onClick={() => {
                if (savedPosition.current) positionTracker.current?.resume(savedPosition.current)
                setSavedProgress(0)
              }}
            >
              继续阅读
            </button>
            <button
              type="button"
              className="reader-float-pill-icon"
              aria-label="清除阅读位置"
              title="清除阅读位置"
              onClick={() => {
                try { localStorage.removeItem(readingKey); savedPosition.current = null; setSavedProgress(0); positionTracker.current?.reset() } catch { setStorageError(true) }
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button type="button" className="reader-float-pill-icon" aria-label="关闭提示" title="关闭" onClick={() => setSavedProgress(0)}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
        {reachedEnd && !endDismissed && readingStatus !== 'done' && (
          <div className="reader-float-pill reader-float-pill--bottom" role="status">
            <span className="reader-float-pill-text">已到文末</span>
            <button type="button" className="reader-float-pill-action" disabled={statusDisabled} onClick={() => void changeReadingStatus('done')}>
              确认读完
            </button>
            <button type="button" className="reader-float-pill-icon" aria-label="暂不标记" title="暂不" onClick={() => setEndDismissed(true)}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
        <button
          type="button"
          className={`reader-back-to-top ${showBackToTop ? 'is-visible' : ''}`}
          aria-label="回到顶部"
          title="回到顶部"
          tabIndex={showBackToTop ? 0 : -1}
          aria-hidden={!showBackToTop}
          onClick={() => {
            anchorRef.current = null
            viewport.current?.dispatchEvent(new Event('note-chapter-jump'))
            viewport.current?.scrollTo({ top: 0, behavior: scrollBehavior() })
          }}
        >
          <ArrowUp className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}
