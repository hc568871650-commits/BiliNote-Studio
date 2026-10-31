import { useEffect, useRef, useState } from 'react'
import useModelContext from '@/hooks/useModelContext'
import { saveModelContext, type ModelContextBudget } from '@/services/modelContext'
import './model-context-settings.css'

const tokens = (value: number) => `${(value / 1000).toFixed(value < 100000 ? 1 : 0).replace(/\.0$/, '')}K`
const presets = [
  { label: '64K', description: '日常', window: 65536, reserve: 4096 },
  { label: '128K', description: '长篇', window: 131072, reserve: 8192 },
  { label: '256K', description: '超长', window: 262144, reserve: 8192 },
]
export default function ModelContextSettings({ providerId, modelName, disabled = false, onChange }: {
  providerId?: string; modelName?: string; disabled?: boolean; onChange?: (budget: ModelContextBudget) => void
}) {
  const { budget, loading, error, reload } = useModelContext(providerId, modelName)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  useEffect(() => { onChange?.(budget) }, [budget, onChange])
  useEffect(() => { generation.current++; setBusy(false); setMessage('') }, [providerId, modelName])
  const selected = presets.find(preset => budget.input_limit === preset.window - preset.reserve && budget.output_reserve === preset.reserve)
  const save = async (preset: typeof presets[number]) => {
    if (!providerId || !modelName || disabled || loading || busy || error) return
    const current = generation.current
    setBusy(true); setMessage('')
    try { await saveModelContext(providerId, modelName, { model_window: preset.window, user_limit: preset.window, output_reserve: preset.reserve }) }
    catch (failure) {
      if (current === generation.current) { const value = failure as { msg?: string; message?: string }; setMessage(value.msg || value.message || '保存失败，请重试') }
    }
    finally { if (current === generation.current) setBusy(false) }
  }
  return <section className="model-context-settings" aria-label="上下文设置">
    <div className="model-context-heading"><span>上下文</span><small>{loading ? '读取中…' : busy ? '保存中…' : selected ? '按模型保存' : '保留已有自定义设置'}</small></div>
    <div className="model-context-presets" role="radiogroup" aria-label="上下文档位" aria-busy={busy}>
      {presets.map(preset => <button key={preset.label} type="button" role="radio" aria-checked={selected === preset}
        disabled={disabled || !providerId || !modelName || loading || busy || Boolean(error)} onClick={() => { void save(preset) }}>
        <strong>{preset.label}</strong><span>{preset.description}</span>
      </button>)}
    </div>
    {!selected && !loading && <p className="model-context-current">已有配置：可用输入 {tokens(budget.input_limit)}</p>}
    <p className="model-context-help" title={budget.source_label}>按通道容量选档，自动预留输出空间。</p>
    {(message || error) && <div className="model-context-error" role="alert">{message || error}{error && <button type="button" disabled={disabled || busy} onClick={reload}>重新读取</button>}</div>}
  </section>
}
