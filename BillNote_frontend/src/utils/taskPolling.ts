export interface PollingSchedulerOptions<T> {
  getPending: () => T[]
  poll: (task: T, signal: AbortSignal) => Promise<void>
  interval: number
  concurrency?: number
}

// A single round owns all requests. Slow rounds never overlap the next one.
export function createTaskPollingScheduler<T>(options: PollingSchedulerOptions<T>) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let wakeRequested = false
  const run = async () => {
    if (controller.signal.aborted) return
    running = true
    wakeRequested = false
    const tasks = options.getPending()
    let cursor = 0
    const worker = async () => {
      while (!controller.signal.aborted && cursor < tasks.length) {
        const task = tasks[cursor++]
        try { await options.poll(task, controller.signal) } catch { /* isolate tasks */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, tasks.length) }, worker))
    running = false
    if (!controller.signal.aborted) timer = setTimeout(run, wakeRequested ? 0 : options.interval)
  }
  return {
    wake() {
      if (controller.signal.aborted) return
      if (running) { wakeRequested = true; return }
      clearTimeout(timer)
      void run()
    },
    stop() { controller.abort(); clearTimeout(timer) },
  }
}

export const isActiveTask = (task: { status: string }) => !['SUCCESS', 'FAILED'].includes(task.status)
export const pollingErrorMessage = (error: unknown) => {
  const value = error as { msg?: string; message?: string }
  return value?.msg || value?.message || '暂时无法获取进度，正在自动重新检查；后端任务可能仍在执行'
}
