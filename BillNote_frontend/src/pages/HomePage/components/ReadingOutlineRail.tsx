import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark } from 'lucide-react'
import { buildReadingOutline, type ReadingOutlineHeading } from '@/utils/readingOutline'

/** Collapsed navigation: one marker per overview group, never per paragraph. */
export default function ReadingOutlineRail({ headings, activeId, storageKey, active = true, onJump }: {
  headings: ReadingOutlineHeading[]; activeId: string; storageKey: string; active?: boolean; onJump: (id: string) => void
}) {
  const { groups } = useMemo(() => buildReadingOutline(headings), [headings])
  const [preview, setPreview] = useState<{ id: string; top: number } | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const hide = () => { cancelClose(); setPreview(null); setHoveredId(null) }
  const leaveMarker = () => {
    cancelClose()
    // Allow the pointer to cross the small gap into the preview's bookmark control.
    closeTimer.current = setTimeout(() => { setPreview(null); setHoveredId(null); closeTimer.current = null }, 120)
  }
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    if (!active) {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current)
      closeTimer.current = null
      setPreview(null); setHoveredId(null)
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
    const next = bookmarks.includes(id) ? bookmarks.filter(item => item !== id) : [...bookmarks, id]
    setBookmarks(next)
    try { localStorage.setItem(bookmarkKey, JSON.stringify(next)); setSaveError(false) } catch { setSaveError(true) }
  }
  const activeIndex = headings.findIndex(item => item.id === activeId)
  const current = activeIndex < 0 ? undefined : groups.find(group => group.items.some(item => item.id === activeId))
    || groups.filter(group => headings.findIndex(item => item.id === group.title.id) <= activeIndex).at(-1)
  const selected = active ? groups.find(group => group.id === preview?.id) : undefined
  // Pointer position alone controls lengths; reading progress only affects color.
  const center = groups.findIndex(group => group.id === hoveredId)
  if (!groups.length) return null
  const show = (element: HTMLButtonElement, id: string) => {
    if (!active) return
    cancelClose()
    const rail = element.closest('.reading-outline-rail')!.getBoundingClientRect()
    const button = element.getBoundingClientRect()
    setPreview({ id, top: Math.max(8, Math.min(button.top - rail.top - 12, rail.height - 100)) })
  }
  return <div className="reading-outline-rail" onMouseLeave={hide}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide() }}
    onKeyDown={event => { if (event.key === 'Escape') hide() }}>
    <nav className="reading-outline-rail-markers" aria-label="大分类快捷目录" onScroll={hide} onMouseLeave={leaveMarker} onMouseMove={event => {
      if (!active) return
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.reading-outline-rail-marker'))
      const cells = buttons.map(button => ({ button, rect: button.getBoundingClientRect() }))
      const rail = event.currentTarget.getBoundingClientRect()
      // Use one fixed hover band: animated widths and rounded mouse coordinates
      // must not change which row owns the pointer at a button/gap boundary.
      if (!cells.length || event.clientX < rail.left || event.clientX > rail.right
        || event.clientY < cells[0].rect.top || event.clientY > cells.at(-1)!.rect.bottom) {
        leaveMarker()
        return
      }
      const nearest = cells.reduce((best, cell) => Math.abs(event.clientY - (cell.rect.top + cell.rect.height / 2))
        < Math.abs(event.clientY - (best.rect.top + best.rect.height / 2)) ? cell : best)
      const group = groups[buttons.indexOf(nearest.button)]
      setHoveredId(group.id)
      show(nearest.button, group.id)
    }}>
      {groups.map((group, index) => <button key={group.id} type="button" className="reading-outline-rail-marker"
        aria-label={`跳转分类：${group.title.text}${bookmarks.includes(group.id) ? '（已标重）' : ''}`} aria-current={current?.id === group.id ? 'location' : undefined}
        onFocus={event => show(event.currentTarget, group.id)}
        onClick={() => { onJump(group.title.id); hide() }}>
        <span className={index === center ? 'is-emphasized' : ''} style={{ width: center < 0 ? 7 : [30, 23, 17, 11, 7][Math.min(4, Math.abs(index - center))] }} />
        {bookmarks.includes(group.id) && <i className="reading-outline-bookmark-dot" aria-hidden="true" />}
      </button>)}
    </nav>
    {selected && preview && <div className="reading-outline-rail-preview" role="group" aria-label="分类预览" style={{ top: preview.top }} onMouseEnter={cancelClose} onMouseLeave={hide} onFocus={cancelClose}>
      <div className="reading-outline-preview-heading"><strong>{selected.title.text}</strong>
        <button type="button" className="reading-outline-bookmark" aria-label={bookmarks.includes(selected.id) ? '取消标重' : '标重此分类'} aria-pressed={bookmarks.includes(selected.id)} onClick={() => toggleBookmark(selected.id)}>
          <Bookmark size={17} fill={bookmarks.includes(selected.id) ? 'currentColor' : 'none'} />
        </button>
      </div><span>{selected.items.length} 个章节{current?.id === selected.id ? ' · 当前分类' : ''}{bookmarks.includes(selected.id) ? ' · 已标重' : ''}</span>
      {saveError && <small role="status">本机保存失败，标重仅在本次打开时保留。</small>}
    </div>}
  </div>
}
