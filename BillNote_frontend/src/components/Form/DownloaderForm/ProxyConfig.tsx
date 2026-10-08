import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Switch } from '@/components/ui/switch'
import { getProxyConfig, updateProxyConfig } from '@/services/proxy'
let proxyDraft: { enabled: boolean; url: string } | null = null

// 全局代理配置：作用于 LLM API + 转写 API（Groq 等）+ yt-dlp 视频下载。
// 国内访问 OpenAI / Groq / YouTube 基本都要靠它。
const ProxyConfig = () => {
  const [enabled, setEnabled] = useState(false)
  const [url, setUrl] = useState('')
  const [effective, setEffective] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const cfg = await getProxyConfig()
        setEnabled(proxyDraft?.enabled ?? cfg.enabled)
        setUrl(proxyDraft?.url ?? cfg.url)
        setEffective(cfg.effective)
      } catch {
        /* 拦截器已 toast */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const handleSave = async () => {
    if (enabled && !url.trim()) {
      toast.error('请填写代理地址，或关闭代理开关')
      return
    }
    setSaving(true)
    try {
      const cfg = await updateProxyConfig({ enabled, url: url.trim() })
      setEnabled(cfg.enabled)
      setUrl(cfg.url)
      setEffective(cfg.effective)
      proxyDraft = null
      toast.success('代理配置已保存')
    } catch {
      /* 拦截器已 toast */
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-xs text-gray-400">加载代理配置…</div>
  }

  // env 兜底：配置没开但 effective 有值，说明来自 HTTP_PROXY 环境变量
  const fromEnv = !enabled && !!effective

  return (
    <section className="settings-card">
      <div className="settings-row">
        <div><h2>全局代理</h2><p>作用于 AI 模型接口、转写接口和视频下载。</p></div>
        <Switch aria-label="启用全局代理" checked={enabled} onCheckedChange={value => { setEnabled(value); proxyDraft = { enabled: value, url } }} />
      </div>
      <div className="settings-field"><label htmlFor="download-proxy-url">代理地址</label><input
        id="download-proxy-url"
        placeholder="http://127.0.0.1:7890"
        value={url}
        disabled={!enabled}
        onChange={e => { setUrl(e.target.value); proxyDraft = { enabled, url: e.target.value } }}
      />
      {fromEnv && (
        <p className="settings-muted">
          当前生效（来自环境变量）：{effective}
        </p>
      )}
      {enabled && effective && (
        <p className="settings-muted">当前生效：{effective}</p>
      )}
      <div className="settings-actions"><button type="button" className="settings-button" onClick={handleSave} disabled={saving}>
        {saving ? '保存中…' : '保存代理配置'}
      </button></div></div>
    </section>
  )
}

export default ProxyConfig
