import type { ReactNode } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { settingsForModel, estimateTextContext, type AISettings, type ContextUsage } from '@/utils/aiSettings'
import './ai-controls.css'
export type { AISettings, ContextUsage }
const tokens = (value: number) => value < 1000 ? String(value) : `${(value / 1000).toFixed(value < 100000 ? 1 : 0).replace(/\.0$/, '')}K`
export default function AIControls({ modelName, modelPicker, value, context, draft = '', estimate = 0 }: {
  modelName?: string; modelPicker?: ReactNode; value: AISettings; context?: ContextUsage; draft?: string; estimate?: number
}) {
  const selected = settingsForModel(value, modelName)
  const count = Math.max(0, (context?.input_tokens ?? estimate) + estimateTextContext(draft))
  const percent = Math.min(100, Math.ceil(count / selected.context_limit * 100))
  const estimated = !context || context.estimated || Boolean(draft)
  return <div className="ai-controls">
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="ai-context-control" aria-label={`上下文窗口：已用 ${percent}%，剩余 ${100 - percent}%，${count.toLocaleString()} tokens，共 272K`}>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <circle cx="12" cy="12" r="9" className="ai-context-track" />
            <circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} strokeDashoffset="25" className={percent >= 90 ? 'ai-context-fill is-full' : 'ai-context-fill'} />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" sideOffset={8} className="ai-context-tooltip">
        <span>上下文窗口：</span>
        <p>{percent}% 已用（剩余 {100 - percent}%）</p>
        <p>已用{estimated ? '约 ' : ' '}{tokens(count)}，共 272K</p>
      </TooltipContent>
    </Tooltip>
    {modelPicker}
  </div>
}
