import { BackendEngineIcon } from '@/components/AnimatedRailIcons'
import { cn } from '@/lib/utils'
import type { Health } from './BackendHealthIndicator'
import { useBackendStatusStore } from './backendStatusStore'

export function BackendRailStatusButton({ className }: { className?: string }) {
  const active = useBackendStatusStore(state => state.active)
  const health = useBackendStatusStore(state => state.health)
  const label = useBackendStatusStore(state => state.label)
  const openPanel = useBackendStatusStore(state => state.openPanel)
  if (!active || !openPanel) return null
  return <button
    type="button"
    className={cn(className || 'workspace-icon', 'backend-rail-trigger')}
    title={`后端状态：${label}`}
    aria-label={`打开后端管理，后端状态：${label}`}
    onClick={openPanel}
  >
    <BackendEngineIcon health={health} size={17} />
  </button>
}

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
    <BackendEngineIcon health={health} size={14} showDot={false} />
    <span className="backend-status-name">后端</span>
    {visibleLabel && <span className="backend-status-label">{visibleLabel}</span>}
  </button>
}
