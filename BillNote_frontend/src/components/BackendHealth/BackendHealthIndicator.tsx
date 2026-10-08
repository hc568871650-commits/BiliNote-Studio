import { useEffect, useRef, useState } from 'react'
import { useBackendEvents } from './useBackendEvents'
import BackendLogPanel from './BackendLogPanel'
import BackendStatusButton from './BackendStatusButton'
import './backend-health.css'

export type Health = 'green' | 'yellow' | 'red' | 'unknown'
const HEALTH_POLL_MS = 5000
const HEALTH_TIMEOUT_MS = 5000
function backendBase(): string {
  return (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
}
const BackendHealthIndicator = () => {
  const { status, isTauri, exitCode, logs, restart, copyLogs, restarting } = useBackendEvents()
  const [open, setOpen] = useState(false)
  const [failures, setFailures] = useState(0)
  const [lastOk, setLastOk] = useState<boolean | null>(null)
  const [dependencyWarning, setDependencyWarning] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [detail, setDetail] = useState('等待首次连接检查')
  const checkRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    if (!isTauri) return
    let mounted = true
    let busy = false
    let controller: AbortController | null = null
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    setLastOk(null)
    setDependencyWarning(false)
    setFailures(0)
    async function ping() {
      if (!mounted || busy) return
      clearTimeout(pollTimer)
      busy = true
      setChecking(true)
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), HEALTH_TIMEOUT_MS)
      try {
        const response = await fetch(`${backendBase()}/sys_health`, { signal: controller.signal, cache: 'no-store' })
        const body = response.ok ? await response.json() : null
        if (!mounted) return
        const connected = response.ok && body?.code === 0 && body?.data?.backend === 'ok'
        const warnings = []
        if (connected && body.data.ffmpeg !== 'ok') warnings.push('FFmpeg 不可用')
        if (connected && body.data.db !== 'ok') warnings.push('数据库检查失败')
        if (connected && body.data.whisper_model?.checked && !body.data.whisper_model.downloaded) warnings.push('本地转写模型未下载')
        setLastOk(connected)
        setDependencyWarning(warnings.length > 0)
        setFailures(count => connected ? 0 : count + 1)
        setDetail(connected ? warnings.length ? `已连接 · ${warnings.join('；')}` : '服务与依赖检查正常'
          : response.ok ? '健康检查返回了无法识别的结果' : `系统检查未通过（HTTP ${response.status}）`)
      } catch (error) {
        if (!mounted) return
        setLastOk(false)
        setFailures(count => count + 1)
        setDetail(error instanceof Error && error.name === 'AbortError' ? '连接检查超时（5 秒）' : '无法连接后端服务')
      } finally {
        clearTimeout(timeout)
        busy = false
        if (mounted) {
          setChecking(false)
          setCheckedAt(Date.now())
          pollTimer = setTimeout(ping, HEALTH_POLL_MS)
        }
      }
    }
    checkRef.current = ping
    void ping()
    return () => { mounted = false; clearTimeout(pollTimer); controller?.abort() }
  }, [isTauri, status])
  if (!isTauri) return null
  const health: Health = status === 'terminated' || failures >= 3 ? 'red'
    : status === 'restarting' || restarting ? 'unknown'
      : lastOk === true ? dependencyWarning ? 'yellow' : 'green' : lastOk === false ? 'yellow' : 'unknown'
  const fullStatus = health === 'green' ? detail : health === 'yellow' ? dependencyWarning && lastOk ? detail.replace(/^已连接 · /, '依赖待检查：') : `连接异常：${detail}` : health === 'red' ? status === 'terminated' ? `后端已退出（code=${exitCode ?? 'unknown'}）` : `后端无响应：${detail}` : restarting || status === 'restarting' ? '后端正在重启' : detail
  return <>
    <BackendStatusButton health={health} label={fullStatus} onClick={() => setOpen(true)} />
    {open && <BackendLogPanel status={status} exitCode={exitCode} logs={logs} health={health}
      restarting={restarting} checking={checking} checkedAt={checkedAt} detail={detail}
      onCheck={() => checkRef.current()} onRestart={async () => { await restart(); await checkRef.current() }}
      onCopyLogs={copyLogs} onClose={() => setOpen(false)} />}
  </>
}
export default BackendHealthIndicator
