'use client'

import { useTaskStore } from '@/store/taskStore'
import { scrollMotion } from '@/utils/motion'
import { useEffect, useState, useRef } from 'react'
import { Play, ScrollText, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { noteMediaStreamUrl } from '@/services/note'

interface Segment {
  start: number
  end: number
  text: string
  speaker?: string
}

interface Task {
  id?: string
  transcript?: {
    segments?: Segment[]
  }
}

const TranscriptViewer = ({
  onClose,
  highlightTime,
  taskId,
  baseURL = '',
}: {
  onClose?: () => void
  highlightTime?: number | null
  taskId?: string
  baseURL?: string
}) => {
  const getCurrentTask = useTaskStore(state => state.getCurrentTask)
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const [task, setTask] = useState<Task | null>(null)
  const [activeSegment, setActiveSegment] = useState<number | null>(null)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [mediaUnavailable, setMediaUnavailable] = useState(false)
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const effectiveTaskId = taskId || currentTaskId || ''
  const mediaUrl = effectiveTaskId ? noteMediaStreamUrl(baseURL, effectiveTaskId) : ''

  useEffect(() => {
    setTask(getCurrentTask())
    setActiveSegment(null)
    setMediaUnavailable(false)
  }, [currentTaskId, getCurrentTask])

  const seekMedia = (seconds: number, autoPlay = true) => {
    const video = videoRef.current
    if (!video || mediaUnavailable) return
    try {
      video.currentTime = Math.max(0, seconds)
      if (autoPlay) void video.play().catch(() => undefined)
    } catch { /* Media metadata may still be loading. */ }
  }

  useEffect(() => {
    if (highlightTime == null) return
    const list = task?.transcript?.segments || []
    const matchedIndex = list.findIndex(seg => seg.end >= highlightTime)
    if (matchedIndex >= 0) {
      setActiveSegment(matchedIndex)
      segmentRefs.current[matchedIndex]?.scrollIntoView({ behavior: scrollMotion(), block: 'nearest' })
    }
    if (!mediaUnavailable && mediaUrl) {
      setMediaOpen(true)
      requestAnimationFrame(() => seekMedia(highlightTime, true))
    }
  }, [highlightTime, task, mediaUnavailable, mediaUrl])

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleSegmentClick = (index: number, start: number) => {
    setActiveSegment(index)
    segmentRefs.current[index]?.scrollIntoView({
      behavior: scrollMotion(),
      block: 'nearest',
    })
    if (mediaOpen && !mediaUnavailable) seekMedia(start, true)
  }

  const segments = task?.transcript?.segments || []
  const totalDuration = segments.length > 0 ? formatTime(segments[segments.length - 1]?.end || 0) : ''

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
        {mediaUrl && !mediaUnavailable && (
          <button
            type="button"
            aria-pressed={mediaOpen}
            title={mediaOpen ? '收起原片播放器' : '展开本地原片回看'}
            aria-label={mediaOpen ? '收起原片播放器' : '展开本地原片回看'}
            onClick={() => setMediaOpen(open => !open)}
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
      {mediaOpen && mediaUrl && !mediaUnavailable && (
        <div className="shrink-0 border-b border-[var(--surface-hairline)] bg-black/90 p-2">
          <video
            ref={videoRef}
            controls
            preload="metadata"
            src={mediaUrl}
            className="max-h-48 w-full rounded-lg bg-black"
            onLoadedMetadata={() => {
              if (highlightTime != null) seekMedia(highlightTime, false)
            }}
            onError={() => {
              setMediaUnavailable(true)
              setMediaOpen(false)
            }}
          />
        </div>
      )}
      {!segments.length ? (
        <div className="flex flex-1 items-center justify-center p-4 text-xs text-muted-foreground">暂无转写内容</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          <div className="space-y-1">
            {segments.map((segment, index) => (
              <button
                key={index}
                type="button"
                data-transcript-start={segment.start}
                data-transcript-end={segment.end}
                ref={el => { segmentRefs.current[index] = el }}
                aria-pressed={activeSegment === index}
                className={cn(
                  'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--primary)]',
                  activeSegment === index && 'bg-[var(--surface-selected)]',
                )}
                onClick={() => handleSegmentClick(index, segment.start)}
              >
                <span className={cn(
                  'mt-0.5 w-11 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground',
                  activeSegment === index && 'font-medium text-[var(--primary)]',
                )}>
                  {formatTime(segment.start)}
                </span>
                <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground">
                  {segment.speaker && (
                    <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                      {segment.speaker}
                    </span>
                  )}
                  {segment.text}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}

export default TranscriptViewer
