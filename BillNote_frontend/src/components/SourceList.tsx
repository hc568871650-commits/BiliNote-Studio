import { useNavigate } from 'react-router-dom'
import { openNoteSource } from '@/utils/openNoteSource'
import type { ChatSource } from '@/services/chat'
import toast from 'react-hot-toast'
import './source-list.css'

export default function SourceList({ sources }: { sources: ChatSource[] }) {
  const navigate = useNavigate()
  const suggestions = sources.find(source => source.search_provider === 'google' && source.search_suggestions_html)?.search_suggestions_html
  const openNote = async (source: ChatSource) => {
    try { if (await openNoteSource(source)) navigate('/?view=read') }
    catch { toast.error('来源笔记或版本当前不可用，请刷新笔记库后重试') }
  }
  return <div className="assistant-sources" aria-label="参考来源">
    {suggestions && suggestions.length <= 50000 && <iframe title="Google 搜索建议" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
      style={{ width: '100%', height: 110, border: 0 }} srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><base target="_blank">${suggestions}`} />}
    {sources.map((source, index) => {
    const web = source.source_type === 'web' && /^https?:\/\//i.test(source.url || '')
    const label = source.title || source.section_title || (source.start_time != null ? `转录 ${Math.floor(source.start_time)} 秒` : '笔记内容')
    return <div key={source.source_id || `${source.note_id || ''}:${index}`}>
      {web ? <a href={source.url} target="_blank" rel="noopener noreferrer">[{index + 1}] {label} ↗</a> : source.note_id ? <button type="button" onClick={() => openNote(source)}>[{index + 1}] {label}{source.archived ? ' · 已归档' : ''}</button> : <strong>[{index + 1}] {label}</strong>}
      {web && source.evidence_type && <span className="assistant-source-evidence">{source.evidence_type === 'page' ? '已读原文' : '搜索摘要'}{source.read_characters != null ? ` · 已读 ${source.read_characters.toLocaleString()}${source.total_length != null ? ` / ${source.total_length.toLocaleString()}` : ''} 字符` : ''}{source.read_complete === false || source.truncated ? ' · 未读完' : ''}{source.retrieved_at ? ` · ${new Date(source.retrieved_at).toLocaleString('zh-CN')}` : ''}</span>}
      {source.section_title && source.title && <small>{source.section_title}</small>}
      {source.text && <p>{source.text}</p>}
    </div>
  })}</div>
}
