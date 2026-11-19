import type { ReactNode } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { settingsForModel, estimateTextContext, type AISettings, type ContextUsage } from '@/utils/aiSettings'
import type { ModelContextBudget } from '@/services/modelContext'
import './ai-controls.css'
export type { AISettings, ContextUsage }
const tokens = (value: number) => value < 1000 ? String(value) : `${(value / 1000).toFixed(value < 100000 ? 1 : 0).replace(/\.0$/, '')}K`
export default function AIControls({ modelName, modelPicker, value, context, contextBudget, draft = '', estimate = 0 }: {
  modelName?: string; modelPicker?: ReactNode; value: AISettings; context?: ContextUsage; contextBudget?: ModelContextBudget; draft?: string; estimate?: number
}) {
  const selected = settingsForModel(value, modelName)
  const count = Math.max(0, (context?.input_tokens ?? estimate) + estimateTextContext(draft))
  const limit = contextBudget?.input_limit || context?.limit || selected.context_limit
  const percent = Math.min(100, Math.ceil(count / limit * 100))
  const estimated = !context || context.estimated || Boolean(draft)
  return <div className="ai-controls">
    {percent >= 50 && <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={percent >= 85 ? 'ai-context-pill is-warn' : 'ai-context-pill'} aria-label={`上下文输入预算：已用 ${percent}%，剩余 ${100 - percent}%，${count.toLocaleString()} tokens，共 ${tokens(limit)}`}>
          {percent}%
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" sideOffset={8} className="ai-context-tooltip">
        <span>上下文预算</span>
        <p>{percent}% 已用（剩余 {100 - percent}%）</p>
        <p>已用{estimated ? '约 ' : ' '}{tokens(count)} / {tokens(limit)}</p>
      </TooltipContent>
    </Tooltip>}
    {modelPicker}
  </div>
}
