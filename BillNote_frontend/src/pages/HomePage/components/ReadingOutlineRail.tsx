import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark } from 'lucide-react'
import { buildReadingOutline, type ReadingOutlineHeading } from '@/utils/readingOutline'

const CLOSE_GRACE_MS = 180
const BASE_BAR_WIDTH = 10
const HOVER_BAR_WIDTHS = [22, 16, 12, BASE_BAR_WIDTH] as const

/** Collapsed navigation: one marker per overview group, never per paragraph. */
export default function ReadingOutlineRail({ headings, activeId, storageKey, active = true, onJump }: {
  headings: ReadingOutlineHeading[]; activeId: string; storageKey: string; active?: boolean; onJump: (id: string) => void
}) {
  const { groups } = useMemo(() => buildReadingOutline(headings), [headings])
  const [preview, setPreview] = useState<{ id: string; y: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const [sliding, setSliding] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [justBookmarkedId, setJustBookmarkedId] = useState<string | null>(null)

  const railRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visibleRef = useRef(false)
  visibleRef.current = visible

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (unmountTimer.current !== null) {
      clearTimeout(unmountTimer.current)
      unmountTimer.current = null
    }
  }

  const hideImmediate = () => {
    cancelClose()
    setVisible(false)
    setSliding(false)
    setHoveredId(null)
    unmountTimer.current = setTimeout(() => {
      setPreview(null)
      unmountTimer.current = null
    }, 170)
  }

  const scheduleHide = () => {
    cancelClose()
    // Keep the hovercard reachable while the pointer crosses diagonally to click or bookmark.
    closeTimer.current = setTimeout(() => {
      setVisible(false)
      setSliding(false)
      setHoveredId(null)
      closeTimer.current = null
      unmountTimer.current = setTimeout(() => {
        setPreview(null)
        unmountTimer.current = null
      }, 170)
    }, CLOSE_GRACE_MS)
  }

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    if (unmountTimer.current !== null) clearTimeout(unmountTimer.current)
    if (popTimer.current !== null) clearTimeout(popTimer.current)
  }, [])

  useEffect(() => {
    if (!active) {
      hideImmediate()
      setPreview(null)
    }
  }, [active])

  const bookmarkKey = `${storageKey}:outline-bookmarks`
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(bookmarkKey) || '[]')
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(0, 1000) : []
    } catch { return [] }
  })
  const [saveError, setSaveError] = useState(false)

  const toggleBookmark = (id: string) => {
    const adding = !bookmarks.includes(id)
    const next = adding ? [...bookmarks, id] : bookmarks.filter(item => item !== id)
    setBookmarks(next)
    if (adding) {
      setJustBookmarkedId(id)
      if (popTimer.current !== null) clearTimeout(popTimer.current)
      popTimer.current = setTimeout(() => { setJustBookmarkedId(null); popTimer.current = null }, 260)
    }
    try { localStorage.setItem(bookmarkKey, JSON.stringify(next)); setSaveError(false) } catch { setSaveError(true) }
  }

  const activeIndex = headings.findIndex(item => item.id === activeId)
  const current = activeIndex < 0 ? undefined : groups.find(group => group.items.some(item => item.id === activeId))
    || groups.filter(group => headings.findIndex(item => item.id === group.title.id) <= activeIndex).at(-1)
  const selected = active && preview ? groups.find(group => group.id === preview.id) : undefined

  if (!groups.length) return null

  const computeCardY = (element: HTMLButtonElement): number => {
    const rail = railRef.current?.getBoundingClientRect()
    if (!rail) return 8
    const button = element.getBoundingClientRect()
    const cardHeight = previewRef.current?.offsetHeight || 74
    const centered = (button.top + button.height / 2) - rail.top - cardHeight / 2
    return Math.round(Math.max(8, Math.min(centered, Math.max(8, rail.height - cardHeight - 8))))
  }

  const showForButton = (element: HTMLButtonElement, id: string) => {
    if (!active) return
    cancelClose()
    const nextY = computeCardY(element)
    const alreadyOpen = visibleRef.current
    setSliding(alreadyOpen)
    setPreview(prev => (prev && prev.id === id && prev.y === nextY ? prev : { id, y: nextY }))
    if (!alreadyOpen) setVisible(true)
  }

  const syncFromPointer = (clientX: number, clientY: number) => {
    const nav = navRef.current
    if (!active || !nav) return
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('.reading-outline-rail-marker'))
    if (!buttons.length) return
    const rail = nav.getBoundingClientRect()
    const cells = buttons.map(button => {
      const rect = button.getBoundingClientRect()
      return { button, rect, centerY: rect.top + rect.height / 2 }
    })
    if (
      clientX < rail.left
      || clientX > rail.right
      || clientY < cells[0].rect.top - 6
      || clientY > cells[cells.length - 1].rect.bottom + 6
    ) {
      scheduleHide()
      return
    }
    const nearest = cells.reduce((best, cell) => (
      Math.abs(clientY - cell.centerY) < Math.abs(clientY - best.centerY) ? cell : best
    ))
    const idx = buttons.indexOf(nearest.button)
    const group = groups[idx]
    if (!group) return
    if (hoveredId !== group.id) setHoveredId(group.id)
    showForButton(nearest.button, group.id)
  }

  const hoveredIndex = groups.findIndex(group => group.id === hoveredId)

  return (
    <div
      ref={railRef}
      className="reading-outline-rail"
      onMouseLeave={scheduleHide}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideImmediate() }}
      onKeyDown={event => { if (event.key === 'Escape') hideImmediate() }}
    >
      <nav
        ref={navRef}
        className="reading-outline-rail-markers"
        aria-label="大分类快捷目录"
        onScroll={hideImmediate}
        onMouseLeave={scheduleHide}
        onMouseMove={event => syncFromPointer(event.clientX, event.clientY)}
      >
        {groups.map((group, index) => {
          const isCurrent = current?.id === group.id
          const barWidth = hoveredIndex < 0
            ? BASE_BAR_WIDTH
            : HOVER_BAR_WIDTHS[Math.min(HOVER_BAR_WIDTHS.length - 1, Math.abs(index - hoveredIndex))]
          const isEmphasized = hoveredId === group.id
          const isBookmarked = bookmarks.includes(group.id)
          return (
            <button
              key={group.id}
              type="button"
              className="reading-outline-rail-marker"
              aria-label={`跳转分类：${group.title.text}${isBookmarked ? '（已标重）' : ''}`}
              aria-current={isCurrent ? 'location' : undefined}
              onFocus={event => {
                setHoveredId(group.id)
                showForButton(event.currentTarget, group.id)
              }}
              onClick={() => { onJump(group.title.id); hideImmediate() }}
            >
              <span className={isEmphasized ? 'is-emphasized' : ''} style={{ width: barWidth }} />
              {isBookmarked && <i className="reading-outline-bookmark-dot" aria-hidden="true" />}
            </button>
          )
        })}
      </nav>

      {selected && preview && (
        <div
          ref={previewRef}
          className={`reading-outline-rail-preview ${visible ? 'is-open' : ''} ${sliding ? 'is-sliding' : ''}`}
          role="group"
          aria-label="分类预览"
          aria-hidden={!visible}
          style={{ '--preview-y': `${preview.y}px` } as CSSProperties}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleHide}
          onFocus={cancelClose}
        >
          <button
            type="button"
            className="reading-outline-preview-main"
            tabIndex={visible ? 0 : -1}
            onClick={() => { onJump(selected.title.id); hideImmediate() }}
          >
            <strong>{selected.title.text}</strong>
            <span>
              {selected.items.length} 个章节
              {current?.id === selected.id ? ' · 当前分类' : ''}
              {bookmarks.includes(selected.id) ? ' · 已标重' : ''}
            </span>
          </button>
          <button
            type="button"
            className={`reading-outline-bookmark ${justBookmarkedId === selected.id ? 'is-pop' : ''}`}
            tabIndex={visible ? 0 : -1}
            aria-label={bookmarks.includes(selected.id) ? '取消标重' : '标重此分类'}
            aria-pressed={bookmarks.includes(selected.id)}
            title={bookmarks.includes(selected.id) ? '取消标重' : '标重此分类'}
            onClick={() => toggleBookmark(selected.id)}
          >
            <Bookmark size={16} strokeWidth={1.7} fill={bookmarks.includes(selected.id) ? 'currentColor' : 'none'} aria-hidden="true" />
          </button>
          {saveError && <small role="status">本机保存失败，标重仅在本次打开时保留。</small>}
        </div>
      )}
    </div>
  )
}
