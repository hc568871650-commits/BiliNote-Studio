import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { initializeDesktopWindow, minimizeDesktopWindow, toggleMaximizeDesktopWindow, closeDesktopWindow } from '@/utils/desktopWindow'
import './desktop-chrome.css'
import studioMark from '@/assets/studio-mark.svg?raw'
// Compile-time local SVG only; no user-provided markup. Inline rendering avoids
// WebView mask URL restrictions while retaining a crisp monochrome silhouette.
const studioMarkMarkup = studioMark.replaceAll('#fff', 'currentColor')

export default function DesktopChrome({ children, preview = false }: { children: ReactNode; preview?: boolean }) {
  const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [enabled, setEnabled] = useState(preview)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    let dispose: (() => void) | undefined
    void initializeDesktopWindow(value => { if (!cancelled) setMaximized(value) }).then(cleanup => {
      if (cancelled) cleanup()
      else { dispose = cleanup; setEnabled(true) }
    }).catch(error => { console.error('自定义标题栏初始化失败，保留系统标题栏', error) })
    return () => { cancelled = true; dispose?.() }
  }, [desktop, preview])
  const control = (action: () => Promise<void>, simulated?: () => void) => {
    if (preview && !desktop) { simulated?.(); return }
    void action().catch(() => toast.error('窗口操作未完成，请重试'))
  }
  return <div className={`studio-chrome${enabled ? ' studio-chrome--enabled' : ''}${preview ? ' studio-chrome--preview' : ''}`}>
    {enabled && <header className="studio-titlebar" aria-label="窗口标题栏">
      <div className="studio-titlebar-drag" data-tauri-drag-region={desktop ? '' : undefined}
        onDoubleClick={desktop ? undefined : () => setMaximized(value => !value)}><span className="studio-titlebar-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: studioMarkMarkup }} /><span className="studio-titlebar-name">BiliNote Studio</span></div>
      <div className="studio-window-controls" role="group" aria-label="窗口控制">
        <button type="button" aria-label="最小化" title="最小化" onClick={() => control(minimizeDesktopWindow, () => toast('预览不最小化浏览器；正式桌面会最小化窗口'))}><Minus size={16} strokeWidth={1.4} /></button>
        <button type="button" aria-label={maximized ? '还原窗口' : '最大化'} title={maximized ? '还原窗口' : '最大化'} onClick={() => control(toggleMaximizeDesktopWindow, () => setMaximized(value => !value))}>{maximized ? <Copy size={13} strokeWidth={1.4} /> : <Square size={13} strokeWidth={1.4} />}</button>
        <button type="button" className="studio-window-close" aria-label="关闭窗口" title="关闭窗口（保留原托盘行为）" onClick={() => control(closeDesktopWindow, () => toast('预览不关闭页面；正式桌面沿用原托盘行为'))}><X size={17} strokeWidth={1.4} /></button>
      </div>
    </header>}
    {children}
  </div>
}
