import type { ToolEvent } from '@/services/chat'
import './tool-trace.css'

const names: Record<string, string> = { search_web: '搜索', read_web_page: '读取网页', native_search: '原生搜索' }
const states: Record<string, string> = { succeeded: '完成', failed: '失败', cached: '复用缓存', blocked: '未执行', unconfirmed: '证据不足' }
const safeLink = (value?: string) => {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
export default function ToolTrace({ events = [], embedded = false }: { events?: ToolEvent[]; embedded?: boolean }) {
  if (!events.length) return null
  const searches = events.filter(event => event.tool === 'search_web' && !['cached', 'blocked'].includes(event.status)).length
  const reads = events.filter(event => event.tool === 'read_web_page' && event.status === 'succeeded').length
  const native = events.filter(event => event.tool === 'native_search' && event.status === 'succeeded').length
  const failures = events.filter(event => ['failed', 'blocked', 'unconfirmed'].includes(event.status)).length
  const summary = [searches ? `搜索 ${searches} 次` : '', native ? `原生搜索 ${native} 次` : '', reads ? `读页 ${reads} 段` : '', failures ? `${failures} 项未完成` : ''].filter(Boolean).join(' · ') || '联网记录'
  const records = <ol>{events.map((event, index) => {
      const link = ['succeeded', 'cached'].includes(event.status) ? safeLink(event.url) : undefined
      return <li key={event.id || index}>
        <div className="tool-trace-heading"><strong>{names[event.tool] || event.tool}</strong><span>{states[event.status] || event.status}{event.service ? ` · ${event.service}` : ''}{event.elapsed_ms != null ? ` · ${(event.elapsed_ms / 1000).toFixed(1)} 秒` : ''}</span></div>
        {event.query && <p>{event.query}</p>}
        {event.url && (link ? <a href={link} target="_blank" rel="noopener noreferrer">{event.url}</a> : <p>{event.url}</p>)}
        {(event.characters != null || event.source_count != null) && <p>{event.characters != null ? `读取 ${event.characters.toLocaleString()} 字符${event.offset != null ? `，从 ${event.offset.toLocaleString()} 开始` : ''}` : `${event.source_count} 条来源`}{event.next_offset != null ? ` · 后续位置 ${event.next_offset.toLocaleString()}` : ''}{event.budget_exhausted ? ' · 预算已用完' : event.truncated ? ' · 尚未读完' : ''}</p>}
        {(event.retrieved_at || event.occurred_at) && <p>{event.retrieved_at ? '读取于' : '记录于'} {new Date(event.retrieved_at || event.occurred_at!).toLocaleString('zh-CN')}</p>}
        {event.error && <p className="tool-trace-error">{event.error}</p>}
      </li>
    })}</ol>
  if (embedded) return <div className="assistant-tool-trace">{records}</div>
  return <details className="assistant-tool-trace">
    <summary aria-label="联网过程">{summary}</summary>
    {records}
  </details>
}
