import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '@/store/taskStore'
import { useFolderStore } from '@/store/folderStore'
import { useSourceNavigationStore } from '@/store/sourceNavigationStore'
import type { ChatSource } from '@/services/chat'
import toast from 'react-hot-toast'
import './source-list.css'

export default function SourceList({ sources }: { sources: ChatSource[] }) {
  const navigate = useNavigate()
  const openNote = (source: ChatSource) => {
    if (!source.note_id || !useTaskStore.getState().tasks.some(task => task.id === source.note_id)) {
      toast.error('来源笔记当前不可用，请刷新笔记库后重试'); return
    }
    useSourceNavigationStore.getState().open(source)
    useFolderStore.getState().selectFolder('all')
    useTaskStore.getState().setCurrentTask(source.note_id)
    navigate('/?view=read')
  }
  return <div className="assistant-sources" aria-label="参考来源">{sources.map((source, index) => {
    const web = source.source_type === 'web' && /^https?:\/\//i.test(source.url || '')
    const label = source.title || source.section_title || (source.start_time != null ? `转录 ${Math.floor(source.start_time)} 秒` : '笔记内容')
    return <div key={source.source_id || `${source.note_id || ''}:${index}`}>
      {web ? <a href={source.url} target="_blank" rel="noopener noreferrer">[{index + 1}] {label} ↗</a> : source.note_id ? <button type="button" onClick={() => openNote(source)}>[{index + 1}] {label}{source.archived ? ' · 已归档' : ''}</button> : <strong>[{index + 1}] {label}</strong>}
      {source.section_title && source.title && <small>{source.section_title}</small>}
      {source.text && <p>{source.text}</p>}
    </div>
  })}</div>
}
