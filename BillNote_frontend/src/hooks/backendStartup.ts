export const TOTAL_TIMEOUT_MS = 60_000
export const PROBE_TIMEOUT_MS = 5_000
const FAST_POLL_WINDOW_MS = 15_000

export async function probeBackendHealth(base: string, signal: AbortSignal, request = fetch): Promise<boolean> {
  const response = await request(`${base.replace(/\/$/, '')}/sys_check`, { signal, cache: 'no-store' })
  if (!response.ok) return false
  const json = await response.json().catch(() => null)
  return json?.code === 0
}

interface StartupOptions {
  probe: (signal: AbortSignal) => Promise<boolean>
  onReady: () => void
  onFailed: (message: string) => void
  onPending: () => void
  now?: () => number
  schedule?: typeof setTimeout
  unschedule?: typeof clearTimeout
}

/** One probe at a time; ready events are hints, never a health-check bypass. */
export function startBackendCheck(options: StartupOptions) {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? setTimeout
  const unschedule = options.unschedule ?? clearTimeout
  const started = now()
  let stopped = false
  let probing = false
  let hinted = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  const stop = () => {
    stopped = true
    unschedule(deadlineTimer)
    if (pollTimer !== undefined) unschedule(pollTimer)
    if (probeTimer !== undefined) unschedule(probeTimer)
    controller?.abort()
  }
  const fail = (message: string) => {
    if (stopped) return
    stop()
    options.onFailed(message)
  }
  const deadlineTimer = schedule(() => {
    fail(`后端 ${TOTAL_TIMEOUT_MS / 1000}s 内未就绪，请检查后端日志或重启`)
  }, TOTAL_TIMEOUT_MS)

  const poll = async () => {
    if (stopped || probing) return
    probing = true
    controller = new AbortController()
    probeTimer = schedule(() => controller?.abort(), PROBE_TIMEOUT_MS)
    let ok = false
    try {
      ok = await options.probe(controller.signal)
    } catch {
      // Connection failures are expected while the sidecar starts.
    } finally {
      if (probeTimer !== undefined) unschedule(probeTimer)
      probeTimer = undefined
      probing = false
    }
    if (stopped) return
    if (ok) {
      stop()
      options.onReady()
      return
    }
    options.onPending()
    const delay = hinted ? 0 : now() - started < FAST_POLL_WINDOW_MS ? 500 : 2_000
    hinted = false
    pollTimer = schedule(() => void poll(), delay)
  }

  const checkNow = () => {
    if (stopped) return
    if (probing) {
      hinted = true
      return
    }
    if (pollTimer !== undefined) unschedule(pollTimer)
    void poll()
  }
  void poll()
  return { stop, fail, checkNow }
}
