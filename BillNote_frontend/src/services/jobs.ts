import request from '@/utils/request'
import type { DistillJobRecord, DistillJobSnapshot } from '@/utils/distillNotifications'

export type JobSseEvent =
  | { type: 'snapshot'; data: DistillJobSnapshot }
  | { type: 'job.updated'; data: { job: DistillJobRecord; active_count: number } }
  | { type: 'job.completed'; data: { job: DistillJobRecord; active_count: number } }
  | { type: 'job.failed'; data: { job: DistillJobRecord; active_count: number } }
  | { type: 'job.cancelled'; data: { job: DistillJobRecord; active_count: number } }
  | { type: 'queue.drained'; data: { active_count: number; last_job?: DistillJobRecord } }

export type JobEventListener = (event: JobSseEvent) => void
export type JobConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'mock'

export type CustomJobStreamConnector = (handlers: {
  onEvent: JobEventListener
  onStateChange?: (state: JobConnectionState) => void
}) => () => void

const CONNECTOR_KEY = '__bilinote_custom_job_stream_connector_v1__'

type JobsGlobal = typeof globalThis & {
  [CONNECTOR_KEY]?: CustomJobStreamConnector | null
}

function getConnectorSlot(): CustomJobStreamConnector | null {
  return (globalThis as JobsGlobal)[CONNECTOR_KEY] ?? null
}

export function setCustomJobStreamConnector(connector: CustomJobStreamConnector | null): void {
  ;(globalThis as JobsGlobal)[CONNECTOR_KEY] = connector
}

export function hasCustomJobStreamConnector(): boolean {
  return Boolean(getConnectorSlot())
}

function resolveJobsEventsUrl(): string {
  const base = (request.defaults.baseURL || import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '')
  return `${base}/jobs/events`
}

export async function listJobs(): Promise<DistillJobSnapshot> {
  return await request.get('/jobs', { suppressToast: true, timeout: 8000 })
}

export async function cancelJob(jobId: string): Promise<{ job_id: string; cancelled: boolean }> {
  return await request.post(`/jobs/${encodeURIComponent(jobId)}/cancel`, undefined, { suppressToast: true })
}

export async function retryJob(jobId: string): Promise<DistillJobRecord> {
  return await request.post(`/jobs/${encodeURIComponent(jobId)}/retry`, undefined, { suppressToast: true })
}

export async function clearFinishedJobs(): Promise<{ cleared: number }> {
  return await request.post('/jobs/clear-finished', undefined, { suppressToast: true })
}

export function subscribeJobEvents(
  onEvent: JobEventListener,
  onStateChange?: (state: JobConnectionState) => void,
): () => void {
  const customStreamConnector = getConnectorSlot()
  if (customStreamConnector) {
    return customStreamConnector({ onEvent, onStateChange })
  }

  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    onStateChange?.('idle')
    return () => {}
  }

  let disposed = false
  let source: EventSource | null = null
  let reconnectTimer: number | null = null
  let backoffMs = 1500

  const cleanupSource = () => {
    if (source) {
      source.close()
      source = null
    }
  }

  const parseAndEmit = <T,>(type: JobSseEvent['type'], raw: string) => {
    try {
      const parsed = JSON.parse(raw) as T
      onEvent({ type, data: parsed } as JobSseEvent)
    } catch {
      // 忽略损坏帧，等待下一次同步
    }
  }

  const connectOnce = () => {
    if (disposed) return
    cleanupSource()
    onStateChange?.(backoffMs > 1500 ? 'reconnecting' : 'connecting')

    const es = new EventSource(resolveJobsEventsUrl())
    source = es

    es.onopen = () => {
      if (disposed) return
      backoffMs = 1500
      onStateChange?.('open')
    }

    es.addEventListener('snapshot', (evt) => {
      parseAndEmit<DistillJobSnapshot>('snapshot', (evt as MessageEvent).data)
    })
    es.addEventListener('job.updated', (evt) => {
      parseAndEmit<{ job: DistillJobRecord; active_count: number }>('job.updated', (evt as MessageEvent).data)
    })
    es.addEventListener('job.completed', (evt) => {
      parseAndEmit<{ job: DistillJobRecord; active_count: number }>('job.completed', (evt as MessageEvent).data)
    })
    es.addEventListener('job.failed', (evt) => {
      parseAndEmit<{ job: DistillJobRecord; active_count: number }>('job.failed', (evt as MessageEvent).data)
    })
    es.addEventListener('job.cancelled', (evt) => {
      parseAndEmit<{ job: DistillJobRecord; active_count: number }>('job.cancelled', (evt as MessageEvent).data)
    })
    es.addEventListener('queue.drained', (evt) => {
      parseAndEmit<{ active_count: number; last_job?: DistillJobRecord }>('queue.drained', (evt as MessageEvent).data)
    })

    es.onerror = () => {
      if (disposed) return
      cleanupSource()
      onStateChange?.('reconnecting')
      const delay = backoffMs
      backoffMs = Math.min(12000, Math.round(backoffMs * 1.7))
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connectOnce()
      }, delay)
    }
  }

  connectOnce()

  return () => {
    disposed = true
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    cleanupSource()
    onStateChange?.('idle')
  }
}
