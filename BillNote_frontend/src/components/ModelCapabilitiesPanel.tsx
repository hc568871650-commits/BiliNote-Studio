import { useEffect, useRef, useState } from 'react'
import ChoiceSelect from '@/components/ChoiceSelect'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { capabilityErrorMessage, cancelCapabilityJob, getCapabilityJob, getModelCapabilities, startCapabilityTest,
  type CapabilityFeature, type CapabilityJob, type CapabilityTestRequest, type ModelCapabilityRecord } from '@/services/modelCapabilities'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import { isTranscriptionModel } from '@/utils/modelCapabilities'
import './ModelCapabilitiesPanel.css'

interface Props { providerId: string; models: { model_name: string }[]; protocol: ProviderProtocol; disabled?: boolean }
const statusLabels = { passed: '已通过', unsupported: '明确不支持', failed: '暂时失败', inconclusive: '证据不足' }
const checkLabels: Record<string, string> = { basic: '基础回复', stream: '流式回复', tools: '工具调用', web_native: '原生联网' }
const checkLabel = (key: string) => checkLabels[key] || `思考 · ${key.replace('reasoning:', '')}`
const terminal = (job: CapabilityJob) => ['completed', 'cancelled', 'failed'].includes(job.status)

function FeatureRow({ name, feature }: { name: string; feature: CapabilityFeature }) {
  const details = feature.error_details
  return <div className="capability-result">
    <div><span>{checkLabel(name)}</span><span className={`capability-status is-${feature.status}`}>{statusLabels[feature.status]}</span></div>
    <p>{feature.evidence || '未提供额外证据'}</p>
    <small>{feature.checked_at ? new Date(feature.checked_at).toLocaleString() : ''} · {Math.round(feature.elapsed_ms)} ms</small>
    {feature.usage && <details><summary>API 用量</summary><pre>{JSON.stringify(feature.usage, null, 2)}</pre></details>}
    {details && <details><summary>错误详情（脱敏）</summary><pre>{JSON.stringify(details, null, 2)}</pre></details>}
  </div>
}

