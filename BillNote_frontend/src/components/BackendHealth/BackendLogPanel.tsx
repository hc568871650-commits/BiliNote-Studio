import { useEffect, useRef, useState } from 'react'
import { Clipboard, RefreshCw, RotateCcw, Terminal } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { LogEntry, BackendStatus } from './useBackendEvents'
import type { Health } from './BackendHealthIndicator'

interface Props {
  status: BackendStatus
  exitCode: number | null
  logs: LogEntry[]
  health: Health
  restarting: boolean
  checking: boolean
  checkedAt: number | null
  detail: string
  onCheck: () => Promise<void>
  onRestart: () => Promise<void>
  onCopyLogs: () => Promise<boolean>
  onClose: () => void
}
const BackendLogPanel = ({ status, exitCode, logs, health, restarting, checking, checkedAt, detail, onCheck, onRestart, onCopyLogs, onClose }: Props) => {
  const [feedback, setFeedback] = useState('')
  const [copying, setCopying] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [follow, setFollow] = useState(true)
  const [restartPending, setRestartPending] = useState(false)
  const restartLock = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const visible = errorsOnly ? logs.filter(log => log.level === 'error') : logs
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [logs, follow, errorsOnly])
  async function handleRestart() {
    if (restartLock.current) return
    restartLock.current = true
    setRestartPending(true)
    setFeedback('正在重启服务，稍后将重新检查连接…')
    try { await onRestart(); if (mounted.current) setFeedback('重启命令已完成，请以连接检查结果为准。') }
    catch { if (mounted.current) setFeedback('重启失败，请查看错误日志后重试。') }
    finally { restartLock.current = false; if (mounted.current) setRestartPending(false) }
  }
  async function handleCopy() {
    setCopying(true)
    const ok = await onCopyLogs()
    if (mounted.current) {
      setCopying(false)
      setFeedback(ok ? '已复制脱敏日志。分享前请检查业务内容和个人信息。' : '复制失败，请检查剪贴板权限后重试。')
    }
  }
  const title = status === 'terminated' ? '后端已退出' : restarting || status === 'restarting' ? '后端正在重启'
    : health === 'green' ? '后端连接正常' : health === 'red' ? '后端暂不可用' : health === 'yellow' ? '后端需要检查' : '正在检查后端'
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent className="backend-management-panel">
      <DialogHeader className="backend-management-heading">
        <span className="backend-eyebrow"><Terminal size={15} /> 服务管理</span>
        <DialogTitle className="backend-management-title"><span className={`backend-dot backend-dot-${health}`} />{title}</DialogTitle>
        <DialogDescription>检查服务连接、查看最近日志，或重新启动本应用的后端。</DialogDescription>
      </DialogHeader>
      <div className="backend-health-summary">
        <div><span>连接检查</span><strong>{detail}</strong></div>
        <div><span>最近检查</span><strong>{checkedAt ? new Date(checkedAt).toLocaleTimeString() : '尚未完成'}</strong></div>
        <div><span>进程状态</span><strong>{status === 'terminated' ? `已退出 · ${exitCode ?? '未知退出码'}` : status === 'restarting' ? '正在重启' : status === 'running' ? '重启事件已确认' : '尚未收到进程事件'}</strong></div>
      </div>
      <div className="backend-actions">
        <Button size="sm" variant="outline" onClick={() => { void onCheck() }} disabled={checking || restarting || restartPending}><RefreshCw size={14} className={checking ? 'animate-spin' : ''} />{checking ? '检查中' : '重新检查'}</Button>
        <Button size="sm" onClick={handleRestart} disabled={restarting || restartPending}><RotateCcw size={14} className={restarting || restartPending ? 'animate-spin' : ''} />{restarting || restartPending ? '重启中' : '重启后端'}</Button>
        <Button size="sm" variant="outline" onClick={handleCopy} disabled={copying || !logs.length}><Clipboard size={14} />{copying ? '复制中' : '复制脱敏日志'}</Button>
      </div>
      <p className="backend-action-feedback" role="status">{feedback || '检查不会重启进程。重启可能中断正在运行的任务。'}</p>
      <div className="backend-log-toolbar">
        <span>运行日志 <small>最近 {logs.length} 条</small></span>
        <label><input type="checkbox" checked={errorsOnly} onChange={event => setErrorsOnly(event.target.checked)} /> 仅错误</label>
        <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> 跟随日志</label>
      </div>
      <div ref={scrollRef} className="backend-log-view" tabIndex={0} aria-label="后端运行日志">
        {visible.length === 0 ? <div className="backend-log-empty">{errorsOnly ? '暂未记录错误日志' : '暂无日志；日志将从本次应用连接开始记录。'}</div>
          : visible.map((log, index) => <div key={`${log.ts}-${index}`} className={`backend-log-line ${log.level === 'error' ? 'backend-log-error' : ''}`}>
            <time>{new Date(log.ts).toLocaleTimeString()}</time><span className="backend-log-level">{log.level === 'error' ? '错误' : '信息'}</span><span>{log.text}</span>
          </div>)}
      </div>
      <p className="backend-log-note">日志已过滤常见密钥、Cookie 和认证凭据；自动脱敏无法覆盖所有业务信息。</p>
    </DialogContent>
  </Dialog>
}
export default BackendLogPanel
