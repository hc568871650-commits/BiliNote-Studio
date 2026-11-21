import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HairlineCloseIcon } from '@/pages/HomePage/components/StructuredNoteReader/AnnotationIcons'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import { useTaskStore } from '@/store/taskStore'
import type { DistillNotificationItem } from '@/utils/distillNotifications'
import './distill-queue.css'

const AUTO_DISMISS_MS = 8500

type DocumentWithAriaNotify = Document & {
  ariaNotify?: (message: string, options?: { priority?: 'normal' | 'high' }) => void
}

function ToastCard({
  item,
  onOpenNote,
  onOpenQueue,
  onDismiss,
}: {
  item: DistillNotificationItem
  onOpenNote: (taskId: string) => void
  onOpenQueue: () => void
  onDismiss: (id: string) => void
}) {
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => {
      // 存在模态弹窗时暂缓自动收起，避免用户关闭模态后错过通知
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      onDismiss(item.id)
    }, AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [item.id, onDismiss, paused])

  const isFailed = item.kind === 'single_failed' || (item.succeededCount === 0 && item.failedCount > 0)

  return (
    <article
      className="distill-queue-surface distill-toast-card"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaused(false)
        }
      }}
    >
      <div className="distill-toast-head">
        <span
          className={`distill-toast-indicator ${isFailed ? 'distill-toast-indicator--failed' : ''}`}
          aria-hidden="true"
        />
        <div className="distill-toast-copy">
          <div className="distill-toast-title">{item.title}</div>
          <div className="distill-toast-detail">{item.detail}</div>
        </div>
        <button
          type="button"
          className="distill-queue-close"
          aria-label={`关闭提醒：${item.title}`}
          title="关闭"
          onClick={() => onDismiss(item.id)}
        >
          <HairlineCloseIcon size={14} />
        </button>
      </div>

      <div className="distill-toast-actions">
        <button
          type="button"
          className="distill-job-action-btn"
          onClick={() => {
            onOpenQueue()
            onDismiss(item.id)
          }}
        >
          查看队列
        </button>
        {item.taskId && (
          <button
            type="button"
            className="distill-job-action-btn distill-job-action-btn--accent"
            onClick={() => {
              onOpenNote(item.taskId!)
              onDismiss(item.id)
            }}
          >
            {isFailed ? '查看诊断' : '打开阅读'}
          </button>
        )}
      </div>
    </article>
  )
}

export default function DistillQueueToast() {
  const navigate = useNavigate()
  const toasts = useDistillQueueStore(state => state.toasts)
  const dismissToast = useDistillQueueStore(state => state.dismissToast)
  const setPanelOpen = useDistillQueueStore(state => state.setPanelOpen)
  const [liveAnnouncement, setLiveAnnouncement] = useState('')
  const announcedIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const newest = toasts[0]
    if (!newest || announcedIdsRef.current.has(newest.id)) return
    announcedIdsRef.current.add(newest.id)
    const message = `${newest.title}：${newest.detail}。可执行操作`
    const doc = document as DocumentWithAriaNotify
    if (typeof doc.ariaNotify === 'function') {
      try {
        doc.ariaNotify(message, { priority: 'normal' })
        return
      } catch {
        // 降级到预置 aria-live 区域
      }
    }
    setLiveAnnouncement(message)
  }, [toasts])

  const openNote = (taskId: string) => {
    const taskStore = useTaskStore.getState()
    taskStore.setCurrentTask(taskId)
    void taskStore.loadTask(taskId).catch(() => undefined)
    navigate('/?view=read')
  }

  return (
    <>
      <div className="distill-sr-only">
        <p>蒸馏队列播报</p>
        <div role="status" aria-live="polite" aria-atomic="true">
          {liveAnnouncement}
        </div>
      </div>

      <div
        className="distill-toast-region"
        role="region"
        aria-label="蒸馏完成通知"
      >
        {toasts.map(item => (
          <ToastCard
            key={item.id}
            item={item}
            onOpenNote={openNote}
            onOpenQueue={() => setPanelOpen(true)}
            onDismiss={dismissToast}
          />
        ))}
      </div>
    </>
  )
}
