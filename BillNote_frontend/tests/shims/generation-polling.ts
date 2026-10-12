export const cleanups: (() => void)[] = []
export const useEffect = (effect: () => (() => void)) => { cleanups.push(effect()) }
export const toast = { success: (...args: unknown[]) => notices.push(args) }
export default toast
export const notices: unknown[][] = []
export interface FakeTask { id: string; status: string; attemptStartedAt?: number; formData?: { request_id?: string }; [key: string]: unknown }
export let tasks: FakeTask[] = []
export let currentTaskId: string | null = null
export const selectTask = (id: string | null) => { currentTaskId = id; listeners.forEach(fn => fn()) }
const listeners = new Set<() => void>()
export const replaceTasks = (next: FakeTask[]) => { tasks = next; listeners.forEach(fn => fn()) }
export const updates: unknown[] = []
export const useTaskStore = {
  getState: () => ({ tasks, currentTaskId, updateTaskContent(id: string, data: object) {
    updates.push(data)
    replaceTasks(tasks.map(t => t.id === id ? { ...t, ...data } : t))
  } }),
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}
export let statusHandler: (id: string, options: { signal: AbortSignal }) => Promise<any>
export let detailHandler: (id: string, options: { signal: AbortSignal }) => Promise<any>
export const setHandlers = (status: typeof statusHandler, detail: typeof detailHandler) => {
  statusHandler = status; detailHandler = detail
}
export const get_task_status = (id: string, options: { signal: AbortSignal }) => statusHandler(id, options)
export const getNote = (id: string, options: { signal: AbortSignal }) => detailHandler(id, options)
