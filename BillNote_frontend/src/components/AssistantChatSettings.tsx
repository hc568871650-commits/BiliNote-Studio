import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Link } from 'react-router-dom'
import WebSearchControl from '@/components/WebSearchControl'
import ModelContextSettings from '@/components/ModelContextSettings'
import type { AISettings } from '@/utils/aiSettings'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import './assistant-chat-settings.css'

export default function AssistantChatSettings({ open, onOpenChange, providerId, modelName, protocol, value, onChange, disabled }: {
  open: boolean; onOpenChange: (open: boolean) => void; providerId?: string; modelName?: string
  protocol: ProviderProtocol; value: AISettings; onChange: (value: AISettings) => void; disabled?: boolean
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="assistant-chat-settings">
      <DialogHeader><DialogTitle>聊天设置</DialogTitle><DialogDescription>联网方式和上下文按模型保存，跨笔记共用。</DialogDescription></DialogHeader>
      <div className="assistant-chat-settings-row"><span>联网方式</span><WebSearchControl value={value} onChange={onChange} providerId={providerId} modelName={modelName} protocol={protocol} disabled={disabled} /></div>
      <ModelContextSettings providerId={providerId} modelName={modelName} disabled={disabled} />
      <Link to="/settings/purposes" onClick={() => onOpenChange(false)}>默认模型与检索服务设置 →</Link>
    </DialogContent>
  </Dialog>
}
