import { useInterfaceStore } from '@/store/interfaceStore'
import { FC, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import HomeLayout from '@/layouts/HomeLayout.tsx'
import NoteForm from '@/pages/HomePage/components/NoteForm.tsx'
import MarkdownViewer from '@/pages/HomePage/components/MarkdownViewer.tsx'
import { useTaskStore } from '@/store/taskStore'
import History from '@/pages/HomePage/components/History.tsx'
import { useLocation, useNavigate } from 'react-router-dom'
import { hasReadableContent } from '@/utils/readingStatus'
import { resolveReadableNote } from '@/utils/recentNote'
import { generationTitle } from '@/utils/taskProgress'
const RECENT_NOTE_KEY = 'bilinote-recent-note-v1'
function readRecentNote() {
  try { return localStorage.getItem(RECENT_NOTE_KEY) } catch { return null }
}

type ViewStatus = 'idle' | 'loading' | 'success' | 'failed'
export const HomePage: FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const submitted = () => {
    setView('notes')
    const search = new URLSearchParams(location.search)
    search.set('view', 'read')
    navigate({ pathname: '/', search: `?${search}` }, { replace: true })
  }
  const tasks = useTaskStore(state => state.tasks)
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const setCurrentTask = useTaskStore(state => state.setCurrentTask)
  const [view, setView] = useState<'create' | 'notes' | 'configure'>(() => useInterfaceStore.getState().startPage === 'create' ? 'create' : currentTaskId ? 'notes' : 'create')
  const recentNoteId = useRef<string | null>(readRecentNote())
  const initialSearch = useRef(location.search)

  useEffect(() => {
    const restoreStartup = () => {
      if (new URLSearchParams(initialSearch.current).has('view')) return
      if (useInterfaceStore.getState().startPage === 'create') { setView('create'); return }
      const state = useTaskStore.getState()
      const note = state.tasks.find(task => task.id === state.currentTaskId && !task.archived_at) || resolveReadableNote(state.tasks, null, recentNoteId.current)
      if (note) { setCurrentTask(note.id); setView('notes') }
    }
    if (useTaskStore.persist.hasHydrated()) restoreStartup()
    return useTaskStore.persist.onFinishHydration(restoreStartup)
  }, [setCurrentTask])

  const currentTask = tasks.find(t => t.id === currentTaskId)
  const createNote = () => {
    setView('create')
  }
  const findRecentNote = useCallback(() => resolveReadableNote(tasks, null, recentNoteId.current), [tasks])
  const openNotes = () => {
    const note = tasks.find(task => task.id === currentTaskId && !task.archived_at) || resolveReadableNote(tasks, null, recentNoteId.current)
    setCurrentTask(note?.id || null)
    setView('notes')
    window.dispatchEvent(new Event('bilinote-refresh-task'))
  }

  useEffect(() => {
    if (!currentTask || !hasReadableContent(currentTask) || view !== 'notes') return
    recentNoteId.current = currentTask.id
    try { localStorage.setItem(RECENT_NOTE_KEY, currentTask.id) } catch { /* Reading remains available without storage. */ }
  }, [currentTask, view])

  useLayoutEffect(() => {
    if (location.pathname !== '/') return
    const requested = new URLSearchParams(location.search).get('view')
    if (requested === 'create') setView('create')
    if (requested === 'read') {
      const state = useTaskStore.getState()
      const target = state.tasks.find(task => task.id === state.currentTaskId && !task.archived_at) || resolveReadableNote(state.tasks, null, recentNoteId.current)
      setCurrentTask(target?.id || null)
      setView('notes')
      window.dispatchEvent(new Event('bilinote-refresh-task'))
    }
  }, [location.key, location.pathname, location.search, setCurrentTask])

  // A pending sync or a deleted note must not send the user into the creation view.
  useEffect(() => {
    if (view === 'notes' && !currentTask && tasks.length) setCurrentTask(findRecentNote()?.id || null)
  }, [view, currentTask, tasks, setCurrentTask, findRecentNote])

  const syncNotes = useTaskStore(state => state.syncNotes)
  const loadTask = useTaskStore(state => state.loadTask)

  useEffect(() => {
    const unsubscribe = useTaskStore.persist.onFinishHydration(() => { void syncNotes() })
    if (useTaskStore.persist.hasHydrated()) void syncNotes()
    return unsubscribe
  }, [syncNotes])

  useEffect(() => {
    if (currentTaskId) void loadTask(currentTaskId)
  }, [currentTaskId, loadTask])

  // Derive on this render: switching tasks must never briefly show the previous task's view.
  const status: ViewStatus = !currentTask ? 'idle' : currentTask.status === 'SUCCESS' ? 'success'
    : currentTask.status === 'FAILED' ? hasReadableContent(currentTask) ? 'success' : 'failed' : 'loading'

  return (
    <HomeLayout
      composing={view !== 'notes'}
      hasTask={view !== 'create' && Boolean(currentTask)}
      title={currentTask ? generationTitle(currentTask) : '笔记'}
      onCreate={createNote}
      onRead={openNotes}
      onConfigure={() => setView('configure')}
      NoteForm={<><div hidden={view === 'configure'}><NoteForm creating onSubmitted={submitted} /></div>{view === 'configure' && <NoteForm onSubmitted={submitted} />}</>}
      Preview={currentTask ? <MarkdownViewer status={status} /> : <div className="workspace-empty">
        <h1>暂时没有笔记</h1>
        <p>点击左上角的新建笔记图标，整理你的第一篇视频笔记。</p>
        <button type="button" className="workspace-toolbar-button" onClick={createNote}>创建第一篇笔记</button>
      </div>}
      History={onCollapse => <History onCollapse={onCollapse} onSelectNote={() => { setView('notes'); window.dispatchEvent(new Event('bilinote-refresh-task')) }} />}
    />
  )
}
