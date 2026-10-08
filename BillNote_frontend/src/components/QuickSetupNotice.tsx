import { useState } from 'react'
import { Link } from 'react-router-dom'
import { isQuickEdition } from '@/utils/edition'

const storageKey = 'bilinote-quick-setup-seen-v1'
let dismissedInSession = false

export default function QuickSetupNotice() {
  const [visible, setVisible] = useState(() => {
    if (!isQuickEdition || dismissedInSession) return false
    try { return localStorage.getItem(storageKey) !== '1' }
    catch { return true }
  })
  const dismiss = () => {
    dismissedInSession = true
    setVisible(false)
    try { localStorage.setItem(storageKey, '1') } catch { /* Keep the dismissal for this session. */ }
  }
  if (!visible) return null
  return <aside className="fixed bottom-5 right-5 z-40 max-w-sm rounded-xl border bg-background p-4 shadow-lg" aria-label="快捷版初次配置">
    <h2 className="mb-2 text-sm font-medium">欢迎使用 BiliNote Studio 快捷版</h2>
    <p className="text-sm text-muted-foreground">可直接阅读已有笔记。AI 生成和问答需要配置你自己的模型 API；音频转写使用在线服务，需要联网，费用与额度取决于服务商。</p>
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <Link className="underline" to="/settings/model" onClick={dismiss}>配置模型 API</Link>
      <Link className="underline" to="/settings/transcriber" onClick={dismiss}>配置转写</Link>
      <button type="button" onClick={dismiss}>稍后</button>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">以后可随时在设置中配置。</p>
  </aside>
}
