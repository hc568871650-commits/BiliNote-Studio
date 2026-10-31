import { Server } from 'lucide-react'
import type { Health } from './BackendHealthIndicator'

export default function BackendStatusButton({ health, label, onClick }: {
  health: Health
  label: string
  onClick: () => void
}) {
  const visibleLabel = health === 'green' ? '连接正常' : health === 'yellow' ? label.includes('依赖待检查') ? '依赖待检查' : '连接异常' : health === 'red' ? '不可用' : label.includes('重启') ? '重启中' : '检查中'
  return <button
    type="button"
    className="backend-status-trigger"
    title={`后端状态：${label}`}
    aria-label={`打开后端管理，后端状态：${label}`}
    onClick={onClick}
  >
    <span className={`backend-dot backend-dot-${health}`} />
    <Server size={14} />
    <span className="backend-status-name">后端</span>
    {visibleLabel && <span className="backend-status-label">{visibleLabel}</span>}
  </button>
}
