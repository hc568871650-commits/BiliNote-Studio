import { useEffect, useState } from 'react'
import ChoiceSelect from '@/components/ChoiceSelect'
import { Switch } from '@/components/ui/switch'
import request from '@/utils/request'
import { capabilityErrorMessage } from '@/services/modelCapabilities'
import TavilyUsage from '@/components/TavilyUsage'
import './web-search-settings.css'

type SearchProvider = 'searxng' | 'tavily'
interface Profile { base_url: string; api_key: string }
interface Settings { enabled: boolean; provider: SearchProvider; base_url: string; api_key: string; profiles: Record<SearchProvider, Profile> }
const names: Record<SearchProvider, string> = { searxng: 'SearXNG', tavily: 'Tavily' }
const emptyProfiles = (): Record<SearchProvider, Profile> => ({ searxng: { base_url: '', api_key: '' }, tavily: { base_url: 'https://api.tavily.com', api_key: '' } })
const normalize = (saved: Settings): Settings => {
  const provider = saved.provider || 'searxng'
  return { ...saved, provider, profiles: saved.profiles || { ...emptyProfiles(), [provider]: { base_url: saved.base_url, api_key: saved.api_key } } }
}

export default function WebSearchSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [drafts, setDrafts] = useState(emptyProfiles)
  const [selected, setSelected] = useState<SearchProvider>('searxng')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [usageRevision, setUsageRevision] = useState(0)
  const profile = drafts[selected]
  const savedProfile = settings?.profiles[selected]
  const dirty = !!savedProfile && (profile.base_url !== savedProfile.base_url || profile.api_key !== savedProfile.api_key)
  const current = selected === settings?.provider
  const tavily = selected === 'tavily'
  const disabled = loading || busy || !settings

  useEffect(() => {
    let active = true
    void request.get('/web_search/settings', { suppressToast: true }).then(result => {
      if (!active) return
      const saved = normalize(result as unknown as Settings)
      setSettings(saved)
      setDrafts(saved.profiles)
      setSelected(saved.provider)
    }).catch(error => { if (active) setMessage(capabilityErrorMessage(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const notify = (saved: Settings) => {
    setUsageRevision(value => value + 1)
    setSettings(saved)
    window.dispatchEvent(new Event('bilinote-capabilities-updated'))
  }
  const saveProfile = () => {
    const provider = selected
    setBusy(true)
    setMessage('')
    void request.put(`/web_search/profiles/${provider}`, drafts[provider], { suppressToast: true }).then(result => {
      const saved = normalize(result as unknown as Settings)
      notify(saved)
      setDrafts(previous => ({ ...previous, [provider]: saved.profiles[provider] }))
      setMessage(`${names[provider]} 配置已保存`)
    }).catch(error => setMessage(capabilityErrorMessage(error))).finally(() => setBusy(false))
  }
  const setSelection = (change: { enabled?: boolean; provider?: SearchProvider }) => {
    setBusy(true)
    setMessage('')
    void request.put('/web_search/selection', change, { suppressToast: true }).then(result => {
      const saved = normalize(result as unknown as Settings)
      notify(saved)
      setMessage(change.provider ? `当前服务：${names[saved.provider]}` : saved.enabled ? '外部检索已开启' : '外部检索已关闭')
    }).catch(error => setMessage(capabilityErrorMessage(error))).finally(() => setBusy(false))
  }
  const edit = (change: Partial<Profile>) => {
    setDrafts(previous => ({ ...previous, [selected]: { ...previous[selected], ...change } }))
    setMessage('')
  }

  return <div className="search-settings">
    <div className="settings-row search-settings-option">
      <div><h2>外部检索</h2><p>{settings ? `当前服务：${names[settings.provider]}` : '读取配置中'} · 联网搜索按需调用</p></div>
      <Switch aria-label="外部检索总开关" checked={settings?.enabled || false} disabled={disabled} onCheckedChange={enabled => setSelection({ enabled })} />
    </div>
    {settings && tavily && <TavilyUsage key={usageRevision} configured={!!settings.profiles.tavily.api_key} />}
    <details className="settings-search-advanced">
      <summary>检索服务配置<span className="search-settings-state">{names[selected]}</span></summary>
      <form autoComplete="off" onSubmit={event => { event.preventDefault(); saveProfile() }}>
        <fieldset disabled={disabled}>
          <div className="settings-row search-settings-option">
            <span>检索服务</span>
            <ChoiceSelect label="检索服务" className="settings-fixed-control" value={selected} onChange={provider => { setSelected(provider as SearchProvider); setMessage('') }} disabled={disabled}
              options={(['tavily', 'searxng'] as SearchProvider[]).map(provider => ({ value: provider, label: names[provider] }))} />
          </div>
          {!tavily && <div className="settings-field">
            <label htmlFor="search-service-url">检索服务地址</label>
            <input id="search-service-url" name="external-search-endpoint" type="url" autoComplete="off" placeholder="https://search.example.com" value={profile.base_url} onChange={event => edit({ base_url: event.target.value })} />
            <small>SearXNG 需启用 JSON；搜索问题会发送到当前服务。</small>
          </div>}
          <div className="settings-field">
            <label htmlFor="search-service-key">{tavily ? 'Tavily API Key' : '访问令牌（可选）'}</label>
            <input id="search-service-key" name="external-search-access-token" type="password" autoComplete="new-password" required={tavily && current && settings?.enabled} placeholder={tavily ? 'tvly-…' : 'Bearer 令牌（如需要）'} value={profile.api_key} onChange={event => edit({ api_key: event.target.value })} />
          </div>
          {tavily && <p className="settings-footnote search-settings-cost">基础搜索每次 1 点；读取网页不消耗 Tavily 点数。<a className="settings-link" href="https://app.tavily.com" target="_blank" rel="noopener noreferrer">获取 API Key ↗</a><br />每月 1,000 免费点数，以账户实际额度为准。</p>}
          <div className="search-settings-actions">
            <button type="submit" className="settings-button is-primary" disabled={disabled || !dirty}>保存配置</button>
            <button type="button" className="settings-button" disabled={disabled || dirty || current} title={dirty ? '请先保存配置' : undefined} onClick={() => setSelection({ provider: selected })}>{current ? '当前使用' : '设为当前服务'}</button>
            {dirty && <span className="search-settings-unsaved">未保存</span>}
          </div>
        </fieldset>
      </form>
    </details>
    {message && <p className="search-settings-message" role="status">{message}</p>}
  </div>
}
