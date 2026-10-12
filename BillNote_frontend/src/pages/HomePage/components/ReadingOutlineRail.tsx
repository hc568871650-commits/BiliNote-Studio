import { useEffect, useMemo, useState } from 'react'
import { Bookmark } from 'lucide-react'
import { buildReadingOutline, type ReadingOutlineHeading } from '@/utils/readingOutline'

/** Collapsed navigation: one marker per overview group, never per paragraph. */
export default function ReadingOutlineRail({ headings, activeId, storageKey, active = true, onJump }: {
  headings: ReadingOutlineHeading[]; activeId: string; storageKey: string; active?: boolean; onJump: (id: string) => void
}) {
  const { groups } = useMemo(() => buildReadingOutline(headings), [headings])
  const [preview, setPreview] = useState<{ id: string; top: number } | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  useEffect(() => {
    if (!active) { setPreview(null); setHoveredId(null) }
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
  const current = groups.find(group => group.items.some(item => item.id === activeId))
    || groups.filter(group => headings.findIndex(item => item.id === group.title.id) <= activeIndex).at(-1)
    || groups[0]
  const selected = groups.find(group => group.id === preview?.id)
  // Pointer position alone controls lengths; reading progress only affects color.
  const center = groups.findIndex(group => group.id === hoveredId)
  if (!groups.length) return null
  const show = (element: HTMLButtonElement, id: string) => {
    const rail = element.closest('.reading-outline-rail')!.getBoundingClientRect()
    const button = element.getBoundingClientRect()
    setPreview({ id, top: Math.max(8, Math.min(button.top - rail.top - 12, rail.height - 100)) })
  }
  return <div className="reading-outline-rail" onMouseLeave={() => { setPreview(null); setHoveredId(null) }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreview(null) }}
    onKeyDown={event => { if (event.key === 'Escape') setPreview(null) }}>
    <nav className="reading-outline-rail-markers" aria-label="大分类快捷目录" onScroll={() => setPreview(null)}>
      {groups.map((group, index) => <button key={group.id} type="button" className="reading-outline-rail-marker"
        aria-label={`跳转分类：${group.title.text}${bookmarks.includes(group.id) ? '（已标重）' : ''}`} aria-current={current?.id === group.id ? 'location' : undefined}
        onMouseEnter={event => { setHoveredId(group.id); show(event.currentTarget, group.id) }} onFocus={event => show(event.currentTarget, group.id)}
        onClick={() => { onJump(group.title.id); setPreview(null) }}>
        <span className={index === center ? 'is-emphasized' : ''} style={{ width: center < 0 ? 7 : [30, 23, 17, 11, 7][Math.min(4, Math.abs(index - center))] }} />
        {bookmarks.includes(group.id) && <i className="reading-outline-bookmark-dot" aria-hidden="true" />}
      </button>)}
    </nav>
    {selected && preview && <div className="reading-outline-rail-preview" role="group" aria-label="分类预览" style={{ top: preview.top }}>
      <div className="reading-outline-preview-heading"><strong>{selected.title.text}</strong>
        <button type="button" className="reading-outline-bookmark" aria-label={bookmarks.includes(selected.id) ? '取消标重' : '标重此分类'} aria-pressed={bookmarks.includes(selected.id)} onClick={() => toggleBookmark(selected.id)}>
          <Bookmark size={17} fill={bookmarks.includes(selected.id) ? 'currentColor' : 'none'} />
        </button>
      </div><span>{selected.items.length} 个章节{current?.id === selected.id ? ' · 当前分类' : ''}{bookmarks.includes(selected.id) ? ' · 已标重' : ''}</span>
      {saveError && <small role="status">本机保存失败，标重仅在本次打开时保留。</small>}
    </div>}
  </div>
}