export default function ModelCapabilitiesPanel({ providerId, models, protocol, disabled = false }: Props) {
  const names = [...new Set(models.map(model => model.model_name).filter(name => !isTranscriptionModel(name)))]
  const namesKey = JSON.stringify(names)
  const [selected, setSelected] = useState(names[0] || '')
  const model = names.includes(selected) ? selected : names[0] || ''
  const { capabilities, loading, error, refresh } = useModelCapabilities(providerId, model, protocol)
  const [records, setRecords] = useState<Record<string, ModelCapabilityRecord>>({})
  const [recordsError, setRecordsError] = useState<string | null>(null)
  const [chosen, setChosen] = useState(['basic', 'reasoning'])
  const [job, setJob] = useState<CapabilityJob | null>(null)
  const [jobModel, setJobModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const queue = useRef<CapabilityTestRequest[]>([])
  const alive = useRef(true)
  const handled = useRef(new Set<string>())
  const identity = useRef(0)
  const stopRequested = useRef(false)
  const [cancelled, setCancelled] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; queue.current = [] } }, [])
  useEffect(() => {
    identity.current += 1
    queue.current = []; setJob(null); setBusy(false); setRunError(null); setRecords({})
    let active = true
    const loadRecords = async () => {
      setRecordsError(null)
      try {
        const values = await Promise.all(JSON.parse(namesKey).map((name: string) => getModelCapabilities(providerId, name, protocol))) as ModelCapabilityRecord[]
        if (active) setRecords(Object.fromEntries(values.map(record => [record.model_name, record])))
      } catch (failure) { if (active) setRecordsError(capabilityErrorMessage(failure)) }
    }
    if (providerId) void loadRecords()
    window.addEventListener('bilinote-capabilities-updated', loadRecords)
    window.addEventListener('user-save-provider', loadRecords)
    return () => { active = false; window.removeEventListener('bilinote-capabilities-updated', loadRecords); window.removeEventListener('user-save-provider', loadRecords) }
  }, [providerId, protocol, namesKey])
  const checksFor = (name: string) => chosen.flatMap(check => check === 'reasoning'
    ? (records[name]?.candidates || (name === model ? capabilities?.candidates : []) || []).filter(effort => effort !== 'auto').map(effort => `reasoning:${effort}`)
    : check === 'web_native' && protocol !== 'openai-responses' ? [] : [check])
  const submit = async (body: CapabilityTestRequest, revision: number) => {
    try {
      let accepted = await startCapabilityTest(body)
      if (stopRequested.current && alive.current && revision === identity.current) {
        try { accepted = await cancelCapabilityJob(accepted.id) }
        catch (failure) { setCancelled(false); setRunError(`取消未确认：${capabilityErrorMessage(failure)}；可再次点击取消。`) }
      }
      if (alive.current && revision === identity.current) { setJobModel(body.model_name); setJob(accepted) }
    } catch (failure) {
      if (alive.current && revision === identity.current) { queue.current = []; setBusy(false); setRunError(capabilityErrorMessage(failure)) }
    }
  }
  useEffect(() => {
    if (!job) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const revision = identity.current
    if (terminal(job)) {
      if (!handled.current.has(job.id)) {
        handled.current.add(job.id)
        window.dispatchEvent(new Event('bilinote-capabilities-updated'))
        if (job.status !== 'completed') queue.current = []
        const next = queue.current.shift()
        if (next) void submit(next, revision)
        else setBusy(false)
      }
    } else {
      timer = setTimeout(() => {
        void getCapabilityJob(job.id).then(result => {
          if (active && revision === identity.current) { setJob(result); setRunError(null) }
        }).catch(failure => {
          if (active && revision === identity.current) {
            setRunError(`${capabilityErrorMessage(failure)}；后台检测可能仍在进行，点击刷新进度继续等待。`)
          }
        })
      }, 1200)
    }
    return () => { active = false; clearTimeout(timer) }
  }, [job])
  const start = (all: boolean) => {
    if (busy || disabled) return
    const items = (all ? names : [model]).map(name => ({ provider_id: providerId, model_name: name, protocol, checks: checksFor(name) })).filter(item => item.checks.length)
    if (!items.length) return
    stopRequested.current = false
    setBusy(true); setCancelled(false); setRunError(null); setJob(null)
    queue.current = items.slice(1)
    void submit(items[0], identity.current)
  }
  const cancel = async () => {
    stopRequested.current = true
    queue.current = []; setCancelled(true)
    if (!job) return
    if (terminal(job)) { setBusy(false); return }
    try { setJob(await cancelCapabilityJob(job.id)) }
    catch (failure) { setCancelled(false); setRunError(capabilityErrorMessage(failure)) }
  }
  const toggle = (check: string) => setChosen(value => value.includes(check) ? value.filter(item => item !== check) : [...value, check])
  const features = job && jobModel === model ? { ...capabilities?.features, ...job.results } : capabilities?.features || {}
  const readyAll = names.length > 0 && names.every(name => Boolean(records[name]))
  const singleCount = checksFor(model).length
  const allCount = names.reduce((total, name) => total + checksFor(name).length, 0)
  return <section className="settings-card model-capabilities-panel">
    <div className="settings-row"><div><h2>聊天模型能力测试</h2><p>短合成问题验证基础回复、工具与思考档位。测试可能产生少量 API 用量，不使用教程正文。</p></div>
      <ChoiceSelect label="能力测试模型" value={model} options={names.map(name => ({ value: name, label: name }))} onChange={setSelected} disabled={busy || disabled || !names.length} /></div>
    {disabled && <p className="capability-notice">请先保存服务商配置，再开始检测。</p>}
    {!names.length && <p>请先添加聊天模型；转写模型不适用。</p>}
    <fieldset className="capability-checks" disabled={busy || disabled}><legend>检测项目</legend>
      {['basic', 'stream', 'tools', 'web_native', 'reasoning'].map(check => <label key={check}><input type="checkbox" checked={chosen.includes(check)} onChange={() => toggle(check)} disabled={check === 'web_native' && protocol !== 'openai-responses'} />{check === 'reasoning' ? '所有候选思考档位' : checkLabel(check)}</label>)}
    </fieldset>
    {protocol !== 'openai-responses' && <small>当前原生联网检测仅支持 Responses 协议；不会自动切换协议。</small>}
    <p className="capability-estimate">预计请求：当前模型 {singleCount} 次；全部 {names.length} 个聊天模型 {readyAll ? `${allCount} 次` : '正在读取候选档位…'}。每个检查最多一条请求；实际用量由服务商计费。</p>
    <p className="capability-estimate">基础测试最多输出 1,024 tokens，思考测试通常为 2,048；旧版 Claude 的思考预算需另留正文空间，最高档最多 17,408。额度不足或输出上限导致无正文时，不会判为模型不支持。</p>
    <div className="capability-actions"><button type="button" className="settings-button is-primary" disabled={busy || disabled || loading || !model || !singleCount} onClick={() => start(false)}>测试当前模型</button>
      <button type="button" className="settings-button" disabled={busy || disabled || !readyAll || !allCount} onClick={() => start(true)}>依次测试全部聊天模型</button>
      {busy && <button type="button" className="settings-button" onClick={() => void cancel()} disabled={cancelled}>取消检测与后续队列</button>}
      {!busy && <button type="button" className="settings-button" onClick={() => void refresh()} disabled={loading || !model}>刷新结果</button>}</div>
    {busy && <p role="status">{jobModel || model}：{job ? `${job.completed}/${job.total} · ${job.status}` : '正在提交检测…'}{cancelled ? ' · 已请求取消' : ''}</p>}
    {!busy && job && <p role="status">{jobModel}：{job.completed}/{job.total} 项已返回。{cancelled || job.status === 'cancelled' ? '后续检测已取消，已完成的结果保留。' : job.status === 'completed' ? '本次检测完成。' : '本次检测未完成。'}</p>}
    {job?.error && <p role="alert" className="capability-error">{job.error}</p>}
    {runError && <div role="alert" className="capability-notice">{runError}{job && !terminal(job) && <button type="button" className="settings-button" onClick={() => void getCapabilityJob(job.id).then(setJob).catch(failure => setRunError(capabilityErrorMessage(failure)))}>刷新进度</button>}</div>}
    {(error || recordsError) && <p role="alert" className="capability-notice">{error || recordsError}</p>}
    {capabilities?.stale && <p className="capability-notice">配置已变化，以下旧结果已失效；重新检测后才开放对应能力。</p>}
    <small>候选档位：{capabilities?.candidates.join('、') || (loading ? '读取中…' : '未提供')}。未测试不等于不支持；参数被接受也不等于已证明生效。</small>
    <div className="capability-results">{Object.entries(features).map(([name, feature]) => <FeatureRow key={name} name={name} feature={feature} />)}</div>
    {!Object.keys(features).length && !loading && <p className="capability-empty">尚无检测记录。点击测试后才会发出模型请求。</p>}
  </section>
}
