import { RefreshCw, Loader2 } from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'
import { getDeployStatus, DeployStatus } from '@/services/system'
import { hasLocalWhisper, quickTranscriberTypes } from '@/utils/edition'

export default function Monitor() {
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      setStatus(await getDeployStatus())
      setLastUpdated(new Date())
    } catch {
      setError('无法连接到后端服务')
      setStatus(null)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const isLocal = hasLocalWhisper && (status?.whisper.transcriber_type === 'fast-whisper' || status?.whisper.transcriber_type === 'mlx-whisper')
  const engine = !hasLocalWhisper && !quickTranscriberTypes.includes(status?.whisper.transcriber_type || '') ? '' : status?.whisper.transcriber_type
  const hasEngine = Boolean(engine?.trim())
  return <article className="settings-page">
    <header className="settings-page-header"><h1>运行状态</h1><p>查看后端服务、转写引擎及本地依赖的当前状态。</p></header>
    <section className="settings-card">
      <div className="settings-row"><div><h2>状态刷新</h2><p>{lastUpdated ? `最后更新：${lastUpdated.toLocaleTimeString()}` : '尚未获取状态'}。每 30 秒自动刷新。</p></div><button type="button" className="settings-button" onClick={fetchStatus} disabled={loading}>{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}刷新</button></div>
    </section>
    {error && <p role="alert" className="runtime-error">{error}</p>}
    {loading && !status && <p className="settings-muted">加载运行状态…</p>}
    {status && <>
      <h2 className="settings-section-title">服务与设备</h2>
      <section className="settings-card">
        <div className="settings-row"><div><h2>后端 FastAPI</h2><p>{status.simulated ? '当前为界面模拟，未探测真实服务。' : `服务端口：${status.backend.port}`}</p></div><span className={`runtime-state runtime-state--${status.simulated ? 'info' : status.backend.status === 'running' ? 'ok' : 'error'}`}>{status.backend.status === 'running' ? '运行中' : status.backend.status || '状态未知'}</span></div>
        {hasLocalWhisper && <div className="settings-row"><div><h2>CUDA GPU</h2><p>{status.cuda.available ? `GPU：${status.cuda.gpu_name} · CUDA 版本：${status.cuda.version}` : 'CUDA 不可用，将使用 CPU 模式。'}</p></div><span className={`runtime-state runtime-state--${status.cuda.available ? 'ok' : 'warning'}`}>{status.cuda.available ? '已启用' : '未启用'}</span></div>}
      </section>
      <h2 className="settings-section-title">转写与视频处理</h2>
      <section className="settings-card">
        <div className="settings-row"><div><h2>转写引擎</h2><p>当前引擎：{engine || '未配置'}{isLocal && ` · 模型大小：${status.whisper.model_size}`}</p>{isLocal && <p>{status.whisper.downloaded ? '本地模型已就绪。' : '未下载，首次转写会触发下载。'}</p>}</div><span className={`runtime-state runtime-state--${!hasEngine ? 'warning' : isLocal ? status.whisper.downloaded ? 'ok' : 'warning' : 'info'}`}>{!hasEngine ? '未配置' : isLocal ? status.whisper.downloaded ? '已下载' : '未下载' : '在线引擎 · 未检测连接'}</span></div>
        <div className="settings-row"><div><h2>FFmpeg</h2><p>{status.ffmpeg.available ? '已安装，可用于视频和音频处理。' : '未安装，请安装 FFmpeg 并添加到系统 PATH。'}</p></div><span className={`runtime-state runtime-state--${status.ffmpeg.available ? 'ok' : 'error'}`}>{status.ffmpeg.available ? '可用' : '不可用'}</span></div>
      </section>
    </>}
  </article>
}
