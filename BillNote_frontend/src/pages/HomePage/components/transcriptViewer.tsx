'use client'

import { useTaskStore } from '@/store/taskStore'
import { scrollMotion } from '@/utils/motion'
import {
  findSegmentIndexForTime,
  formatMediaTime,
  hasTranslatedCaptions,
  hasUntranslatedCaptions,
  isForeignTranscript,
} from '@/utils/mediaTranscriptSync'
import { useEffect, useMemo, useState, useRef } from 'react'
import { Languages, Loader2, Play, RefreshCw, ScrollText, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Segment {
  start: number
  end: number
  text: string
  translated_text?: string
  speaker?: string
}

const TranscriptViewer = ({
  onClose,
  highlightTime,
  playbackTime,
  taskId,
  mediaAvailable = false,
  playerOpen = false,
  translatingCaptions = false,
  onTranslateCaptions,
  onSeekTime,
  onTogglePlayer,
}: {
  onClose?: () => void
  highlightTime?: number | null
  playbackTime?: number | null
  taskId?: string
  baseURL?: string
  mediaAvailable?: boolean
  playerOpen?: boolean
  translatingCaptions?: boolean
  onTranslateCaptions?: (options?: { force?: boolean }) => void | Promise<void>
  onSeekTime?: (seconds: number) => void
  onTogglePlayer?: () => void
}) => {
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const resolvedTaskId = taskId || currentTaskId
  const task = useTaskStore(state => state.tasks.find(item => item.id === resolvedTaskId) || null)
  const [activeSegment, setActiveSegment] = useState<number | null>(null)
  const [showTranslation, setShowTranslation] = useState(true)
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([])
  const lastScrolledIdxRef = useRef<number | null>(null)

  useEffect(() => {
    setActiveSegment(null)
    lastScrolledIdxRef.current = null
  }, [resolvedTaskId])

  const segments: Segment[] = task?.transcript?.segments || []
  const hasTranslation = useMemo(() => hasTranslatedCaptions(segments), [segments])
  const hasUntranslated = useMemo(() => hasUntranslatedCaptions(segments), [segments])
  const needsTranslation = useMemo(() => !hasTranslation && isForeignTranscript(segments), [hasTranslation, segments])

  // 响应外部显式跳转时间点（点击笔记时间戳或引用跳转）
  useEffect(() => {
    if (highlightTime == null) return
    const matchedIndex = findSegmentIndexForTime(segments, highlightTime)
    if (matchedIndex >= 0) {
      setActiveSegment(matchedIndex)
      lastScrolledIdxRef.current = matchedIndex
      segmentRefs.current[matchedIndex]?.scrollIntoView({ behavior: scrollMotion(), block: 'nearest' })
    }
  }, [highlightTime, segments])

  // 响应底部原声回看条实时播放进度，平滑跟随高亮对应转写段
  useEffect(() => {
    if (playbackTime == null) return
    const matchedIndex = findSegmentIndexForTime(segments, playbackTime)
    if (matchedIndex >= 0 && matchedIndex !== lastScrolledIdxRef.current) {
      setActiveSegment(matchedIndex)
      lastScrolledIdxRef.current = matchedIndex
      segmentRefs.current[matchedIndex]?.scrollIntoView({ behavior: scrollMotion(), block: 'nearest' })
    }
  }, [playbackTime, segments])

  const handleSegmentClick = (index: number, start: number) => {
    setActiveSegment(index)
    lastScrolledIdxRef.current = index
    segmentRefs.current[index]?.scrollIntoView({
      behavior: scrollMotion(),
      block: 'nearest',
    })
    onSeekTime?.(start)
  }

  const totalDuration = segments.length > 0 ? formatMediaTime(segments[segments.length - 1]?.end || 0) : ''

  return (
    <aside className="transcript-viewer select-text flex h-full min-h-0 w-full flex-col bg-[var(--surface-page)]" aria-label="原文参照">
      <header className="reading-chat-header">
        <ScrollText size={14} strokeWidth={1.6} aria-hidden="true" />
        <strong className="text-[13px]">原文参照</strong>
        {segments.length > 0 && (
          <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">
            {segments.length} 段 · {totalDuration}
          </span>
        )}
        <div className="flex-1" />
        {(hasTranslation || (needsTranslation && onTranslateCaptions)) && (
          <button
            type="button"
            disabled={translatingCaptions}
            aria-pressed={hasTranslation ? showTranslation : undefined}
            title={
              translatingCaptions
                ? '正在翻译字幕…'
                : hasTranslation
                  ? (showTranslation ? '隐藏中文译文' : '显示中文译文')
                  : '翻译外语字幕为中文'
            }
            aria-label={
              translatingCaptions
                ? '正在翻译字幕'
                : hasTranslation
                  ? (showTranslation ? '隐藏中文译文' : '显示中文译文')
                  : '翻译外语字幕为中文'
            }
            onClick={(event) => {
              if (event.shiftKey && onTranslateCaptions) {
                void onTranslateCaptions({ force: true })
                return
              }
              if (hasTranslation) {
                setShowTranslation(prev => !prev)
              } else if (onTranslateCaptions) {
                void onTranslateCaptions()
              }
            }}
          >
            {translatingCaptions ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <Languages size={13} strokeWidth={1.7} aria-hidden="true" />
            )}
          </button>
        )}
        {hasTranslation && onTranslateCaptions && (
          <button
            type="button"
            disabled={translatingCaptions}
            title={
              translatingCaptions
                ? '正在重新翻译字幕…'
                : hasUntranslated
                  ? '补译缺失字幕（Shift+点击强制重译全部）'
                  : '重新翻译全部字幕'
            }
            aria-label={hasUntranslated ? '补译缺失字幕' : '重新翻译全部字幕'}
            onClick={(event) => {
              if (hasUntranslated && !event.shiftKey) {
                void onTranslateCaptions({ force: false })
              } else {
                void onTranslateCaptions({ force: true })
              }
            }}
          >
            <RefreshCw size={12.5} strokeWidth={1.7} className={translatingCaptions ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        )}
        {mediaAvailable && onTogglePlayer && (
          <button
            type="button"
            aria-pressed={playerOpen}
            title={playerOpen ? '收起原声回看条' : '展开原声回看条'}
            aria-label={playerOpen ? '收起原声回看条' : '展开原声回看条'}
            onClick={onTogglePlayer}
          >
            <Play size={13} strokeWidth={1.7} aria-hidden="true" />
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} title="关闭原文参照" aria-label="关闭原文参照">
            <X size={15} strokeWidth={1.6} aria-hidden="true" />
          </button>
        )}
      </header>
      {!segments.length ? (
        <div className="flex flex-1 items-center justify-center p-4 text-xs text-muted-foreground">暂无转写内容</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          <div className="space-y-1">
            {segments.map((segment, index) => {
              const isActive = activeSegment === index
              return (
                <button
                  key={index}
                  type="button"
                  data-transcript-start={segment.start}
                  data-transcript-end={segment.end}
                  data-transcript-active={isActive ? 'true' : undefined}
                  ref={el => { segmentRefs.current[index] = el }}
                  aria-pressed={isActive}
                  className={cn(
                    'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--primary)]',
                    isActive && 'bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_11%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--reading-accent,var(--primary))_24%,transparent)]',
                  )}
                  onClick={() => handleSegmentClick(index, segment.start)}
                >
                  <span className={cn(
                    'mt-0.5 w-11 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground',
                    isActive && 'font-semibold text-[var(--reading-accent,var(--primary))]',
                  )}>
                    {formatMediaTime(segment.start)}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground">
                    {segment.speaker && (
                      <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                        {segment.speaker}
                      </span>
                    )}
                    {showTranslation && segment.translated_text ? (
                      <>
                        <span className="block">{segment.translated_text}</span>
                        <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                          {segment.text}
                        </span>
                      </>
                    ) : (
                      segment.text
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </aside>
  )
}

export default TranscriptViewer
