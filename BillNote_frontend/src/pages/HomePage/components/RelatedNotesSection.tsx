import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchRelatedNotes, type RelatedNoteItem } from '@/services/note'
import { useTaskStore } from '@/store/taskStore'

interface Props {
  taskId: string
}

export default function RelatedNotesSection({ taskId }: Props) {
  const navigate = useNavigate()
  const [items, setItems] = useState<RelatedNoteItem[]>([])

  useEffect(() => {
    if (!taskId) {
      setItems([])
      return
    }
    let active = true
    void fetchRelatedNotes(taskId, 3)
      .then(list => {
        if (active) setItems(list)
      })
      .catch(() => {
        if (active) setItems([])
      })
    return () => {
      active = false
    }
  }, [taskId])

  if (!items.length) return null

  return (
    <aside className="related-notes-strip" aria-label="库内相关笔记">
      <h4 className="related-notes-heading">库内相关笔记</h4>
      <div className="related-notes-grid">
        {items.map(item => (
          <button
            key={item.task_id}
            type="button"
            className="related-note-card"
            onClick={() => {
              useTaskStore.getState().setCurrentTask(item.task_id)
              navigate('/?view=read')
            }}
          >
            <span className="related-note-card-title">{item.title}</span>
            <span className="related-note-card-meta">{item.reason}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
