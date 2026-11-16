import { createRecordStorage } from '@/utils/recordStorage'

// Progress-only updates should not stringify and rewrite every saved transcript.
const transient = new Set(['statusMessage', 'pollingError', 'lastStatusAt', 'phaseStartedAt', 'submissionError', 'submissionInFlight'])
const durableTask = (task: Record<string, unknown>) => Object.fromEntries(Object.entries(task).filter(([key]) =>
  !transient.has(key) || (key === 'statusMessage' && ['FAILED', 'SUCCESS', 'SUBMISSION_UNKNOWN'].includes(String(task.status))) || (key === 'submissionError' && task.status === 'SUBMISSION_UNKNOWN')))
const equal = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

export function createTaskStorage<S extends { tasks: object[]; currentTaskId: string | null }>() {
  let source: object[] | undefined
  let durable: Record<string, unknown>[] = []
  return createRecordStorage<S>(state => {
    if (source !== state.tasks) {
      const next = state.tasks.map(task => durableTask(task as Record<string, unknown>))
      if (next.length !== durable.length || next.some((task, index) => !equal(task, durable[index]))) durable = next
      source = state.tasks
    }
    return { tasks: durable, currentTaskId: state.currentTaskId }
  }, fields => ({ tasks: fields.tasks || [], currentTaskId: fields.currentTaskId ?? null }) as S)
}
