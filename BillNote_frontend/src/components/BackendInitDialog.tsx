import { useMemo, useRef, useState } from 'react'
import './startup.css'
import { Button } from '@/components/ui/button'
import { Loader2, AlertTriangle, RotateCcw, Clipboard, RefreshCw } from 'lucide-react'
import { redactLog, useBackendEvents } from '@/components/BackendHealth/useBackendEvents'

interface Props {
  open: boolean
  failed?: boolean
  lastError?: string | null
  onRetry?: () => void
}
function BackendInitDialog({ open, failed = false, lastError = null, onRetry }: Props) {
  const { isTauri, restart, copyLogs, logs, restarting } = useBackendEvents()
  const [feedback, setFeedback] = useState('')
  const [pending, setPending] = useState(false)
  const retryLock = useRef(false)
  const stderrPreview = useMemo(() => failed ? logs.filter(log => log.level === 'error').slice(-6).map(log => log.text) : [], [failed, logs])
  async function handleRestart() {
    if (retryLock.current) return
    retryLock.current = true
    setPending(true)
    setFeedback('正在重启后端…')
    try {
      await restart()
      onRetry?.()
      setFeedback('重启命令已完成，正在重新检查连接。')
    } catch { setFeedback('重启失败，请查看下方日志后重试。') }
    finally { retryLock.current = false; setPending(false) }
  }
  async function handleCopy() {
    const ok = await copyLogs()
    setFeedback(ok ? '已复制脱敏日志，分享前请检查个人和业务信息。' : '复制失败，请检查剪贴板权限后重试。')
  }
  if (!open && !failed) return null
  return <main className="startup-screen">
    <div className="startup-brand"><span>BiliNote Studio</span><span className="startup-brand-caption">学习工作台</span></div>
    <section className="startup-card" aria-labelledby="startup-title" aria-busy={!failed}>
      <header>
        <h1 id="startup-title" className="startup-title">
          {failed ? <AlertTriangle className="h-5 w-5 text-destructive" /> : <Loader2 className="h-5 w-5 animate-spin text-primary" />}
          {failed ? '暂时无法连接后端' : '正在准备你的工作台'}
        </h1>
        <p className="startup-description" role="status">
          {failed ? redactLog(lastError || '服务在预计时间内未就绪，请重新检查连接或查看启动日志。') : '正在连接本地服务，就绪后自动进入笔记库。'}
        </p>
      </header>
      {failed && <>
        {stderrPreview.length > 0 && <div className="space-y-2">
          <p className="text-xs text-muted-foreground">最近 {stderrPreview.length} 条错误日志</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-muted p-3 text-xs leading-relaxed text-destructive">{stderrPreview.join('\n')}</pre>
        </div>}
        <p className="text-sm text-muted-foreground">先重新检查连接；若服务持续不可用，可重启后端并查看日志中的具体错误。</p>
        <div className="flex flex-wrap gap-2">
          {onRetry && <Button size="sm" variant="outline" disabled={pending || restarting} onClick={() => { setFeedback('正在重新检查连接…'); onRetry() }}><RefreshCw className="h-4 w-4" />重新检查</Button>}
          {isTauri && <Button size="sm" disabled={pending || restarting} onClick={handleRestart}>
            {pending || restarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            {pending || restarting ? '重启中…' : '重启后端'}
          </Button>}
          {isTauri && <Button size="sm" variant="outline" disabled={!logs.length} onClick={handleCopy}><Clipboard className="h-4 w-4" />复制脱敏日志</Button>}
        </div>
        <p role="status" className="min-h-4 text-xs text-muted-foreground">{feedback || '重启可能中断正在运行的任务。'}</p>
      </>}
      {!failed && <div className="startup-wait"><span className="startup-pulse" aria-hidden="true" /><span>首次启动可能需要稍长时间</span></div>}
    </section>
    <footer className="startup-footer">视频笔记 · 阅读 · 整理</footer>
  </main>
}
export default BackendInitDialog
