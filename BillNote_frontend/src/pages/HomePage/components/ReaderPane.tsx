import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ChevronUp, Expand, MessageSquare, Minimize, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ChoiceSelect from '@/components/ChoiceSelect'
import { useInterfaceStore } from '@/store/interfaceStore'
import { useLibraryStore } from '@/store/libraryStore'
import { readingLabels } from '@/utils/readingStatus'
import { scrollToChapter } from '@/utils/noteOutline'
import type { LearningStatus } from '@/services/noteLibrary'
import './reader.css'

interface Props { taskId: string; versionId: string; content: string; title: string; children: ReactNode; onCompactChange?: (compact: boolean) => void; chatOpen?: boolean; onToggleChat?: () => void }
const SETTINGS_KEY = 'bilinote-reader-settings-v1'
function readJSON(key: string) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}
function fingerprint(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(36)
}

export default function ReaderPane({ taskId, versionId, content, title, children, onCompactChange, chatOpen, onToggleChat }: Props) {
  const reducedMotion = useInterfaceStore(state => state.reducedMotion)
  const scrollBehavior = (): ScrollBehavior => reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  const [compact, setCompact] = useState(false)
  const compactRef = useRef(false)
  const manualExpanded = useRef(false)
  const layoutAnchor = useRef<{ top: number; scroll: number } | null>(null)
  const ignoreScrollUntil = useRef(0)
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
  const viewport = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLDivElement>(null)
  const setToolsCompact = useCallback((next: boolean) => {
    if (compactRef.current === next) return
    const element = viewport.current
    if (element) layoutAnchor.current = !next && element.scrollTop <= 16 ? null : { top: element.getBoundingClientRect().top, scroll: element.scrollTop }
    ignoreScrollUntil.current = Math.max(ignoreScrollUntil.current, Date.now() + 250)
    compactRef.current = next
    setCompact(next)
    onCompactChange?.(next)
  }, [onCompactChange])
  useLayoutEffect(() => {
    const element = viewport.current
    const anchor = layoutAnchor.current
    if (element && anchor) element.scrollTop = Math.max(0, anchor.scroll + element.getBoundingClientRect().top - anchor.top)
    layoutAnchor.current = null
  }, [compact])
  const [fontSize, setFontSize] = useState(() => {
    const size = readJSON(SETTINGS_KEY)?.fontSize
    return [14, 16, 18, 20, 22].includes(size) ? size : 16
  })
  const [wide, setWide] = useState(() => readJSON(SETTINGS_KEY)?.wide === true)
  const [focus, setFocus] = useState(false)
  const [progress, setProgress] = useState(0)
  const [savedProgress, setSavedProgress] = useState(0)
  const [storageError, setStorageError] = useState(false)
  const [headings, setHeadings] = useState<{ text: string; level: number; element: HTMLElement }[]>([])
  const readingKey = useMemo(() => `bilinote-reader-v1:${taskId}:${versionId}:${fingerprint(content)}`, [taskId, versionId, content])
  const characterCount = useMemo(() => content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s/g, '').length, [content])

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ fontSize, wide })) } catch { setStorageError(true) }
  }, [fontSize, wide])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const saved = readJSON(readingKey)
    setSavedProgress(typeof saved === 'number' && Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0)
    element.scrollTop = 0
    setProgress(0)
    let latest: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const save = () => {
      if (latest === null) return
      try { localStorage.setItem(readingKey, JSON.stringify(latest)) } catch { setStorageError(true) }
    }
    const update = () => {
      if (element.clientHeight === 0) return
      const max = element.scrollHeight - element.clientHeight
      latest = max > 0 ? Math.max(0, Math.min(1, element.scrollTop / max)) : 0
      setProgress(Math.round(latest * 100))
      clearTimeout(timer)
      timer = setTimeout(save, 400)
    }
    element.addEventListener('scroll', update, { passive: true })
    window.addEventListener('pagehide', save)
    return () => { clearTimeout(timer); save(); element.removeEventListener('scroll', update); window.removeEventListener('pagehide', save) }
  }, [readingKey])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    autoAttempted.current = false
    compactRef.current = false
    manualExpanded.current = false
    setCompact(false)
    onCompactChange?.(false)
    setReachedEnd(false)
    setEndDismissed(false)
    setStatusError(false)
    let active = true
    let intentUntil = 0
    let previousTop = element.scrollTop
    const intent = () => { intentUntil = Date.now() + 1500 }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      intent()
      // At scrollTop=0 an upward wheel may produce no scroll event at all.
      if (event.deltaY < 0 && element.scrollTop <= 16 && Date.now() >= ignoreScrollUntil.current) {
        manualExpanded.current = false
        setToolsCompact(false)
      }
    }
    const pointer = (event: PointerEvent) => {
      // Only dragging the viewport scrollbar counts; selecting text and clicking links do not.
      if (event.target === element && event.offsetX >= element.clientWidth) intent()
    }
    const clearIntent = () => { intentUntil = 0 }
    const chapterJump = () => { clearIntent(); ignoreScrollUntil.current = Date.now() + 2000 }
    const keyboard = (event: KeyboardEvent) => {
      if (event.target === element && !event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) intent()
    }
    const scrolled = () => {
      const max = element.scrollHeight - element.clientHeight
      const downward = element.scrollTop > previousTop
      previousTop = element.scrollTop
      if (element.clientHeight === 0 || max <= 0 || Date.now() > intentUntil || Date.now() < ignoreScrollUntil.current) return
      if (!downward && element.scrollTop <= 16) {
        manualExpanded.current = false
        setToolsCompact(false)
      } else if (downward && element.scrollTop > 40 && max > 80 && !window.getSelection()?.toString()) {
        // A manual expansion lasts until the next deliberate downward scroll.
        manualExpanded.current = false
        setToolsCompact(true)
      }
      if (element.scrollTop <= 0) return
      if (max - element.scrollTop <= 8) setReachedEnd(true)
      const state = useLibraryStore.getState()
      if (autoAttempted.current || state.loadState !== 'ready' || (state.entries[taskId]?.learning_status || 'unread') !== 'unread') return
      autoAttempted.current = true
      void startReading(taskId).catch(() => { if (active) setStatusError(true) })
    }
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('touchmove', intent, { passive: true })
    element.addEventListener('pointerdown', pointer, { passive: true })
    element.addEventListener('click', clearIntent)
    element.addEventListener('note-chapter-jump', chapterJump)
    element.addEventListener('keydown', keyboard)
    element.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      active = false
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('touchmove', intent)
      element.removeEventListener('pointerdown', pointer)
      element.removeEventListener('click', clearIntent)
      element.removeEventListener('note-chapter-jump', chapterJump)
      element.removeEventListener('keydown', keyboard)
      element.removeEventListener('scroll', scrolled)
    }
  }, [readingKey, taskId, startReading, onCompactChange, setToolsCompact])

  // Keep the last line visible when the confirmation strip takes up space.
  useLayoutEffect(() => {
    if (reachedEnd && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [reachedEnd])

  useEffect(() => {
    setHeadings(Array.from(article.current?.querySelectorAll<HTMLElement>('.markdown-body [data-note-heading]') || []).map(element => ({
      text: element.dataset.noteLabel || element.textContent || '未命名章节', level: Number(element.tagName.slice(1)), element,
    })))
  }, [content])
  useEffect(() => {
    if (!focus) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setFocus(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [focus])

  return <section aria-label="笔记阅读器" className={focus ? 'fixed inset-3 z-40 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
    {focus && <div className="truncate border-b border-border px-4 py-2 text-sm font-medium">{title}</div>}
    <div className={`reader-tools ${compact ? 'reader-tools-compact' : ''}`}>
      <div className="reader-tools-content">
      <ChoiceSelect label="跳转章节" value="" className="reader-chapter-choice" onChange={value => {
        ignoreScrollUntil.current = Date.now() + 2000
        const target = value !== '' ? headings[Number(value)]?.element : null
        if (target) scrollToChapter(target, scrollBehavior())
      }} options={[{ value: '', label: `目录 · ${headings.length} 个章节` }, ...headings.map((heading, index) => ({ value: String(index), label: `${'　'.repeat(Math.min(heading.level - 1, 3))}${heading.text}` }))]} />
      {!compact && <>
      <ChoiceSelect label="阅读字号" value={String(fontSize)} onChange={value => setFontSize(Number(value))} className="reader-size-choice" options={[14, 16, 18, 20, 22].map(size => ({ value: String(size), label: `${size}px` }))} />
      <Button size="sm" variant="ghost" onClick={() => setWide(!wide)} aria-pressed={wide}>{wide ? '舒适宽度' : '铺满宽度'}</Button>
      <Button size="sm" variant="ghost" title={focus ? '退出专注阅读（Esc）' : '专注阅读'} aria-label={focus ? '退出专注阅读' : '专注阅读'} onClick={() => setFocus(!focus)}>{focus ? <Minimize className="h-4 w-4" /> : <Expand className="h-4 w-4" />}</Button>
      <Button size="sm" variant="ghost" title="回到顶部" aria-label="回到顶部" onClick={() => {
        ignoreScrollUntil.current = Date.now() + 2000
        manualExpanded.current = false
        setToolsCompact(false)
        viewport.current?.scrollTo({ top: 0, behavior: scrollBehavior() })
      }}><ArrowUp className="h-4 w-4" /></Button>
      <ChoiceSelect label="阅读状态（由你确认）" disabled={statusDisabled} value={readingStatus} onChange={value => void changeReadingStatus(value as LearningStatus)} className="reader-status-choice" options={Object.entries(readingLabels).map(([value, label]) => ({ value, label }))} />
      {readingStatus !== 'done' && <Button size="sm" variant="ghost" disabled={statusDisabled} onClick={() => void changeReadingStatus('done')}>标记已读完</Button>}
      </>}
      <span className="reader-progress text-muted-foreground">{!compact && `约 ${Math.max(1, Math.ceil(characterCount / 500))} 分钟 · `}{progress}%</span>
      {compact && onToggleChat && <Button size="sm" variant="ghost" aria-pressed={chatOpen} onClick={onToggleChat} title="AI 问答"><MessageSquare className="h-4 w-4" /><span className="reader-compact-label">AI 问答</span></Button>}
      </div>
      <Button size="sm" variant="ghost" className="reader-collapse-toggle" aria-label={compact ? '展开完整工具与笔记信息' : '收起阅读工具'} aria-expanded={!compact} title={compact ? '展开完整工具与笔记信息' : '收起阅读工具'} onClick={() => {
        manualExpanded.current = compact
        setToolsCompact(!compact)
      }}>{compact ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}</Button>
    </div>
    {statusError && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">阅读状态保存失败，原状态已保留。请通过上方阅读状态重试。</p>}
    {!libraryReady && <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">阅读状态暂不可用，仍可继续阅读。</p>}
    {reachedEnd && !endDismissed && readingStatus !== 'done' && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-primary-light px-3 py-2 text-xs">
      <span className="flex-1">已到文末，要标记为已读完吗？</span>
      <Button size="sm" variant="ghost" disabled={statusDisabled} onClick={() => void changeReadingStatus('done')}>确认读完</Button>
      <button type="button" className="rounded px-2 py-1 text-muted-foreground" onClick={() => setEndDismissed(true)}>暂不</button>
    </div>}
    {savedProgress > 0.02 && <div className="flex shrink-0 items-center gap-2 bg-muted/50 px-3 py-1.5 text-xs">
      <span className="flex-1 text-muted-foreground">上次读到 {Math.round(savedProgress * 100)}%</span>
      <button type="button" className="text-primary hover:underline" onClick={() => {
        const element = viewport.current
        ignoreScrollUntil.current = Date.now() + 2000
        if (element) element.scrollTo({ top: (element.scrollHeight - element.clientHeight) * savedProgress, behavior: scrollBehavior() })
        setSavedProgress(0)
      }}>继续阅读</button>
      <button type="button" aria-label="清除阅读位置" title="清除阅读位置" onClick={() => {
        try { localStorage.removeItem(readingKey); setSavedProgress(0); viewport.current?.scrollTo({ top: 0 }); setProgress(0) } catch { setStorageError(true) }
      }}><RotateCcw className="h-3.5 w-3.5" /></button>
    </div>}
    {storageError && <p className="px-3 py-1 text-xs text-amber-600">浏览器存储不可用，阅读位置和偏好可能无法保留。</p>}
    <div ref={viewport} data-testid="reader-viewport" tabIndex={0} aria-label="笔记正文" className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <div ref={article} className={`reader-body mx-auto w-full px-4 py-3 ${wide ? '' : 'max-w-[860px]'}`} style={{ fontSize }}>{children}</div>
    </div>
  </section>
}
