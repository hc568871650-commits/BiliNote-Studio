import { getNote } from '@/services/note'
import { getNoteFolders } from '@/services/noteFolders'
import { useTaskStore } from '@/store/taskStore'
import { DEFAULT_FOLDER_ID, useFolderStore } from '@/store/folderStore'
import { useLibraryViewStore } from '@/store/libraryViewStore'
import { useSourceNavigationStore, type NavigationSource } from '@/store/sourceNavigationStore'
import { mergeTaskSnapshot } from '@/utils/taskProgress'

let navigation = 0
export async function openNoteSource(source: NavigationSource, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!source.note_id) throw new Error('来源笔记不可用，请重新查找')
  const ticket = ++navigation
  const selectedBefore = useTaskStore.getState().currentTaskId
  const before = useTaskStore.getState().tasks.find(task => task.id === source.note_id)
  const assignmentsBefore = useFolderStore.getState().assignments
  const [detail, folderData] = await Promise.all([
    getNote(source.note_id, { suppressToast: true }), getNoteFolders({ suppressToast: true }),
  ])
  const current = useTaskStore.getState().tasks.find(task => task.id === source.note_id)
  if (ticket !== navigation || !isCurrent() || selectedBefore !== useTaskStore.getState().currentTaskId
    || (before && (!current || current.formData?.request_id !== before.formData?.request_id || current.attemptStartedAt !== before.attemptStartedAt))) return false
  if (detail.id !== source.note_id) throw new Error('来源笔记不匹配，请重新查找')
  if (source.version_id && (source.version_id === 'legacy' ? Array.isArray(detail.markdown)
    : !Array.isArray(detail.markdown) || !detail.markdown.some(version => version.ver_id === source.version_id))) {
    throw new Error('来源版本已不可用，请重新查找')
  }
  const task = mergeTaskSnapshot(current, detail)
  useTaskStore.setState(state => ({ tasks: state.tasks.some(item => item.id === task.id)
    ? state.tasks.map(item => item.id === task.id ? task : item) : [...state.tasks, task] }))
  // Search may discover notes moved or created since this sidebar was loaded.
  if (useFolderStore.getState().assignments === assignmentsBefore) useFolderStore.setState({ ...folderData, loadState: 'ready', errorMessage: null })
  const folderState = useFolderStore.getState()
  const folderId = folderState.assignments[task.id] || DEFAULT_FOLDER_ID
  folderState.selectFolder(folderId)
  useLibraryViewStore.getState().setArchived(Boolean(task.archived_at))
  useSourceNavigationStore.getState().open({ ...source, archived: Boolean(task.archived_at) })
  useTaskStore.getState().setCurrentTask(task.id)
  return true
}
