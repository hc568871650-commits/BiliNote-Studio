import AccentSettings from '@/components/AccentSettings'
import { Moon, Sun, MonitorDown } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'

export default function ThemeToggle({ inline = false }: { inline?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])
  if (!mounted) return null

  const isDark = resolvedTheme === 'dark'
  const nextLabel = isDark ? '切换为浅色模式' : '切换为深色模式'
  const isTauri = '__TAURI_INTERNALS__' in window

  const hideToTray = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('hide_to_tray')
    } catch {
      toast.error('无法转入后台运行')
    }
  }

  return (
    <div className={inline ? 'flex items-center gap-1 text-muted-foreground' : 'global-theme-toggle fixed right-4 bottom-14 z-50 flex items-center gap-1 rounded-full border border-border bg-card p-1 text-card-foreground shadow-lg'}>
      {!inline && <AccentSettings />}
      {isTauri && (
        <button
          type="button"
          onClick={hideToTray}
          className="flex h-8 items-center gap-1 rounded-full px-2 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="隐藏窗口并在后台运行"
        >
          <MonitorDown className="h-4 w-4" />
          后台运行
        </button>
      )}
      <button
        type="button"
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={nextLabel}
        title={nextLabel}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </div>
  )
}
