import { useSyncExternalStore } from 'react'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export type LogLevel = 'info' | 'error'
export interface LogEntry { level: LogLevel; text: string; ts: number }
export type BackendStatus = 'unknown' | 'running' | 'restarting' | 'terminated'
let snapshot: { status: BackendStatus; exitCode: number | null; logs: LogEntry[]; restarting: boolean } = {
  status: 'unknown', exitCode: null, logs: [], restarting: false,
}
const subscribers = new Set<() => void>()
let cleanup: (() => void) | undefined
let restartPromise: Promise<void> | null = null
function update(patch: Partial<typeof snapshot>) {
  snapshot = { ...snapshot, ...patch }
  subscribers.forEach(notify => notify())
}
function append(level: LogLevel, text: string) {
  update({ logs: [...snapshot.logs, { level, text: redactLog(text), ts: Date.now() }].slice(-200) })
}
/** 常见凭据脱敏；分享前仍需检查日志中的业务内容。 */
export function redactLog(text: string): string {
  return text
    .replace(/((?:set-cookie|cookie)\s*["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]')
    .replace(/\b(Bearer)\s+[^\s"',;]+/gi, '$1 [已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/gi, '$1[已隐藏]')
    .replace(/\bsk-[\w-]{8,}/g, '[已隐藏密钥]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
}
function startListening() {
  let disposed = false
  const offs: Array<() => void> = []
  let ignoreTerminationUntil = 0
  cleanup = () => { disposed = true; offs.splice(0).forEach(off => off()) }
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event')
    async function add<T>(name: string, callback: (payload: T) => void) {
      if (disposed) return
      const off = await listen<T>(name, event => { if (!disposed) callback(event.payload) })
      if (disposed) off()
      else offs.push(off)
    }
    await add<string>('backend-message', text => append('info', stripQuotes(text)))
    await add<string>('backend-error', text => append('error', stripQuotes(text)))
    await add('backend-restarting', () => {
      ignoreTerminationUntil = Date.now() + 3000
      update({ status: 'restarting' })
      append('info', '正在重启后端服务…')
    })
    await add<number | null>('backend-terminated', code => {
      if (Date.now() < ignoreTerminationUntil) {
        ignoreTerminationUntil = 0
        append('info', '旧进程已退出，正在重启')
        return
      }
      update({ status: 'terminated', exitCode: code ?? null })
      append('error', `后端已退出（退出码 ${code ?? '未知'}）`)
    })
    await add('backend-restarted', () => {
      ignoreTerminationUntil = 0
      update({ status: 'running', exitCode: null })
      append('info', '后端进程已重启，等待连接检查。')
    })
  })().catch(error => { if (!disposed) append('error', `无法监听后端事件：${String(error)}`) })
}
function subscribe(notify: () => void) {
  subscribers.add(notify)
  if (isTauri && subscribers.size === 1) startListening()
  return () => {
    subscribers.delete(notify)
    if (!subscribers.size) { cleanup?.(); cleanup = undefined }
  }
}
async function restart() {
  if (!isTauri) return
  if (restartPromise) return restartPromise
  update({ restarting: true })
  restartPromise = (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('restart_backend_sidecar')
      update({ status: 'running', exitCode: null })
    } catch (error) {
      update({ status: 'unknown' })
      append('error', `重启失败：${String(error)}`)
      throw error
    } finally {
      update({ restarting: false })
      restartPromise = null
    }
  })()
  return restartPromise
}
async function copyLogs() {
  const text = snapshot.logs.map(log => `${new Date(log.ts).toLocaleTimeString()} ${log.level === 'error' ? 'E' : 'I'} ${redactLog(log.text)}`).join('\n')
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}
export function useBackendEvents() {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
  return { ...state, restart, copyLogs, isTauri }
}
function stripQuotes(text: string): string {
  if (typeof text !== 'string') return String(text)
  return text.length >= 2 && text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text
}
