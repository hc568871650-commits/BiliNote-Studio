import { useState } from 'react'
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
  return <aside className="fixed bottom-5 right-5 z-40 max-w-sm rounded-2xl border border-[var(--surface-border)] bg-[var(--glass-bg-strong)] p-4 shadow-[var(--glass-shadow)] backdrop-blur-md" aria-label="快捷版初次配置">
    <h2 className="mb-2 text-sm font-medium">欢迎使用 BiliNote Studio 快捷版</h2>
    <p className="text-sm text-muted-foreground">可直接阅读已有笔记。点击左下角「设置」即可配置模型 API 与在线音频转写。</p>
    <div className="mt-3 flex justify-end text-sm">
      <button type="button" className="settings-button" onClick={dismiss}>知道了</button>
    </div>
  </aside>
}
