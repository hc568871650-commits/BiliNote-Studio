import { useState } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { Palette } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAccentStore } from '@/store/accentStore'
import { ThemeModePicker, AccentColorPicker } from '@/components/AppearanceControls'

export default function AccentSettings({ rail = false }: { rail?: boolean }) {
  const inRouter = useInRouterContext()
  const [open, setOpen] = useState(false)
  const setAccent = useAccentStore(state => state.setAccent)
  return <>
    <button type="button" className={rail ? 'workspace-icon' : 'flex h-8 w-8 items-center justify-center rounded-full hover:bg-accent'} title="个性化 · 外观" aria-label="个性化 · 外观" onClick={() => setOpen(true)}><Palette size={18} /></button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="appearance-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>个性化</DialogTitle><DialogDescription>选择显示模式与强调色，打造你习惯的阅读界面。</DialogDescription></DialogHeader>
        <fieldset><legend>显示模式</legend><ThemeModePicker /></fieldset>
        <fieldset><legend>强调色</legend><AccentColorPicker /></fieldset>
        <div className="appearance-dialog-footer">{inRouter && <Link to="/settings/appearance" onClick={() => setOpen(false)}>字体、字号与更多外观设置 →</Link>}<button type="button" onClick={() => setAccent('slate')}>重置强调色</button></div>
      </DialogContent>
    </Dialog>
  </>
}
