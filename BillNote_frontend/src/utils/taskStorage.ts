import { get, set, del } from 'idb-keyval'
import type { PersistStorage } from 'zustand/middleware'

// Progress-only updates should not stringify and rewrite every saved transcript.
const transient = new Set(['statusMessage', 'pollingError', 'lastStatusAt', 'phaseStartedAt', 'submissionError', 'submissionInFlight'])
const durableTask = (task: Record<string, unknown>) => Object.fromEntries(Object.entries(task).filter(([key]) =>
  !transient.has(key) || (key === 'statusMessage' && ['FAILED', 'SUCCESS', 'SUBMISSION_UNKNOWN'].includes(String(task.status))) || (key === 'submissionError' && task.status === 'SUBMISSION_UNKNOWN')))
const equal = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

export function createTaskStorage<S extends { tasks: object[]; currentTaskId: string | null }>(): PersistStorage<S> & { flush: () => Promise<void> } {
  let previous: { tasks: Record<string, unknown>[]; currentTaskId: string | null; version?: number } | undefined
  let pendingWrite: Promise<void> = Promise.resolve()
  return {
    async flush() { await pendingWrite },
    async getItem(name) {
      const value = await get<string>(name)
      return value ? JSON.parse(value) : null
    },
    async setItem(name, value) {
      const tasks = value.state.tasks.map(task => durableTask(task as Record<string, unknown>))
      if (previous && previous.version === value.version && previous.currentTaskId === value.state.currentTaskId &&
        previous.tasks.length === tasks.length && tasks.every((task, i) => equal(task, previous!.tasks[i]))) return
      const snapshot = { tasks, currentTaskId: value.state.currentTaskId, version: value.version }
      const old = previous
      previous = snapshot
      try {
        pendingWrite = Promise.resolve(set(name, JSON.stringify({ ...value, state: { ...value.state, tasks } })))
        await pendingWrite
      } catch (error) {
        if (previous === snapshot) previous = old
        throw error
      }
    },
    async removeItem(name) { previous = undefined; await del(name) },
  }
}
