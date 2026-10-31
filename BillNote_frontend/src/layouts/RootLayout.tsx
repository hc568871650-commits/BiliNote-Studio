import { useInterfaceStore } from '@/store/interfaceStore'
import '@/components/interface.css'
import { useEffect } from 'react'
import { useAccentStore } from '@/store/accentStore'
import { accentVariants } from '@/utils/accentColor'
import '@/accent.css'
import type { ReactNode, FC } from 'react'
// import "@/global.css"
import { Toaster } from 'react-hot-toast'
import { ThemeProvider } from 'next-themes'
import DesktopChrome from '@/components/DesktopChrome'

interface RootLayoutProps {
  children: ReactNode
  previewWindow?: boolean
}

export const metadata = {
  title: 'BiliNote Studio - 视频学习工作台',
  description: '通过视频链接结合大模型自动生成对应的笔记',
}

const RootLayout: FC<RootLayoutProps> = ({ children, previewWindow = false }) => {
  const preferences = useInterfaceStore()
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--ui-font-size', `${preferences.fontSize}px`)
    root.style.setProperty('--code-font-size', `${preferences.codeSize}px`)
    root.style.setProperty('--ui-font', preferences.font === 'yahei' ? '"Microsoft YaHei",sans-serif' : preferences.font === 'segoe' ? '"Segoe UI",sans-serif' : 'system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif')
    root.dataset.reducedMotion = String(preferences.reducedMotion)
  }, [preferences.fontSize, preferences.codeSize, preferences.font, preferences.reducedMotion])
  const accent = useAccentStore(state => state.accent)
  const customColor = useAccentStore(state => state.customColor)
  useEffect(() => {
    const root = document.documentElement
    root.dataset.accent = accent
    const colors = accentVariants(customColor)
    root.style.setProperty('--custom-accent-light', colors.light)
    root.style.setProperty('--custom-accent-dark', colors.dark)
  }, [accent, customColor])
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="bilinote-theme">
      <div className="min-h-screen bg-background font-sans text-foreground">
        <Toaster
          position="top-center" // 顶部居中显示
          toastOptions={{
            style: {
              borderRadius: '8px',
              background: 'var(--card)',
              color: 'var(--card-foreground)',
              border: '1px solid var(--border)',
            },
          }}
        />
        <DesktopChrome preview={previewWindow}>{children}</DesktopChrome>
      </div>
    </ThemeProvider>
  )
}

export default RootLayout
