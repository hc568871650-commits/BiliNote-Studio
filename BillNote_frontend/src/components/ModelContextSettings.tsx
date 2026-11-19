import { useEffect, useRef, useState } from 'react'
import useModelContext from '@/hooks/useModelContext'
import { saveModelContext, type ModelContextBudget } from '@/services/modelContext'
import ChoiceSelect from '@/components/ChoiceSelect'
import './model-context-settings.css'

const tokens = (value: number) => `${(value / 1000).toFixed(value < 100000 ? 1 : 0).replace(/\.0$/, '')}K`
const presets = [
  { id: '64k', label: '64K · 日常', window: 65536, reserve: 4096 },
  { id: '128k', label: '128K · 长篇', window: 131072, reserve: 8192 },
  { id: '256k', label: '256K · 超长', window: 262144, reserve: 8192 },
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
  const save = async (presetId: string) => {
    const preset = presets.find(item => item.id === presetId)
    if (!preset || !providerId || !modelName || disabled || loading || busy || error) return
    const current = generation.current
    setBusy(true); setMessage('')
    try { await saveModelContext(providerId, modelName, { model_window: preset.window, user_limit: preset.window, output_reserve: preset.reserve }) }
    catch (failure) {
      if (current === generation.current) { const value = failure as { msg?: string; message?: string }; setMessage(value.msg || value.message || '保存失败，请重试') }
    }
    finally { if (current === generation.current) setBusy(false) }
  }

  const options = [
    ...(!selected && !loading ? [{ value: 'custom', label: `自定义 · ${tokens(budget.input_limit)}` }] : []),
    ...presets.map(preset => ({ value: preset.id, label: preset.label })),
  ]

  return <div className="settings-row model-context-row">
    <div>
      <h2>上下文容量</h2>
      <p title={budget.source_label}>
        {!providerId || !modelName
          ? '请先选择默认阅读模型'
          : loading
            ? '读取中…'
            : busy
              ? '保存中…'
              : '按模型通道容量选档，自动预留输出空间。'}
      </p>
      {(message || error) && (
        <div className="model-context-error" role="alert">
          {message || error}
          {error && <button type="button" disabled={disabled || busy} onClick={reload}>重新读取</button>}
        </div>
      )}
    </div>
    <ChoiceSelect
      label="上下文容量档位"
      className="settings-fixed-control"
      value={selected ? selected.id : 'custom'}
      disabled={disabled || !providerId || !modelName || loading || busy || Boolean(error)}
      onChange={value => { if (value !== 'custom') void save(value) }}
      options={options}
    />
  </div>
}
