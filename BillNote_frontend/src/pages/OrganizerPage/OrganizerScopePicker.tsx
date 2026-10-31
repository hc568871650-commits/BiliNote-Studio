import { useEffect, useMemo, useRef, useState } from 'react'
import { Folder, Library, ListChecks } from 'lucide-react'
import ChoiceSelect from '@/components/ChoiceSelect'
import type { OrganizerScope } from '@/services/organizer'
import type { Task } from '@/store/taskStore'
import { generationTitle } from '@/utils/taskProgress'
import { scopeLabel } from '@/utils/organizerScope'

interface FolderItem { id: string; name: string }
interface Props {
  scope: OrganizerScope['kind']
  folderId: string
  selectedIds: string[]
  folders: FolderItem[]
  tasks: Task[]
  disabled?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onScope: (scope: OrganizerScope['kind']) => void
  onFolder: (id: string) => void
  onToggleNote: (id: string) => void
}

export default function OrganizerScopePicker({ scope, folderId, selectedIds, folders, tasks, disabled, open, onOpenChange, onScope, onFolder, onToggleNote }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const notes = useMemo(() => tasks.filter(task => task.status === 'SUCCESS' && !task.archived_at), [tasks])
  const visibleNotes = useMemo(() => { const key = filter.trim().toLowerCase(); return key ? notes.filter(task => generationTitle(task).toLowerCase().includes(key)) : notes }, [notes, filter])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onOpenChange(false) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', escape) }
  }, [open, onOpenChange])
  const Icon = scope === 'folder' ? Folder : scope === 'selected' ? ListChecks : Library
  return <div ref={root} className="organizer-scope">
    <button type="button" className="organizer-scope-trigger" disabled={disabled} aria-expanded={open} aria-haspopup="dialog" title="整理范围：助手只会在这个范围内生成整理计划" onClick={() => onOpenChange(!open)}>
      <Icon size={13} /><span>{scopeLabel(scope, folderId, selectedIds, folders)}</span>
    </button>
    {open && <div className="organizer-scope-panel" role="dialog" aria-label="整理范围">
      <fieldset>
        <legend>整理范围</legend>
        <div className="organizer-scope-options">
          <label><input type="radio" name="organizer-scope" checked={scope === 'all'} onChange={() => onScope('all')} />全库</label>
          <label><input type="radio" name="organizer-scope" checked={scope === 'folder'} onChange={() => onScope('folder')} />文件夹</label>
          <label><input type="radio" name="organizer-scope" checked={scope === 'selected'} onChange={() => onScope('selected')} />指定笔记</label>
        </div>
      </fieldset>
      {scope === 'all' && <p className="organizer-scope-hint">归档、移动等修改需要在消息里写明“全部笔记”。</p>}
      {scope === 'folder' && <ChoiceSelect label="整理的文件夹" className="organizer-scope-folder" value={folderId} onChange={onFolder} options={folders.map(folder => ({ value: folder.id, label: folder.name }))} />}
      {scope === 'selected' && <div className="organizer-scope-notes">
        <input type="text" aria-label="筛选笔记" placeholder="按标题筛选…" value={filter} onChange={event => setFilter(event.target.value)} />
        <ul>{visibleNotes.map(task => <li key={task.id}><label><input type="checkbox" checked={selectedIds.includes(task.id)} onChange={() => onToggleNote(task.id)} /><span>{generationTitle(task)}</span></label></li>)}</ul>
        {!visibleNotes.length && <p className="organizer-scope-hint">没有匹配的笔记</p>}
      </div>}
    </div>}
  </div>
}
