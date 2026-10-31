import { useEffect, useRef, useState } from 'react'
import ChoiceSelect from '@/components/ChoiceSelect'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { capabilityErrorMessage, capabilitySubmissionRejected, cancelCapabilityJob, getCapabilityJob, getActiveCapabilityJobs,
  getModelCapabilities, recoverCapabilitySubmission, startCapabilityTest,
  type CapabilityFeature, type CapabilityJob, type CapabilitySubmission, type CapabilityTestRequest, type ModelCapabilityRecord } from '@/services/modelCapabilities'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import { isTranscriptionModel } from '@/utils/modelCapabilities'
import { modelDisplayName } from '@/utils/modelDisplay'
import './ModelCapabilitiesPanel.css'

interface Props { providerId: string; models: { model_name: string; display_name?: string | null }[]; protocol: ProviderProtocol; disabled?: boolean }
const statusLabels = { passed: '已通过', unsupported: '明确不支持', failed: '暂时失败', inconclusive: '证据不足', skipped: '已跳过' }
const checkLabels: Record<string, string> = { basic: '非流式回复', stream: '流式回复', vision: '看图（流式）', tools: '工具调用', web_native: '原生联网（流式）' }
const checkLabel = (key: string) => checkLabels[key] || `思考 · ${key.replace('reasoning:', '')}`
const CHECKS = ['basic', 'stream', 'vision', 'tools', 'web_native', 'reasoning']
const jobStatusLabels: Record<string, string> = { queued: '排队中', running: '检测中', completed: '已完成', cancelled: '已取消', failed: '失败', passed: '已通过', partial: '部分通过' }
const effortLabels: Record<string, string> = { none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
const effortLabel = (effort: string) => effortLabels[effort] || effort
const formatCheckedAt = (value?: string) => { if (!value) return ''; const date = new Date(value); return isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
const HELP = '使用合成问题，不读取笔记，每项最多一条请求。看图发送一张测试小图并核对答案；联网需返回搜索来源，两项固定流式。离开本页或保存配置会请求取消后续检测，已发出的请求仍可能计费。基础测试最多输出 1,024 tokens，思考测试通常为 2,048；旧版 Claude 最高档最多 17,408。额度或输出上限不足不会判为模型不支持。'
const terminal = (job: CapabilityJob) => ['completed', 'cancelled', 'failed'].includes(job.status)
interface ProbeRun { cancelled: boolean; id?: string; submission?: CapabilitySubmission }

function FeatureRow({ name, feature, protocol }: { name: string; feature: CapabilityFeature; protocol: ProviderProtocol }) {
  const details = feature.error_details
  return <div className="capability-result">
    <div><span>{checkLabel(name)}</span><span className={`capability-status is-${feature.status}`}>{statusLabels[feature.status]}</span></div>
    <p>{feature.evidence || '未提供额外证据'}</p>
    <small>{feature.checked_at ? `${new Date(feature.checked_at).toLocaleString()} · ` : ''}{feature.elapsed_ms != null && Number.isFinite(feature.elapsed_ms) ? `${Math.round(feature.elapsed_ms)} ms` : feature.status === 'skipped' ? '未执行' : '耗时未记录'}</small>
    <details><summary>检测摘要</summary><pre>{JSON.stringify({job_id:feature.job_id,check:feature.check || name,protocol,stream:feature.stream,request_id:feature.request_id,status:feature.status,usage:feature.usage,upstream_protocol:feature.upstream_protocol,image_sha256:feature.image_sha256,sample_kind:feature.sample_kind,request_attempts:feature.request_attempts,validation:feature.validation},null,2)}</pre><button type="button" className="settings-button" onClick={() => void navigator.clipboard.writeText(JSON.stringify({job_id:feature.job_id,check:feature.check || name,protocol,stream:feature.stream,request_id:feature.request_id,status:feature.status,usage:feature.usage,upstream_protocol:feature.upstream_protocol,image_sha256:feature.image_sha256,sample_kind:feature.sample_kind,request_attempts:feature.request_attempts,validation:feature.validation},null,2))}>复制摘要</button></details>
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
  const [backgroundJobs, setBackgroundJobs] = useState<CapabilityJob[]>([])
  const [chosen, setChosen] = useState(['basic', 'stream'])
  const [probeStream, setProbeStream] = useState(false)
  const [job, setJob] = useState<CapabilityJob | null>(null)
  const [jobModel, setJobModel] = useState('')
  const [jobIdentity, setJobIdentity] = useState('')
  const currentIdentity = JSON.stringify([providerId, protocol])
  const [busy, setBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [checkingSubmission, setCheckingSubmission] = useState(false)
  const queue = useRef<CapabilityTestRequest[]>([])
  const alive = useRef(true)
  const handled = useRef(new Set<string>())
  const identity = useRef(0)
  const stopRequested = useRef(false)
  const run = useRef<ProbeRun | null>(null)
  const stopRun = () => {
    const current = run.current
    if (!current) return
    current.cancelled = true
    if (current.id) void cancelCapabilityJob(current.id).catch(() => undefined)
  }
  const [cancelled, setCancelled] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; queue.current = []; stopRun() } }, [])
  useEffect(() => {
    identity.current += 1
    stopRun()
    queue.current = []; setJob(null); setBusy(false); setRunError(null); setRecords({}); setUnconfirmed(false); setCheckingSubmission(false)
    let active = true
    const loadRecords = async () => {
      const revision = identity.current
      setRecordsError(null)
      try {
        const values = await Promise.all(JSON.parse(namesKey).map((name: string) => getModelCapabilities(providerId, name, protocol))) as ModelCapabilityRecord[]
        if (active && revision === identity.current) setRecords(Object.fromEntries(values.map(record => [record.model_name, record])))
        const pending = await getActiveCapabilityJobs()
        if (active && revision === identity.current) setBackgroundJobs(pending)
      } catch (failure) { if (active && revision === identity.current) setRecordsError(capabilityErrorMessage(failure)) }
    }
    if (providerId) void loadRecords()
    window.addEventListener('bilinote-capabilities-updated', loadRecords)
    const saved = () => { identity.current += 1; stopRun(); queue.current = []; setJob(null); setBusy(false); setRecords({}); setUnconfirmed(false); setCheckingSubmission(false); void loadRecords() }
    window.addEventListener('user-save-provider', saved)
    return () => { active = false; window.removeEventListener('bilinote-capabilities-updated', loadRecords); window.removeEventListener('user-save-provider', saved) }
  }, [providerId, protocol, namesKey])
  const checksFor = (name: string) => chosen.flatMap(check => check === 'reasoning'
    ? (records[name]?.candidates || (name === model ? capabilities?.candidates : []) || []).filter(effort => effort !== 'auto').map(effort => `reasoning:${effort}`)
    : [check])
  const reconcile = async (current: ProbeRun, revision: number) => {
    if (!current.submission) return
    const { body } = current.submission
    setCheckingSubmission(true)
    try {
      const result = await recoverCapabilitySubmission(current.submission)
      if (!alive.current || revision !== identity.current || run.current !== current) return
      if (!result) { setRunError('提交状态仍未确认；原检测可能已执行，再次检测可能重复计费。'); return }
      current.id = result.id
      current.submission = undefined
      setUnconfirmed(false); setJobIdentity(JSON.stringify([body.provider_id, body.protocol])); setJobModel(body.model_name); setJob(result)
      setRunError(current.cancelled && !terminal(result) ? '已找到检测，取消尚未确认。' : null)
      if (current.cancelled) setCancelled(false)
    } catch (failure) {
      if (alive.current && revision === identity.current && run.current === current) setRunError(`核对失败：${capabilityErrorMessage(failure)}；提交状态仍未确认。`)
    } finally {
      if (alive.current && revision === identity.current && run.current === current) setCheckingSubmission(false)
    }
  }
  const submit = async (body: CapabilityTestRequest, revision: number) => {
    const current: ProbeRun = { cancelled: false }
    const startedAt = Date.now()
    run.current = current
    setUnconfirmed(false)
    try {
      let accepted = await startCapabilityTest(body)
      current.id = accepted.id
      if (current.cancelled || stopRequested.current || !alive.current || revision !== identity.current) {
        try { accepted = await cancelCapabilityJob(accepted.id) }
        catch (failure) { if (alive.current && revision === identity.current) { setCancelled(false); setRunError(`取消未确认：${capabilityErrorMessage(failure)}；可再次点击取消。`) } }
      }
      if (alive.current && revision === identity.current) { setJobIdentity(JSON.stringify([body.provider_id, body.protocol])); setJobModel(body.model_name); setJob(accepted) }
    } catch (failure) {
      if (!alive.current || revision !== identity.current || run.current !== current) return
      queue.current = []
      if (capabilitySubmissionRejected(failure)) { setBusy(false); setRunError(capabilityErrorMessage(failure)); return }
      current.submission = { body, startedAt, failedAt: Date.now() }
      setUnconfirmed(true); setRunError('提交状态未确认，正在核对已有检测…')
      await reconcile(current, revision)
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
        if (job.status !== 'completed' || stopRequested.current) queue.current = []
        const next = queue.current.shift()
        if (next) void submit(next, revision)
        else setBusy(false)
      }
    } else {
      timer = setTimeout(() => {
        void getCapabilityJob(job.id).then(result => {
          if (active && revision === identity.current && (!stopRequested.current || terminal(result))) { setJob(result); setRunError(null) }
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
    const items = (all ? names : [model]).map(name => ({ provider_id: providerId, model_name: name, protocol, checks: checksFor(name), probe_stream: probeStream })).filter(item => item.checks.length)
    if (!items.length) return
    stopRequested.current = false
    setBusy(true); setCancelled(false); setRunError(null); setJob(null)
    queue.current = items.slice(1)
    void submit(items[0], identity.current)
  }
  const cancel = async () => {
    stopRequested.current = true
    if (run.current) run.current.cancelled = true
    const revision = identity.current
    queue.current = []; setCancelled(true)
    if (!job) return
    if (terminal(job)) { setBusy(false); return }
    try { const result = await cancelCapabilityJob(job.id); if (alive.current && revision === identity.current) setJob(result) }
    catch (failure) { if (alive.current && revision === identity.current) { setCancelled(false); setRunError(capabilityErrorMessage(failure)) } }
  }
  const toggle = (check: string) => setChosen(value => value.includes(check) ? value.filter(item => item !== check) : [...value, check])
  const refreshJob = async () => {
    const revision = identity.current
    if (run.current?.submission) { await reconcile(run.current, revision); return }
    if (!job) return
    try { const result = await getCapabilityJob(job.id); if (alive.current && revision === identity.current) setJob(result) }
    catch (failure) { if (alive.current && revision === identity.current) setRunError(capabilityErrorMessage(failure)) }
  }
  const retryUnconfirmed = () => {
    const submission = run.current?.submission
    if (!submission || checkingSubmission || disabled) return
    stopRequested.current = false; queue.current = []
    setCancelled(false); setRunError(null); setJob(null); setBusy(true)
    void submit(submission.body, identity.current)
  }
  const features = capabilities?.stale ? {} : job && jobIdentity === currentIdentity && !job.stale && jobModel === model ? { ...capabilities?.features, ...job.results } : capabilities?.features || {}
  const counts = job ? Object.values(job.results).reduce((result, feature) => ({ ...result, [feature.status]: (result[feature.status] || 0) + 1 }), {} as Record<string, number>) : {}
  const readyAll = names.length > 0 && names.every(name => Boolean(records[name]))
  const singleCount = checksFor(model).length
  const allCount = names.reduce((total, name) => total + checksFor(name).length, 0)
  const otherJobs = backgroundJobs.filter(item => item.id !== job?.id)
  const reasoningResults = Object.entries(features).filter(([name]) => name.startsWith('reasoning:'))
  const rowResult = (check: string): { status?: CapabilityFeature['status']; label: string; at?: string } => {
    if (check !== 'reasoning') {
      const feature = features[check]
      return feature ? { status: feature.status, label: statusLabels[feature.status], at: feature.checked_at } : { label: '未检测' }
    }
    if (!reasoningResults.length) return { label: '未检测' }
    const passed = reasoningResults.filter(([, feature]) => feature.status === 'passed').length
    const at = reasoningResults.map(([, feature]) => feature.checked_at).filter(Boolean).sort().pop()
    return { status: passed === reasoningResults.length ? 'passed' : passed ? 'inconclusive' : 'failed', label: `${passed}/${reasoningResults.length} 档通过`, at }
  }
  return <section className="settings-card model-capabilities-panel">
    <div className="settings-row"><div><h2>检测模型</h2></div>
      <ChoiceSelect label="能力测试模型" value={model} options={names.map(name => ({ value: name, label: modelDisplayName(models.find(item => item.model_name === name) || { model_name: name }) }))} onChange={setSelected} disabled={busy || disabled || !names.length} /></div>
    {disabled && <p className="capability-notice">请先保存服务商配置，再开始检测。</p>}
    {!names.length && <p>请先添加聊天模型；转写模型不适用。</p>}
    {capabilities?.stale && <p className="capability-stale">配置已变化，旧结果已失效。不影响正常使用。</p>}
    <fieldset className="capability-checks" disabled={busy || disabled}><legend className="sr-only">检测项目</legend>
      <table className="capability-table">
        <thead><tr><th scope="col">检测项</th><th scope="col">结果</th><th scope="col">检测时间</th></tr></thead>
        <tbody>{CHECKS.map(check => {
          const result = rowResult(check)
          return <tr key={check}>
            <td><label><input type="checkbox" checked={chosen.includes(check)} onChange={() => toggle(check)} />{check === 'reasoning' ? '思考档位' : checkLabel(check)}</label>
              {check === 'reasoning' && !!capabilities?.candidates.length && <small className="capability-candidates">{capabilities.candidates.map(effortLabel).join(' · ')}</small>}</td>
            <td><span className={`capability-status ${result.status ? `is-${result.status}` : 'is-none'}`}>{result.label}</span></td>
            <td><small>{formatCheckedAt(result.at)}</small></td>
          </tr>
        })}</tbody>
      </table>
    </fieldset>
    {(chosen.includes('tools') || chosen.includes('reasoning')) && <div className="settings-row capability-transport"><div><span>工具与思考检测方式</span></div><ChoiceSelect label="工具与思考测试传输" value={probeStream ? 'stream' : 'json'} options={[{value:'json',label:'非流式'},{value:'stream',label:'流式'}]} onChange={value => setProbeStream(value === 'stream')} disabled={busy || disabled} /></div>}
    <div className="capability-actions"><button type="button" className="settings-button is-primary" disabled={busy || disabled || loading || !model || !singleCount} onClick={() => start(false)}>测试当前模型</button>
      <button type="button" className="settings-button" disabled={busy || disabled || !readyAll || !allCount} onClick={() => start(true)}>测试全部</button>
      {busy && !unconfirmed && <button type="button" className="settings-button" onClick={() => void cancel()} disabled={cancelled}>取消检测</button>}
      {!busy && <button type="button" className="capability-link" onClick={() => void refresh()} disabled={loading || !model}>刷新结果</button>}
      <span className="capability-estimate" title={HELP}>预计 {singleCount} 次请求{readyAll && names.length > 1 ? `（全部 ${allCount} 次）` : ''} · 可能计费</span></div>
    {busy && <p role="status">{jobModel || model}：{unconfirmed ? '提交状态未确认' : job ? `${job.completed}/${job.total} · ${jobStatusLabels[job.status] || job.status}` : '正在提交检测…'}{cancelled ? ' · 已请求取消' : ''}</p>}
    {!busy && job && <p role="status">{jobModel}：{job.completed}/{job.total} 项已返回。{cancelled || job.status === 'cancelled' ? '后续检测已取消，已完成的结果保留。' : job.status === 'completed' ? '本次检测完成。' : '本次检测未完成。'}</p>}
    {job && <p role="status">通过 {counts.passed || 0} · 失败 {(counts.failed || 0) + (counts.unsupported || 0)} · 证据不足 {counts.inconclusive || 0} · 跳过 {counts.skipped || job.skipped?.length || 0}</p>}
    {job?.error && <p role="alert" className="capability-error">{job.error}</p>}
    {runError && <div role="alert" className="capability-notice">{runError}{(unconfirmed || job && !terminal(job)) && <button type="button" className="settings-button" disabled={checkingSubmission} onClick={() => void refreshJob()}>{unconfirmed ? '核对提交状态' : '刷新进度'}</button>}{unconfirmed && <button type="button" className="settings-button" disabled={checkingSubmission || disabled} onClick={retryUnconfirmed}>仍要重新检测（可能重复计费）</button>}</div>}
    {(error || recordsError) && <p role="alert" className="capability-notice">{error || recordsError}</p>}
    {otherJobs.length > 0 && <details className="capability-help" open><summary>其他进行中的检测 · {otherJobs.length}</summary><button type="button" className="capability-link" onClick={() => void getActiveCapabilityJobs().then(setBackgroundJobs).catch(failure => setRunError(capabilityErrorMessage(failure)))}>刷新</button>{otherJobs.map(item => <p key={item.id}>{item.model_name} · {jobStatusLabels[item.status] || item.status}<button type="button" className="settings-button" onClick={() => void cancelCapabilityJob(item.id).then(() => getActiveCapabilityJobs()).then(setBackgroundJobs).catch(failure => setRunError(`取消未确认：${capabilityErrorMessage(failure)}`))}>取消</button></p>)}</details>}
    {Object.keys(features).length > 0 && <details className="capability-help"><summary>检测详情与证据</summary><div className="capability-results">{Object.entries(features).map(([name, feature]) => <FeatureRow key={name} name={name} feature={feature} protocol={protocol} />)}</div></details>}
    {!!capabilities?.history?.length && <details className="capability-help"><summary>检测历史（最近 {capabilities.history.length} 次）</summary>{capabilities.history.map(item => <details key={item.id}><summary>{formatCheckedAt(item.created_at) || '时间未记录'} · {jobStatusLabels[item.outcome || item.status] || item.outcome || item.status}{item.stale ? ' · 已失效' : ''}</summary><pre>{JSON.stringify(item,null,2)}</pre><button type="button" className="settings-button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(item,null,2))}>复制检测摘要</button></details>)}</details>}
  </section>
}
