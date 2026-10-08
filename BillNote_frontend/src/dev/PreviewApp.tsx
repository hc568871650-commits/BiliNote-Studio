import BackendInitDialog from '@/components/BackendInitDialog'
import Onboarding from '@/pages/Onboarding'
import General from '@/pages/SettingPage/General'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useState } from 'react'
import Index from '@/pages/Index'
import SettingPage from '@/pages/SettingPage'
import Model from '@/pages/SettingPage/Model'
import ProviderForm from '@/components/Form/modelForm/Form'
import Purposes from '@/pages/SettingPage/Purposes'
import Appearance from '@/pages/SettingPage/Appearance'
import About from '@/pages/SettingPage/about'
import Downloader from '@/pages/SettingPage/Downloader'
import DownloaderForm from '@/components/Form/DownloaderForm/Form'
import Transcriber from '@/pages/SettingPage/transcriber'
import Monitor from '@/pages/SettingPage/Monitor'
import SettingsLanding from '@/pages/SettingPage/SettingsLanding'
import Organizer from '@/pages/OrganizerPage'
import StandaloneWorkspace from '@/layouts/StandaloneWorkspace'
import './preview.css'
import { useTaskPolling } from '@/hooks/useTaskPolling'
import { graphPreview } from './graphPreviewAdapter'
import BackendLogPanel from '@/components/BackendHealth/BackendLogPanel'
import BackendStatusButton from '@/components/BackendHealth/BackendStatusButton'
import '@/components/BackendHealth/backend-health.css'
import { setPreviewChatScenario, type PreviewChatScenario } from './previewMock'

// Onboarding uses fetch in production; this fixture never contacts a real backend.
const previewBackendReady = async () => true

export default function PreviewApp() {
  useTaskPolling(1000)
  const [startupView, setStartupView] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [showBackend, setShowBackend] = useState(false)
  const [chatScenario, setChatScenario] = useState<PreviewChatScenario>('normal')
  return <div className="preview-app"><div className="preview-banner"><span><i />BiliNote Studio · {graphPreview ? '流程验证' : '交互预览'}</span><span>{graphPreview ? '真实 LangGraph 流程 · 示例模型 · 独立测试数据' : '示例笔记 · 模型回答为模拟 · 不连接正式数据'}</span>{!graphPreview && <><select aria-label="预览启动界面" value={startupView} onChange={event => setStartupView(event.target.value)}><option value="">工作台</option><option value="waiting">启动等待</option><option value="failed">启动失败</option></select><a href="/ui-preview.html#/onboarding">首次配置</a><a href="/ui-preview.html#/settings/model">服务商</a><a href="/ui-preview.html#/settings/transcriber">转写</a><a href="/ui-preview.html#/?view=read">阅读</a><select aria-label="模拟聊天场景" value={chatScenario} onChange={event => { const value = event.target.value as PreviewChatScenario; setChatScenario(value); setPreviewChatScenario(value) }}><option value="normal">正常回复 · 3秒</option><option value="slow">慢回复 · 35秒</option><option value="upstream-error">上游502 · 模拟</option><option value="timeout">等待超时 · 模拟</option></select></>}{graphPreview ? <a className="ml-auto underline" href="/ui-preview.html#/organizer">交互模拟</a> : <button onClick={() => setConfirmReset(true)}>重置示例</button>}</div>
    {confirmReset && <div className="preview-confirm-backdrop"><section role="dialog" aria-modal="true" aria-label="重置预览" className="preview-confirm"><h2>重新开始试用？</h2><p>重置示例笔记、模型设置和预览对话，仅影响此预览。</p><div><button onClick={() => setConfirmReset(false)}>取消</button><button onClick={() => { setConfirmReset(false); window.dispatchEvent(new Event('bilinote-preview-reset')) }}>确认重置</button></div></section></div>}
    {showBackend && <BackendLogPanel status="running" exitCode={null} health="green" restarting={false} checking={false} checkedAt={Date.now()} detail="界面示例：连接正常。未探测真实后端。" logs={[{level:'info', text:'[示例] 服务已就绪；不连接正式安装。', ts:Date.now()}, {level:'error', text:'[示例] 转写模型尚未下载，请在音频转写设置中配置。', ts:Date.now()}]} onCheck={async()=>{}} onRestart={async()=>{throw new Error('隔离预览不执行重启')}} onCopyLogs={async()=>{try { await navigator.clipboard.writeText('[示例] 未连接正式后端'); return true } catch {return false}}} onClose={()=>setShowBackend(false)} />}
    <BackendStatusButton health="green" label="连接正常（预览示例，未探测真实后端）" onClick={() => setShowBackend(true)} />
    {startupView ? <BackendInitDialog open failed={startupView === 'failed'} lastError="示例：服务在预计时间内未就绪。此页面未启动或连接真实后端。" onRetry={() => setStartupView('waiting')} /> : <HashRouter><Routes><Route path="/onboarding" element={<Onboarding checkBackend={previewBackendReady} />} /><Route path="/" element={<Index />}><Route index element={null} />
      <Route path="organizer" element={<StandaloneWorkspace><Organizer /></StandaloneWorkspace>} />
      <Route path="settings" element={<SettingPage />}>
        <Route index element={<SettingsLanding />} />
        <Route path="general" element={<General />} />
                <Route path="purposes" element={<Purposes />} /><Route path="appearance" element={<Appearance />} />
        <Route path="model" element={<Model />}><Route path="new" element={<ProviderForm isCreate />} /><Route path=":id" element={<ProviderForm />} /></Route>
        <Route path="download" element={<Downloader />}><Route path=":id" element={<DownloaderForm />} /></Route>
        <Route path="transcriber" element={<Transcriber />} /><Route path="monitor" element={<Monitor />} /><Route path="about" element={<About />} />
      </Route><Route path="*" element={<Navigate to="/" replace />} />
    </Route></Routes></HashRouter>}
  </div>
}
