import { useInterfaceStore } from '@/store/interfaceStore'
import '@/components/interface.css'
import { useEffect } from 'react'
import { useAccentStore } from '@/store/accentStore'
import '@/accent.css'
import type { ReactNode, FC } from 'react'
// import "@/global.css"
import { Toaster } from 'react-hot-toast'
import { ThemeProvider } from 'next-themes'
import ThemeToggle from '@/components/ThemeToggle'

interface RootLayoutProps {
  children: ReactNode
}

export const metadata = {
  title: 'BiliNote Studio - 视频学习工作台',
  description: '通过视频链接结合大模型自动生成对应的笔记',
}

const RootLayout: FC<RootLayoutProps> = ({ children }) => {
  const preferences = useInterfaceStore()
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--ui-font-size', `${preferences.fontSize}px`)
    root.style.setProperty('--code-font-size', `${preferences.codeSize}px`)
    root.style.setProperty('--ui-font', preferences.font === 'yahei' ? '"Microsoft YaHei",sans-serif' : preferences.font === 'segoe' ? '"Segoe UI",sans-serif' : 'system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif')
    root.dataset.reducedMotion = String(preferences.reducedMotion)
  }, [preferences.fontSize, preferences.codeSize, preferences.font, preferences.reducedMotion])
  const accent = useAccentStore(state => state.accent)
  useEffect(() => { document.documentElement.dataset.accent = accent }, [accent])
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
        {children}
        <ThemeToggle />
      </div>
    </ThemeProvider>
  )
}

export default RootLayout
