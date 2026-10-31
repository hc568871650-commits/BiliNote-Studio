import { useEffect, useId, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { ToolEvent } from '@/services/chat'
import ToolTrace from '@/components/ToolTrace'
import './work-progress.css'

const phaseNames: Record<string, string> = {
  searching: '正在搜索', search_web: '正在搜索', native_search: '正在搜索',
  read_web: '正在读取网页', reading_web: '正在读取网页', read_web_page: '正在读取网页',
  tool: '正在使用工具', retrieving: '正在查找资料', reading_notes: '正在读取笔记',
  generating: '正在组织回答', compacting: '正在压缩上下文',
  preparing: '正在准备', thinking: '正在思考', planning: '正在理解需求',
  executing: '正在执行操作', undoing: '正在撤销操作',
  loading: '正在读取会话', cancelling: '正在停止处理',
}

export interface WorkProgressProps {
  entries?: string[]
  text?: string
  events?: ToolEvent[]
  active?: boolean
  phase?: string
  elapsed?: string
}

export default function WorkProgress({ entries = [], text = '', events = [], active = false, phase, elapsed }: WorkProgressProps) {
  const [expanded, setExpanded] = useState(active)
  const id = useId()
  // A completed turn always folds away; subsequent text chunks do not override a manual toggle.
  useEffect(() => { setExpanded(active) }, [active])
  const records = entries.filter(entry => entry.trim())
  if (!active && !records.length && !events.length) return null
  const label = active ? phaseNames[phase || ''] || '正在处理' : '工作过程'
  return <section className={`assistant-work-progress${active ? ' assistant-work-progress--active' : ''}`} aria-label="工作过程">
    <button type="button" className="work-progress-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <ChevronRight size={13} className={expanded ? 'work-progress-chevron--open' : ''} aria-hidden="true" />
      {active && <Loader2 size={13} className="work-progress-spinner" aria-hidden="true" />}
      <span role={active ? 'status' : undefined}>{label}</span>
      {elapsed && <span className="work-progress-elapsed">{elapsed}</span>}
    </button>
    {expanded && <div id={id} className="work-progress-body">
      {records.map((entry, index) => <p key={index}>{entry}</p>)}
      {active && text.trim() && <p className="work-progress-current">{text}</p>}
      <ToolTrace events={events} embedded />
    </div>}
  </section>
}
