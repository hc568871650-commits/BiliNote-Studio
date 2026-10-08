import { useCallback, useEffect, useState } from 'react'
import { probeBackendHealth, startBackendCheck } from './backendStartup'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Keep startup probes away from axios's global error-toast interceptor.
async function probeSysCheck(signal: AbortSignal): Promise<boolean> {
  const fromEnv = import.meta.env.VITE_API_BASE_URL as string | undefined
  const base = (fromEnv || '/api').replace(/\/$/, '')
  return probeBackendHealth(base, signal)
}

interface Status {
  loading: boolean
  initialized: boolean
  failed: boolean
  lastError: string | null
}

const initialStatus: Status = {
  loading: true, initialized: false, failed: false, lastError: null,
}

/** HTTP validates readiness; desktop events accelerate probes or report failure. */
export const useCheckBackend = (): Status & { retry: () => void } => {
  const [status, setStatus] = useState<Status>(initialStatus)
  const [tick, setTick] = useState(0)
  const retry = useCallback(() => {
    setStatus(initialStatus)
    setTick(t => t + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const tauriUnsubs: Array<() => void> = []
    const check = startBackendCheck({
      probe: probeSysCheck,
      onReady: () => setStatus({ loading: false, initialized: true, failed: false, lastError: null }),
      onFailed: lastError => setStatus({ loading: false, initialized: false, failed: true, lastError }),
      onPending: () => setStatus(s => s.lastError === '后端尚未响应'
        ? s : { ...s, lastError: '后端尚未响应' }),
    })

    if (isTauri) {
      import('@tauri-apps/api/event').then(async ({ listen }) => {
        if (cancelled) return
        // Retain each subscription even if a later registration fails.
        const retain = (off: () => void) => {
          if (cancelled) off()
          else tauriUnsubs.push(off)
        }
        retain(await listen<number>('backend-ready', () => check.checkNow()))
        if (cancelled) return
        retain(await listen<string>('backend-startup-timeout', e => {
          check.fail(typeof e.payload === 'string' ? e.payload : '后端启动超时')
        }))
        if (cancelled) return
        retain(await listen<number | null>('backend-terminated', e => {
          check.fail(`后端进程已退出 (code=${e.payload ?? 'unknown'})`)
        }))
      }).catch(err => console.warn('[useCheckBackend] 无法订阅 Tauri 事件:', err))
    }

    return () => {
      cancelled = true
      check.stop()
      tauriUnsubs.forEach(off => {
        try { off() } catch { /* best-effort cleanup */ }
      })
    }
  }, [tick])

  return { ...status, retry }
}
