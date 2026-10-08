import ChoiceSelect from '@/components/ChoiceSelect'
import { useInterfaceStore } from '@/store/interfaceStore'
import { useEffect, useRef, useState } from 'react'
import OrganizerRetentionDialog from '@/components/OrganizerRetentionDialog'
import { getOrganizerRetention, previewOrganizerRetention, retentionFailure, setOrganizerRetention, listOrganizerSessions, type OrganizerRetentionPreview } from '@/services/organizer'
import { useOrganizerStore } from '@/store/organizerStore'
import { isQuickEdition } from '@/utils/edition'
export default function General() {
  const preferences = useInterfaceStore()
  const [limit, setLimit] = useState('10')
  const [savedLimit, setSavedLimit] = useState<number | null>(null)
  const [retentionBusy, setRetentionBusy] = useState(false)
  const [retentionError, setRetentionError] = useState<string | null>(null)
  const [preview, setPreview] = useState<OrganizerRetentionPreview | null>(null)
  const limitInput = useRef<HTMLInputElement>(null)
  useEffect(() => { if (isQuickEdition) return; let live = true; void getOrganizerRetention().then(data => { if (live) { setLimit(String(data.limit)); setSavedLimit(data.limit) } }).catch(() => { if (live) setRetentionError('整理会话设置读取失败，请重新打开设置后重试。') }); return () => { live = false } }, [])
  const saveLimit = async (confirmed = false) => {
    const next = confirmed ? preview?.limit : Number(limit)
    if (!Number.isInteger(next) || next! < 1 || next! > 100) { setRetentionError('请输入 1–100 之间的整数。'); return }
    setRetentionBusy(true); setRetentionError(null)
    try {
      if (!confirmed) {
        const proposed = await previewOrganizerRetention('set_limit', next)
        if (proposed.blocked) { setRetentionError('运行中或已中断的会话受到保护，无法腾出足够位置。请先完成或恢复这些会话，再调整保留数量。'); return }
        if (proposed.evictions.length) { setPreview(proposed); return }
      }
      const result = await setOrganizerRetention(next!, confirmed ? preview?.confirmation_token || undefined : undefined)
      setSavedLimit(result.limit); setLimit(String(result.limit)); setPreview(null)
      try { useOrganizerStore.setState({ sessions: (await listOrganizerSessions()).sessions }); await useOrganizerStore.getState().refresh() }
      catch { setRetentionError('保留数量已保存，但会话列表刷新失败。请返回整理助手重新读取。') }
    } catch (error) {
      const proposed = retentionFailure(error)
      if (proposed) {
        if (proposed.blocked) { setPreview(null); setRetentionError('运行中或已中断的会话受到保护，无法腾出足够位置。设置未更改。') }
        else { setPreview(proposed); setRetentionError('会话列表已变化，请重新审阅清理名单后确认。') }
      } else setRetentionError((error as { msg?: string; message?: string }).msg || (error as Error).message || '设置保存失败，请重试。')
    } finally { setRetentionBusy(false) }
  }
  return <article className="settings-page"><header className="settings-page-header"><h1>常规</h1></header>
    <h2 className="settings-section-title">工作区</h2><section className="settings-card"><div className="settings-row"><div><h2>启动页面</h2><p>下次打开应用时进入的页面</p></div><ChoiceSelect label="启动页面" value={preferences.startPage} onChange={value => preferences.update({ startPage: value as 'recent' | 'create' })} options={[{ value:'recent',label:'最近阅读' },{ value:'create',label:'新建笔记' }]} /></div>
      <div className="settings-row"><div><h2>切换时保留工作区</h2><p>阅读位置、筛选条件与新建草稿在进入设置后保留</p></div><span className="settings-status">已启用</span></div></section>
    <h2 className="settings-section-title">对话</h2><section className="settings-card"><div className="settings-row"><div><h2>发送快捷键</h2><p>{isQuickEdition ? '同时应用于阅读问答和临时聊天' : '同时应用于阅读问答、临时聊天和整理助手'}</p></div><ChoiceSelect label="发送快捷键" value={preferences.sendKey} onChange={value => preferences.update({ sendKey: value as 'enter' | 'mod-enter' })} options={[{ value:'enter',label:'Enter 发送' },{ value:'mod-enter',label:'Ctrl+Enter 发送' }]} /></div>
      <div className="settings-row"><div><h2>流式回复</h2><p>阅读助手和临时聊天边接收边显示</p></div><ChoiceSelect label="流式回复" value={preferences.streamReading ? 'on' : 'off'} onChange={value => preferences.update({ streamReading: value === 'on' })} options={[{ value: 'on', label: '开启' }, { value: 'off', label: '关闭' }]} /></div>
      {!isQuickEdition && <div className="settings-row"><div><h2>整理会话保留数量</h2><p>默认保留最近 10 个对话，可设为 1–100。超过数量时先确认清理；运行中与中断的会话受到保护。{savedLimit !== null && `当前已保存：${savedLimit} 个。`}</p></div><div className="organizer-retention-setting"><ChoiceSelect label="常用整理会话保留数量" value={['5', '10', '20', '50', '100'].includes(limit) ? limit : 'custom'} disabled={retentionBusy || savedLimit === null} onChange={value => { if (value !== 'custom') setLimit(value); else requestAnimationFrame(() => { limitInput.current?.focus(); limitInput.current?.select() }) }} options={[...['5', '10', '20', '50', '100'].map(value => ({ value, label: `${value} 个` })), { value: 'custom', label: '自定义' }]} /><input ref={limitInput} type="number" min={1} max={100} step={1} aria-label="整理会话保留数量" value={limit} disabled={retentionBusy || savedLimit === null} onChange={event => setLimit(event.target.value)} /><button disabled={retentionBusy || savedLimit === null || Number(limit) === savedLimit} onClick={() => void saveLimit()}>保存</button></div></div>}
      {retentionError && !preview && <p className="organizer-error" role="alert">{retentionError}</p>}
      </section>
    <OrganizerRetentionDialog preview={preview} busy={retentionBusy} error={retentionError} onCancel={() => { setPreview(null); setRetentionError(null); if (savedLimit !== null) setLimit(String(savedLimit)) }} onConfirm={() => void saveLimit(true)} />
  </article>
}
