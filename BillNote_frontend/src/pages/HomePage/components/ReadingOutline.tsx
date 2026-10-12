import { useMemo, useState } from 'react'
import { ChevronRight, List, ListTree, X } from 'lucide-react'
import { buildReadingOutline, type ReadingOutlineHeading } from '@/utils/readingOutline'

export default function ReadingOutline({ headings, activeId, onJump, onClose }: {
  headings: ReadingOutlineHeading[]; activeId: string; onJump: (id: string) => void; onClose: () => void
}) {
  const model = useMemo(() => buildReadingOutline(headings), [headings])
  const [full, setFull] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const query = search.trim().toLocaleLowerCase()
  const results = query ? model.full.filter(item => item.text.toLocaleLowerCase().includes(query)) : model.full
  const time = (value?: number) => value === undefined ? '' : [Math.floor(value / 3600), Math.floor(value / 60) % 60, Math.floor(value % 60)].slice(value >= 3600 ? 0 : 1).map(n => String(n).padStart(2, '0')).join(':')
  const link = (item: ReadingOutlineHeading, nested = false, collapsedCurrent = false) => <button type="button" className={`reading-outline-link ${nested ? 'is-nested' : ''}`} data-selected={activeId === item.id || collapsedCurrent} aria-current={activeId === item.id ? 'location' : undefined} onClick={() => onJump(item.id)} title={item.text}>
    <i className="reading-outline-current-dot" aria-hidden="true" /><span>{item.text}</span>{item.time !== undefined && <small>{time(item.time)}</small>}
  </button>
  return <aside className="reading-outline-panel" aria-label="阅读目录">
    <div className="reading-outline-header"><strong>目录</strong><span>{full || query ? `${results.length} 项` : `${model.groups.length} 组`}</span><button type="button" onClick={onClose} aria-label="收起目录"><X size={15} /></button></div>
    <div className="reading-outline-modes" data-mode={full ? 'all' : 'grouped'} role="group" aria-label="目录显示方式">
      <span className="reading-outline-mode-indicator" aria-hidden="true" />
      <button type="button" aria-pressed={!full} title="按分类分组，展开查看章节" onClick={() => setFull(false)}><ListTree size={14} aria-hidden="true" />分组</button>
      <button type="button" aria-pressed={full} title="平铺显示全部章节" onClick={() => setFull(true)}><List size={14} aria-hidden="true" />全部</button>
    </div>
    <input className="reading-outline-search" aria-label="搜索章节" placeholder="搜索章节…" value={search} onChange={event => setSearch(event.target.value)} />
    <nav className="reading-outline-list" aria-label="章节列表">
      {!results.length && <p className="reading-outline-empty">{query ? '没有匹配的章节' : '这篇笔记暂无标题'}</p>}
      {full || query ? results.map(item => <div key={item.id}>{link(item)}</div>) : model.groups.map(group => {
        const current = group.items.some(item => item.id === activeId)
        const open = expanded[group.id] ?? current
        return <div className={`reading-outline-group ${open ? 'is-expanded' : ''}`} key={group.id}>
          <div className={`reading-outline-group-title ${current ? 'is-current' : ''}`}>
            {group.items.length > 1 ? <button type="button" className="reading-outline-toggle" aria-label={`${open ? '折叠' : '展开'}${group.title.text}`} aria-expanded={open} onClick={() => setExpanded(state => ({ ...state, [group.id]: !open }))}><ChevronRight size={14} /></button> : <span className="reading-outline-spacer" />}
            {link(group.title, false, current && !open)}
          </div>
          <div className={`reading-outline-children ${open ? 'is-open' : ''}`} aria-hidden={!open} inert={!open}>
            <div>{group.items.slice(1).map(item => <div key={item.id}>{link(item, true)}</div>)}</div>
          </div>
        </div>
      })}
    </nav>
    <p className="reading-outline-footnote">{query ? '搜索全部章节' : full ? '全部正文标题，已隐藏分段标识与重复课程标题' : model.grouped ? '按原文顺序分组，展开查看具体步骤' : '展开章节查看具体步骤'}</p>
  </aside>
}
