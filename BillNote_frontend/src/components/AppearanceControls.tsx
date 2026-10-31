import { useTheme } from 'next-themes'
import { Check, Palette } from 'lucide-react'
import { useId, useState } from 'react'
import { accentColors, useAccentStore } from '@/store/accentStore'
import CustomAccentPalette from './CustomAccentPalette'
import { accentForeground } from '@/utils/accentColor'
import './appearance-controls.css'

export function ThemeModePicker() {
  const { theme, setTheme } = useTheme()
  return <div className="appearance-modes" role="group" aria-label="显示模式">
    {([{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }] as const).map(mode => <button type="button" key={mode.id} aria-label={mode.label} aria-pressed={theme === mode.id} onClick={() => setTheme(mode.id)}>
      <span className={`appearance-mini appearance-mini--${mode.id}`} aria-hidden="true"><i /><span><b /><b /><b /><em /></span></span>{mode.label}
    </button>)}
  </div>
}

export function AccentColorPicker() {
  const { accent, customColor, setAccent, setCustomColor } = useAccentStore()
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const { resolvedTheme } = useTheme()
  return <div className="appearance-accent-picker"><div className="appearance-colors" role="group" aria-label="强调色">
    {accentColors.map(color => <button type="button" key={color.id} title={color.name} aria-label={color.name} aria-pressed={accent === color.id} onClick={() => { setAccent(color.id); setExpanded(false) }}>
      <i style={{ background: resolvedTheme === 'dark' ? color.dark : color.light }}>{accent === color.id && <Check size={14} />}</i><span>{color.name}</span>
    </button>)}
    <button type="button" aria-label="自定义强调色" aria-pressed={accent === 'custom'} aria-expanded={expanded} aria-controls={panelId} onClick={() => { if (!expanded) setCustomColor(customColor); setExpanded(!expanded) }}>
      <i className="appearance-custom-swatch" style={accent === 'custom' ? { background: customColor, color: accentForeground(customColor) } : undefined}><Palette size={14} /></i><span>自定义</span>
    </button>
  </div><div id={panelId}>{expanded && <CustomAccentPalette color={customColor} onChange={setCustomColor} />}</div></div>
}
