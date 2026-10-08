import './App.css'
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, HashRouter, Navigate, Routes, Route, Link } from 'react-router-dom'
import { useTaskPolling } from '@/hooks/useTaskPolling.ts'
import { useCheckBackend } from '@/hooks/useCheckBackend.ts'
import { systemCheck } from '@/services/system.ts'
import BackendInitDialog from '@/components/BackendInitDialog'
import StartupBanner from '@/components/SystemDiagnostic/StartupBanner'
import BackendHealthIndicator from '@/components/BackendHealth/BackendHealthIndicator'
import Index from '@/pages/Index.tsx'
import StandaloneWorkspace from '@/layouts/StandaloneWorkspace'
import { isQuickEdition } from '@/utils/edition'
import QuickSetupNotice from '@/components/QuickSetupNotice'

// 非首屏页面使用 React.lazy 按需加载
const Onboarding = lazy(() => import('@/pages/Onboarding'))
const SettingPage = lazy(() => import('./pages/SettingPage/index.tsx'))
const General = lazy(() => import('@/pages/SettingPage/General'))

// 桌面端首启引导守卫：未完成 onboarding 时强制跳到 /onboarding
function OnboardingGuard({ children }: { children: React.ReactNode }) {
  if (isQuickEdition) return <>{children}<QuickSetupNotice /></>
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  // 仅在 Tauri 桌面端拦截；纯 web 端不打扰用户
  if (!isTauri) return <>{children}</>
  if (localStorage.getItem('bilinote-onboarded') !== '1') return <Navigate to="/onboarding" replace />
  return <>{children}</>
}
const Model = lazy(() => import('@/pages/SettingPage/Model.tsx'))
const ProviderForm = lazy(() => import('@/components/Form/modelForm/Form.tsx'))
const AboutPage = lazy(() => import('@/pages/SettingPage/about.tsx'))
const Monitor = lazy(() => import('@/pages/SettingPage/Monitor.tsx'))
const Downloader = lazy(() => import('@/pages/SettingPage/Downloader.tsx'))
const DownloaderForm = lazy(() => import('@/components/Form/DownloaderForm/Form.tsx'))
const TranscriberPage = lazy(() => import('@/pages/SettingPage/transcriber.tsx'))
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'))
const PurposeModels = lazy(() => import('@/pages/SettingPage/Purposes'))
const Appearance = lazy(() => import('@/pages/SettingPage/Appearance'))
const OrganizerPage = lazy(() => import('@/pages/OrganizerPage'))
const SettingsLanding = lazy(() => import('@/pages/SettingPage/SettingsLanding'))

function App() {
  useTaskPolling(3000) // 每 3 秒轮询一次
  const { loading, initialized, failed, lastError, retry } = useCheckBackend()

  // 在后端初始化完成后执行系统检查
  useEffect(() => {
    if (initialized) {
      systemCheck()
    }
  }, [initialized])

  // 如果后端还未初始化，显示初始化对话框（loading 或 failed 都展示，由 dialog 内部决定渲染哪一态）
  if (!initialized) {
    return (
      <>
        <StartupBanner />
        <BackendInitDialog
          open={loading}
          failed={failed}
          lastError={lastError}
          onRetry={retry}
        />
      </>
    )
  }

  // 桌面端使用 HashRouter 避免刷新 404；Web 端继续使用 BrowserRouter
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const Router = isTauri ? HashRouter : BrowserRouter

  // 后端已初始化，渲染主应用
  return (
    <>
      <StartupBanner />
      <BackendHealthIndicator />
      <Router>
        <Suspense fallback={<main className="startup-screen"><div className="startup-card"><h1 className="startup-title">正在打开工作台</h1></div></main>}>
          <Routes>
            <Route path="/onboarding" element={isQuickEdition ? <Navigate to="/" replace /> : <Onboarding />} />
            <Route path="/" element={<OnboardingGuard><Index /></OnboardingGuard>}>
              <Route index element={null} />
              <Route path="organizer" element={isQuickEdition ? <StandaloneWorkspace><section className="settings-page"><h1>整理助手在完整版中可用</h1><p className="settings-footnote">快捷版保留笔记生成、阅读、导图与问答。</p><Link className="settings-link" to="/">返回笔记库</Link></section></StandaloneWorkspace> : <StandaloneWorkspace><OrganizerPage /></StandaloneWorkspace>} />
              <Route path="settings" element={<SettingPage />}>
                <Route index element={<SettingsLanding />} />
                <Route path="general" element={<General />} />
                <Route path="purposes" element={<PurposeModels />} />
                <Route path="appearance" element={<Appearance />} />
                <Route path="model" element={<Model />}>
                  <Route path="new" element={<ProviderForm isCreate />} />
                  <Route path=":id" element={<ProviderForm />} />
                </Route>
                <Route path="download" element={<Downloader />}>
                  <Route path=":id" element={<DownloaderForm />} />
                </Route>
                <Route path="transcriber" element={<TranscriberPage />} />
                <Route path="monitor" element={<Monitor />}></Route>
                <Route path="about" element={<AboutPage />}></Route>
                <Route path="*" element={<NotFoundPage />} />
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </Suspense>
      </Router>
    </>
  )
}

export default App
