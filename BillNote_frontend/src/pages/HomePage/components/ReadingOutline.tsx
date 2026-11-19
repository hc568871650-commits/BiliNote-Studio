import { useMemo, useState } from 'react'
import { ChevronRight, List, ListTree, X } from 'lucide-react'
import { buildReadingOutline, type ReadingOutlineHeading } from '@/utils/readingOutline'
import { formatSeconds, parseTimeSearchQuery } from '@/types/structuredNote'

export default function ReadingOutline({ headings, activeId, onJump, onClose }: {
  headings: ReadingOutlineHeading[]; activeId: string; onJump: (id: string) => void; onClose: () => void
}) {
  const model = useMemo(() => buildReadingOutline(headings), [headings])
  const hasGroups = model.groups.some(group => group.items.length > 1)
  const [full, setFull] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const query = search.trim().toLocaleLowerCase()
  const searchSeconds = useMemo(() => (query ? parseTimeSearchQuery(query) : null), [query])
  const results = useMemo(() => {
    if (!query) return model.full
    if (searchSeconds !== null) {
      return model.full.filter(item => {
        if (item.ranges?.some(r => searchSeconds >= r.start - 5 && searchSeconds <= Math.max(r.start, r.end) + 5)) return true
        if (item.times?.some(t => Math.abs(t - searchSeconds) <= 30)) return true
        if (item.annoTimes?.some(t => Math.abs(t - searchSeconds) <= 30)) return true
        return item.time !== undefined && Math.abs(item.time - searchSeconds) <= 30
      })
    }
    return model.full.filter(item => item.text.toLocaleLowerCase().includes(query))
  }, [model.full, query, searchSeconds])
  const time = (value?: number) => value === undefined ? '' : formatSeconds(value)
  const itemTimeLabel = (item: ReadingOutlineHeading) => {
    if (item.times && item.times.length > 1) {
      return item.times.slice(0, 3).map(t => formatSeconds(t)).join(' · ')
    }
    if (item.time !== undefined) return time(item.time)
    return ''
  }
  const link = (item: ReadingOutlineHeading, nested = false, collapsedCurrent = false) => {
    const label = itemTimeLabel(item)
    return <button type="button" className={`reading-outline-link ${nested ? 'is-nested' : ''}`} data-selected={activeId === item.id || collapsedCurrent} aria-current={activeId === item.id ? 'location' : undefined} onClick={() => onJump(item.id)} title={item.text}>
      <i className="reading-outline-current-dot" aria-hidden="true" /><span>{item.text}</span>{label && <small>{label}</small>}
    </button>
  }
  return <aside className="reading-outline-panel" aria-label="阅读目录">
    <div className="reading-outline-header"><strong>目录</strong><span>{full || query || !hasGroups ? `${results.length} 项` : `${model.groups.length} 组`}</span><button type="button" onClick={onClose} aria-label="收起目录"><X size={15} /></button></div>
    <div className="reading-outline-modes" data-mode={full ? 'all' : 'grouped'} role="group" aria-label="目录显示方式">
      <span className="reading-outline-mode-indicator" aria-hidden="true" />
      <button type="button" aria-pressed={!full} title="按分类分组，展开查看章节" onClick={() => setFull(false)}><ListTree size={14} aria-hidden="true" />分组</button>
      <button type="button" aria-pressed={full} title="平铺显示全部章节" onClick={() => setFull(true)}><List size={14} aria-hidden="true" />全部</button>
    </div>
    <input className="reading-outline-search" aria-label="搜索章节" placeholder="搜索章节或时间（如 14:05）…" value={search} onChange={event => setSearch(event.target.value)} />
    <nav className="reading-outline-list" aria-label="章节列表">
      {!results.length && <p className="reading-outline-empty">{query ? '没有匹配的章节' : '这篇笔记暂无标题'}</p>}
      {full || query ? results.map(item => <div key={item.id}>{link(item)}</div>) : model.groups.map(group => {
        const current = group.items.some(item => item.id === activeId)
        const hasChildren = group.items.length > 1
        const open = hasChildren && (expanded[group.id] ?? current)
        return <div className={`reading-outline-group ${hasChildren ? 'has-children' : ''} ${open ? 'is-expanded' : ''}`} key={group.id}>
          <div className={`reading-outline-group-title ${current ? 'is-current' : ''}`}>
            {hasChildren ? <button type="button" className="reading-outline-toggle" aria-label={`${open ? '折叠' : '展开'}${group.title.text}`} aria-expanded={open} onClick={() => setExpanded(state => ({ ...state, [group.id]: !open }))}><ChevronRight size={14} /></button> : <span className="reading-outline-spacer" />}
            {link(group.title, false, current && !open)}
          </div>
          {hasChildren && <div className={`reading-outline-children ${open ? 'is-open' : ''}`} aria-hidden={!open} inert={!open}>
            <div>{group.items.slice(1).map(item => <div key={item.id}>{link(item, true)}</div>)}</div>
          </div>}
        </div>
      })}
    </nav>
  </aside>
}
