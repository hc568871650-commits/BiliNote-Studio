import { Minimize2 } from 'lucide-react'
import './slash-command.css'

export default function SlashCommandMenu({ open, id, onSelect }: { open: boolean; id: string; onSelect: () => void }) {
  if (!open) return null
  return <div className="slash-command-menu" role="listbox" aria-label="输入指令" id={id}>
    <button id={`${id}-compact`} type="button" role="option" aria-selected="true" onMouseDown={event => event.preventDefault()} onClick={onSelect}>
      <Minimize2 size={15} aria-hidden="true" /><span><strong>/compact</strong><small>压缩上下文，保留聊天记录</small></span><kbd>Enter</kbd>
    </button>
  </div>
}
