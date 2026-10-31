import { useState, type PointerEvent } from 'react'
import { hexToHsv, hsvToHex, normalizeHex, type HSV } from '@/utils/accentColor'

export default function CustomAccentPalette({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(color))
  const [draft, setDraft] = useState(color)
  const update = (next: HSV) => {
    setHsv(next)
    const hex = hsvToHex(next)
    setDraft(hex); onChange(hex)
  }
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    update({ ...hsv, s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      v: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) })
  }
  const commit = () => {
    const hex = normalizeHex(draft)
    if (hex) { setHsv(hexToHsv(hex)); setDraft(hex); onChange(hex) }
    else setDraft(color)
  }
  return <div className="appearance-custom-palette" role="group" aria-label="自定义色板">
    <div className="appearance-color-plane" role="button" tabIndex={0} aria-label="选择饱和度与亮度"
      title="左右调整饱和度，上下调整亮度" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pick(event) }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event) }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        update({ ...hsv, s: Math.max(0, Math.min(1, hsv.s + (event.key === 'ArrowLeft' ? -.02 : event.key === 'ArrowRight' ? .02 : 0))),
          v: Math.max(0, Math.min(1, hsv.v + (event.key === 'ArrowDown' ? -.02 : event.key === 'ArrowUp' ? .02 : 0))) })
      }}>
      <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
    </div>
    <input className="appearance-hue" type="range" aria-label="色相" min="0" max="359" value={Math.round(hsv.h)} onChange={event => update({ ...hsv, h: Number(event.target.value) })} />
    <label className="appearance-color-value"><i style={{ background: color }} aria-hidden="true" /><span>HEX</span><input aria-label="自定义颜色色号" value={draft} maxLength={7} spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit() }} /></label>
  </div>
}
