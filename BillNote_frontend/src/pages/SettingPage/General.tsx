import ChoiceSelect from '@/components/ChoiceSelect'
import { useInterfaceStore } from '@/store/interfaceStore'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import type { DistillNotificationMode } from '@/utils/distillNotifications'
import { useEffect, useRef, useState } from 'react'
import OrganizerRetentionDialog from '@/components/OrganizerRetentionDialog'
import { getOrganizerRetention, previewOrganizerRetention, retentionFailure, setOrganizerRetention, listOrganizerSessions, type OrganizerRetentionPreview } from '@/services/organizer'
import { useOrganizerStore } from '@/store/organizerStore'
import { isQuickEdition } from '@/utils/edition'
import { getPlaybackCachePolicy, updatePlaybackCachePolicy, type PlaybackCachePolicy } from '@/services/system'
import { isTauriDesktop } from '@/hooks/useQuickCapture'
import toast from 'react-hot-toast'
export default function General() {
  const preferences = useInterfaceStore()
  const notificationMode = useDistillQueueStore(state => state.notificationMode)
  const setNotificationMode = useDistillQueueStore(state => state.setNotificationMode)
  const [limit, setLimit] = useState('10')
  const [savedLimit, setSavedLimit] = useState<number | null>(null)
  const [retentionBusy, setRetentionBusy] = useState(false)
  const [retentionError, setRetentionError] = useState<string | null>(null)
  const [preview, setPreview] = useState<OrganizerRetentionPreview | null>(null)
  const [playbackPolicy, setPlaybackPolicy] = useState<PlaybackCachePolicy>({ enabled: false, retention_days: 7, max_size_mb: 1024 })
  const [playbackBusy, setPlaybackBusy] = useState(false)
  const limitInput = useRef<HTMLInputElement>(null)
  const isDesktop = isTauriDesktop()
  useEffect(() => {
    let live = true
    void getPlaybackCachePolicy().then(data => { if (live) setPlaybackPolicy(data) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  const savePlaybackPolicy = async (patch: Partial<PlaybackCachePolicy>) => {
    setPlaybackBusy(true)
    try {
      const updated = await updatePlaybackCachePolicy(patch)
      setPlaybackPolicy(updated)
      toast.success('回看缓存策略已保存')
    } catch {
      toast.error('保存回看缓存策略失败')
    } finally {
      setPlaybackBusy(false)
    }
  }
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
      <div className="settings-row"><div><h2>自动恢复阅读位置</h2><p>关闭时从头打开，保留继续阅读入口</p></div><ChoiceSelect label="自动恢复阅读位置" value={preferences.restoreReadingPosition ? 'on' : 'off'} onChange={value => preferences.update({ restoreReadingPosition: value === 'on' })} options={[{ value: 'on', label: '开启' }, { value: 'off', label: '关闭' }]} /></div>
      <div className="settings-row"><div><h2>蒸馏完成提醒</h2><p>与蒸馏队列头部快捷切换同步</p></div><ChoiceSelect label="蒸馏完成提醒" value={notificationMode} onChange={value => setNotificationMode(value as DistillNotificationMode)} options={[{ value: 'all_done', label: '全部完成后提醒（默认）' }, { value: 'each', label: '每完成一篇提醒' }, { value: 'off', label: '关闭提醒' }]} /></div>
      <div className="settings-row"><div><h2>笔记输出语言</h2><p>外文视频或推文的默认笔记撰写语言</p></div><ChoiceSelect label="笔记输出语言" value={preferences.outputLanguage || 'zh-CN'} onChange={value => preferences.update({ outputLanguage: value as 'zh-CN' | 'source' })} options={[{ value: 'zh-CN', label: '默认简体中文' }, { value: 'source', label: '跟随原文' }]} /></div>
      <div className="settings-row"><div><h2>全局快捷捕获</h2><p>{isDesktop ? '后台直接从剪贴板识别链接并提交蒸馏队列' : '仅桌面端支持系统级全局快捷键与托盘捕获'}</p></div><div className="flex items-center gap-2"><ChoiceSelect label="全局快捷捕获开关" disabled={!isDesktop} value={preferences.quickCaptureEnabled ? 'on' : 'off'} onChange={value => preferences.update({ quickCaptureEnabled: value === 'on' })} options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }]} /><ChoiceSelect label="全局快捷键" disabled={!isDesktop || !preferences.quickCaptureEnabled} value={preferences.quickCaptureShortcut || 'Alt+Shift+B'} onChange={value => preferences.update({ quickCaptureShortcut: value })} options={[{ value: 'Alt+Shift+B', label: 'Alt+Shift+B' }, { value: 'Ctrl+Shift+B', label: 'Ctrl+Shift+B' }, { value: 'Ctrl+Alt+B', label: 'Ctrl+Alt+B' }]} /></div></div>
      <div className="settings-row"><div><h2>保留低码率本地视频回看缓存</h2><p>开启后为在线视频缓存轻量回看副本，支持卷帘悬浮播放与字幕同步</p></div><ChoiceSelect label="低码率回看缓存" disabled={playbackBusy} value={playbackPolicy.enabled ? 'on' : 'off'} onChange={value => void savePlaybackPolicy({ enabled: value === 'on' })} options={[{ value: 'off', label: '关闭（默认）' }, { value: 'on', label: '开启' }]} /></div>
      {playbackPolicy.enabled && <div className="settings-row"><div><h2>回看缓存自动清理规则</h2><p>超期或超出容量上限时按最旧文件自动滚动清理，不影响笔记正文</p></div><div className="flex items-center gap-2"><ChoiceSelect label="保留时长" disabled={playbackBusy} value={String(playbackPolicy.retention_days)} onChange={value => void savePlaybackPolicy({ retention_days: Number(value) as PlaybackCachePolicy['retention_days'] })} options={[{ value: '7', label: '7 天' }, { value: '30', label: '30 天' }, { value: '0', label: '不限时长' }]} /><ChoiceSelect label="容量上限" disabled={playbackBusy} value={String(playbackPolicy.max_size_mb)} onChange={value => void savePlaybackPolicy({ max_size_mb: Number(value) })} options={[{ value: '512', label: '512 MB' }, { value: '1024', label: '1 GB' }, { value: '2048', label: '2 GB' }, { value: '5120', label: '5 GB' }]} /></div></div>}
      <div className="settings-row"><div><h2>切换时保留工作区</h2><p>阅读位置、筛选条件与新建草稿在进入设置后保留</p></div><span className="settings-status">已启用</span></div></section>
    <h2 className="settings-section-title">对话</h2><section className="settings-card"><div className="settings-row"><div><h2>发送快捷键</h2><p>{isQuickEdition ? '同时应用于阅读问答和临时聊天' : '同时应用于阅读问答、临时聊天和整理助手'}</p></div><ChoiceSelect label="发送快捷键" value={preferences.sendKey} onChange={value => preferences.update({ sendKey: value as 'enter' | 'mod-enter' })} options={[{ value:'enter',label:'Enter 发送' },{ value:'mod-enter',label:'Ctrl+Enter 发送' }]} /></div>
      <div className="settings-row"><div><h2>流式回复</h2><p>阅读助手和临时聊天边接收边显示</p></div><ChoiceSelect label="流式回复" value={preferences.streamReading ? 'on' : 'off'} onChange={value => preferences.update({ streamReading: value === 'on' })} options={[{ value: 'on', label: '开启' }, { value: 'off', label: '关闭' }]} /></div>
      {!isQuickEdition && <div className="settings-row"><div><h2>整理会话保留数量</h2><p>超出上限清理前需确认，运行中与已中断会话受保护{savedLimit !== null ? `（当前 ${savedLimit} 个）` : ''}</p></div><div className="organizer-retention-setting"><ChoiceSelect label="常用整理会话保留数量" value={['5', '10', '20', '50', '100'].includes(limit) ? limit : 'custom'} disabled={retentionBusy || savedLimit === null} onChange={value => { if (value !== 'custom') setLimit(value); else requestAnimationFrame(() => { limitInput.current?.focus(); limitInput.current?.select() }) }} options={[...['5', '10', '20', '50', '100'].map(value => ({ value, label: `${value} 个` })), { value: 'custom', label: '自定义' }]} /><input ref={limitInput} type="number" min={1} max={100} step={1} aria-label="整理会话保留数量" value={limit} disabled={retentionBusy || savedLimit === null} onChange={event => setLimit(event.target.value)} /><button disabled={retentionBusy || savedLimit === null || Number(limit) === savedLimit} onClick={() => void saveLimit()}>保存</button></div></div>}
      {retentionError && !preview && <p className="organizer-error" role="alert">{retentionError}</p>}
      </section>
    <OrganizerRetentionDialog preview={preview} busy={retentionBusy} error={retentionError} onCancel={() => { setPreview(null); setRetentionError(null); if (savedLimit !== null) setLimit(String(savedLimit)) }} onConfirm={() => void saveLimit(true)} />
  </article>
}
