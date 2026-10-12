import type { GenerationOptions, GenerationPrice } from '@/services/generationRuns'
import { normalizeGenerationOptions } from '@/utils/generationOptions'
import './generation-details.css'

export default function GenerationOptionsFields({ value, onChange, disabled = false, sourceLocked = false }: {
  value: GenerationOptions; onChange: (value: GenerationOptions) => void; disabled?: boolean; sourceLocked?: boolean
}) {
  const update = (patch: Partial<GenerationOptions>) => onChange({ ...value, ...patch })
  const numberField = (key: 'temperature' | 'max_output_tokens' | 'chunk_seconds' | 'chunk_text_chars' | 'max_requests' | 'retry_attempts', label: string, min: number, max: number, nullable = false, step = 1) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={value[key] ?? ''} placeholder={nullable ? '自动' : undefined} disabled={disabled || (sourceLocked && ['chunk_seconds', 'chunk_text_chars'].includes(key))} onChange={event => onChange({ ...value, [key]: event.target.value === '' && nullable ? null : Number(event.target.value) })} onBlur={() => update({ [key]: normalizeGenerationOptions(value)[key] })} /></label>
  const price = value.price
  const updatePrice = (patch: Partial<GenerationPrice>) => update({ price: { ...price!, ...patch } })
  return <div className="generation-settings-fields">
    <div className="generation-settings-grid">
      <label>思考等级<select aria-label="生成思考等级" disabled={disabled} value={value.reasoning_effort} onChange={event => update({ reasoning_effort: event.target.value as GenerationOptions['reasoning_effort'] })}>{[['auto', '自动'], ['none', '关闭'], ['low', '低'], ['medium', '中'], ['high', '高'], ['max', '最高']].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {numberField('temperature', '温度', 0, 2, true, 0.1)}
      {numberField('max_output_tokens', '每次最大输出 Token', 256, 65536, true)}
      {numberField('chunk_seconds', '分段时长（秒）', 60, 1800)}
      {numberField('chunk_text_chars', '分段文本上限（字）', 1000, 24000)}
      {numberField('max_requests', 'HTTP 尝试总上限（含重试）', 1, 200)}
      {numberField('retry_attempts', '每请求最多尝试次数', 1, 3)}
    </div>
    <p className="generation-details-muted">自动值交给服务端判断。不支持指定思考等级时会报错；模型明确拒绝温度时才尝试省略温度，并记录这次兼容请求。{sourceLocked && '分段参数沿用所选来源，两组保持一致。'}</p>
    <details><summary>费用估算价格</summary><label className="generation-price-toggle"><input type="checkbox" checked={Boolean(price)} disabled={disabled} onChange={event => update({ price: event.target.checked ? { mode: 'tokens', currency: 'USD' } as GenerationPrice : undefined })} />填写服务商价格（仅用于估算）</label>
      {price && <div className="generation-settings-grid"><label>计费方式<select value={price.mode} disabled={disabled} onChange={event => updatePrice({ mode: event.target.value as GenerationPrice['mode'] })}><option value="tokens">按 Token</option><option value="per_call">按次</option></select></label><label>币种<select value={price.currency} disabled={disabled} onChange={event => updatePrice({ currency: event.target.value as GenerationPrice['currency'] })}><option value="USD">USD</option><option value="CNY">CNY</option></select></label>
        {(price.mode === 'per_call' ? [['per_call', '每次价格']] : [['input_per_million', '输入 / 百万 Token'], ['output_per_million', '输出 / 百万 Token'], ['cached_input_per_million', '缓存输入 / 百万 Token']]).map(([key, label]) => <label key={key}>{label}<input type="number" min={0} step="any" disabled={disabled} value={price[key as keyof GenerationPrice] ?? ''} placeholder="未知" onChange={event => updatePrice({ [key]: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>)}
      </div>}
      {price && <p className="generation-details-muted">留空表示未知，填写 0 表示免费。价格未填完整时不记录价格，也不计算为零费用。</p>}
    </details>
  </div>
}
