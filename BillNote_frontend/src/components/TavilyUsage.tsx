import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import request from '@/utils/request'
import { capabilityErrorMessage } from '@/services/modelCapabilities'

interface Balance { used: number | null; limit: number | null; remaining: number | null }
interface Usage {
  simulated?: boolean
  configured: boolean; checked_at: string | null; cached: boolean; stale: boolean
  retry_after_seconds: number; error: string | null
  account: (Balance & { plan: string | null; paygo_used: number | null; paygo_limit: number | null }) | null
  key: Balance | null
}
const points = (value: number | null | undefined) => value == null ? '未知' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)

export default function TavilyUsage({ configured }: { configured: boolean }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const refresh = useRef<(force?: boolean) => void>(() => {})

  useEffect(() => {
    let active = true, pending = false, nextAttempt = 0
    let controller: AbortController | undefined
    const load = async (force = false) => {
      if (!configured || pending || document.hidden || Date.now() < nextAttempt) return
      pending = true
      controller = new AbortController()
      setBusy(true)
      try {
        const result = await request.get('/web_search/tavily/usage', {
          params: { refresh: force }, signal: controller.signal, suppressToast: true, timeout: 20000,
        }) as unknown as Usage
        if (!active) return
        nextAttempt = Date.now() + Math.max(0, result.retry_after_seconds) * 1000
        setRetryAt(nextAttempt)
        setNow(Date.now())
        setUsage(result)
        setError(result.error || '')
      } catch (caught) {
        if (!active) return
        setError(capabilityErrorMessage(caught))
        nextAttempt = Date.now() + 65000
        setRetryAt(nextAttempt)
      } finally {
        pending = false
        if (active) setBusy(false)
      }
    }
    refresh.current = force => { void load(force) }
    const visible = () => { if (!document.hidden) { setNow(Date.now()); void load() } }
    void load()
    const poll = window.setInterval(() => { void load() }, 300000)
    const clock = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      controller?.abort()
      refresh.current = () => {}
      clearInterval(poll); clearInterval(clock)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [configured])

  const account = usage?.account
  const stale = usage?.stale || !!error
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000))
  const percent = account?.used != null && account.limit != null && account.limit > 0
    ? Math.min(100, Math.max(0, account.used / account.limit * 100)) : null
  return <section className="search-usage" aria-label="Tavily 点数">
    <div className="search-usage-heading">
      <strong title="按已保存的 Tavily Key 查询；保存新 Key 后更新">Tavily 点数</strong>
      <button type="button" className="settings-button" aria-label="刷新额度" disabled={!configured || busy || cooldown > 0}
        title={cooldown ? `${cooldown} 秒后可刷新` : '查询官方额度'} onClick={() => refresh.current(true)}>
        <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />刷新
      </button>
    </div>
    {!configured ? <p>保存 Tavily Key 后自动查询</p> : <>
      <div className="search-usage-balance" aria-live="polite">
        <strong>{account?.remaining != null ? `剩余 ${points(account.remaining)} 点` : busy && !usage ? '正在查询额度…' : '账户剩余额度未知'}</strong>
        {stale && usage?.checked_at && <span>上次记录</span>}
      </div>
      {account && <p>已用 {points(account.used)} / {points(account.limit)} 点{account.plan ? ` · ${account.plan}` : ''}</p>}
      {percent != null && <progress aria-label="Tavily 套餐用量" value={percent} max={100} />}
      <div className="search-usage-meta">
        <span>{usage?.checked_at ? `更新于 ${new Date(usage.checked_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未取得额度记录'}</span>
        <span title="页面可见时每 5 分钟更新；刷新间隔受官方限流约束">{usage?.simulated ? '示例数据 · 自动更新' : '自动更新'}</span>
      </div>
      {error && <p className="search-usage-error" role="status">{error}</p>}
      {(usage?.key || account?.paygo_used != null && account.paygo_used > 0 || account?.paygo_limit != null) && <details className="search-usage-details">
        <summary>用量详情</summary>
        {usage?.key && <p>此 Key 已用 {points(usage.key.used)} 点 · 上限 {points(usage.key.limit)}</p>}
        {account && (account.paygo_used != null && account.paygo_used > 0 || account.paygo_limit != null) && <p>按量付费已用 {points(account.paygo_used)} 点 · 上限 {points(account.paygo_limit)}</p>}
      </details>}
    </>}
  </section>
}
