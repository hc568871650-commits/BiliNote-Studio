import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ImperativePanelGroupHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import {
  constrainedReaderPercent, DEFAULT_READER_PERCENT, readingChatConstraints,
  readReaderPreference, saveReaderPreference,
} from './readingChatLayoutState'
import './reading-chat-layout.css'

type ReadingChatLayoutProps = {
  mode: 'closed' | 'half' | 'full'
  reader: ReactNode
  chat: ReactNode
  onCloseChat: () => void
  children?: ReactNode
}

function localStorageOrUndefined() {
  try { return window.localStorage } catch { return undefined }
}

const resizeKeys = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

export default function ReadingChatLayout({ mode, reader, chat, onCloseChat, children }: ReadingChatLayoutProps) {
  const root = useRef<HTMLDivElement>(null)
  const group = useRef<ImperativePanelGroupHandle>(null)
  const preferred = useRef(readReaderPreference(localStorageOrUndefined()))
  const [width, setWidth] = useState(0)
  const id = useId()
  const { narrow, minReader, maxReader } = readingChatConstraints(width)
  const split = mode === 'half' && !narrow
  const opener = useRef<HTMLElement | null>(null)
  const previousMode = useRef(mode)

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Keep the user's preferred ratio separate from temporary window constraints.
  useLayoutEffect(() => {
    if (split) {
      const readerSize = constrainedReaderPercent(preferred.current, width)
      group.current?.setLayout([readerSize, 100 - readerSize])
    }
  }, [split, width])

  useLayoutEffect(() => {
    const before = previousMode.current
    previousMode.current = mode
    if (before === 'closed' && mode !== 'closed') opener.current = document.activeElement as HTMLElement
    if (mode === 'closed' && before !== 'closed' && root.current?.querySelector('[data-reading-chat-panel]')?.contains(document.activeElement)) {
      if (opener.current?.isConnected && !opener.current.closest('[inert]')) opener.current.focus()
      else root.current?.querySelector<HTMLElement>('[data-reading-reader-panel] button')?.focus()
    }
  }, [mode])

  const rememberLayout = () => {
    if (!split) return
    const size = group.current?.getLayout()[0]
    if (size === undefined) return
    preferred.current = size
    saveReaderPreference(size, localStorageOrUndefined())
  }
  const reset = () => {
    preferred.current = DEFAULT_READER_PERCENT
    saveReaderPreference(DEFAULT_READER_PERCENT, localStorageOrUndefined())
    const size = constrainedReaderPercent(DEFAULT_READER_PERCENT, width)
    group.current?.setLayout([size, 100 - size])
  }
  const hideReader = mode === 'full' || (mode === 'half' && narrow)

  return <div ref={root} className="reading-workspace reading-chat-layout" data-chat-layout-mode={mode} data-chat-layout-narrow={narrow}>
    <ResizablePanelGroup ref={group} direction="horizontal" className="reading-chat-layout-group" keyboardResizeBy={2}>
      <ResizablePanel id={`${id}-reader`} order={1} defaultSize={preferred.current} minSize={minReader} maxSize={maxReader}
        className="reading-chat-layout-reader" data-reading-reader-panel aria-hidden={hideReader} inert={hideReader}>
        {reader}
      </ResizablePanel>
      <ResizableHandle id={`${id}-separator`} className="reading-chat-layout-handle" disabled={!split} tabIndex={split ? 0 : -1}
        aria-label="阅读与聊天宽度" aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"
        title="拖动或方向键调整宽度；Enter / 双击恢复默认"
        onDragging={dragging => { if (!dragging) rememberLayout() }}
        onKeyUp={event => { if (resizeKeys.has(event.key)) rememberLayout() }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); reset() } }}
        onDoubleClick={reset} />
      <ResizablePanel id={`${id}-chat`} order={2} defaultSize={100 - preferred.current} minSize={100 - maxReader} maxSize={100 - minReader}
        className="reading-chat-layout-chat" data-reading-chat-panel aria-hidden={mode === 'closed'} inert={mode === 'closed'}>
        {narrow && mode === 'half' && <div className="reading-chat-layout-narrow-bar"><span>窗口较窄</span><button type="button" onClick={onCloseChat}>返回阅读</button></div>}
        <div className="reading-chat-layout-chat-content">{chat}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
    {children}
  </div>
}
