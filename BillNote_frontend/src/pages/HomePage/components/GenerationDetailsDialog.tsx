import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import GenerationOptionsFields from '@/components/GenerationOptionsFields'
import { cancelGenerationComparison, createGenerationComparison, getGenerationComparison, getGenerationRuns, listGenerationComparisons, type GenerationComparison, type GenerationRun, type GenerationVariant } from '@/services/generationRuns'
import { clearPendingComparison, comparisonBound, exportGenerationReport, formatUsage, normalizeGenerationAttempt, normalizeGenerationOptions, readGenerationDefaults, readPendingComparison, savePendingComparison } from '@/utils/generationOptions'
import { useModelStore } from '@/store/modelStore'

const errorText = (error: unknown) => { const item = error as { msg?: string; message?: string }; return item?.msg || item?.message || '暂时无法读取记录' }
const active = (status: string) => ['queued', 'running', 'pending'].includes(status.toLowerCase())
const statusLabel = (status: string) => ({ queued: '等待中', running: '运行中', completed: '完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', success: '完成', succeeded: '成功', truncated: '输出截断', invalid_response: '响应无效', pending: '等待中' }[status.toLowerCase()] || status)
const phaseLabel = (phase?: string) => ({ summarize: '分段生成', merge: '合并笔记' }[phase || ''] || phase || '未记录')
const reasonLabel = (reason?: string) => ({ initial: '首次请求', retry: '失败重试', temperature_fallback: '省略温度重试' }[reason || ''] || reason || '未记录')
const warningLabels: Record<string, string> = { input_output_total_mismatch: '服务商返回的输入与输出之和不等于总 Token，费用估算保持未知', cached_exceeds_input: '缓存输入大于输入用量，服务商统计不一致', reasoning_exceeds_output: '思考用量大于输出用量，服务商统计不一致', cache_hit_miss_input_mismatch: '缓存命中与未命中之和不等于输入用量', partial_usage_metadata: '部分用量未返回；缺失字段保持未知' }
const emptyVariant = (): GenerationVariant => ({ provider_id: '', model_name: '', options: normalizeGenerationOptions() })
const download = (run: GenerationRun) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportGenerationReport(run), null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `generation-${run.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function RunReport({ run }: { run: GenerationRun }) {
  const summary = { ...run.totals, ...run.summary }
  const cost = summary.cost_estimate
  const rawAttempts = run.attempts || run.requests || []
  const attempts = rawAttempts.map(normalizeGenerationAttempt)
  return <article className="generation-report">
    <div className="generation-report-heading"><strong>{run.model_name || '未记录模型'} · {statusLabel(run.status)}</strong><Button variant="ghost" size="sm" onClick={() => download(run)}>导出 JSON</Button></div>
    <dl className="generation-report-summary"><div><dt>耗时</dt><dd>{formatUsage(summary.duration_seconds)} 秒</dd></div><div><dt>总用量</dt><dd>{formatUsage(summary.total_tokens)} Token</dd></div><div><dt>费用估算</dt><dd>{typeof cost?.amount === 'number' ? `${cost.currency} ${cost.amount.toFixed(4)}${cost.complete === false ? '（部分）' : ''}` : '未知'}</dd></div></dl>
    <details><summary>用量明细与统计说明</summary><dl className="generation-report-stats">{[
      ['输入 Token', summary.input_tokens], ['输出 Token', summary.output_tokens], ['思考 Token', summary.thinking_tokens], ['缓存输入 Token', summary.cached_input_tokens],
      ['服务商总 Token', summary.total_tokens], ['未命中缓存 Token', summary.cache_miss_tokens],
      ['逻辑请求', summary.request_count], ['HTTP 尝试', summary.attempt_count], ['耗时（秒）', summary.duration_seconds],
    ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{formatUsage(value as number | null | undefined)}</dd></div>)}</dl>
    {run.counts && <p className="generation-details-muted">失败重试 {formatUsage(run.counts.retries)} · 温度兼容请求 {formatUsage(run.counts.temperature_fallbacks)} · 输出截断 {formatUsage(run.counts.truncations)} · 分段 {formatUsage(run.counts.summarize_attempts)} / 合并 {formatUsage(run.counts.merge_attempts)}</p>}
    {run.warnings?.length ? <p className="generation-details-muted">{run.warnings.map(code => warningLabels[code] || `统计提示：${code}`).join('；')}</p> : null}
    </details>
    {run.error && <p role="alert" className="generation-report-error">{typeof run.error === 'string' ? run.error : `生成未完成 · ${run.error.type || '错误类型未记录'}`}</p>}
    <details><summary>请求与尝试明细 · {attempts.length || '无记录'}</summary>{attempts.length ? <div style={{ overflowX: 'auto' }}><table><thead><tr>{['请求 / 尝试', '阶段', '原因', '状态', '耗时（秒）', '输入', '输出', '思考', '缓存输入'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{attempts.map((item, index) => <tr key={`${item.id || index}:${index}`}><td>{item.logical_request_id || '—'} / {index + 1}</td><td>{phaseLabel(item.phase)}</td><td>{reasonLabel(item.reason)}</td><td>{item.status ? statusLabel(item.status) : '未知'}</td><td>{formatUsage(item.duration_seconds)}</td><td>{formatUsage(item.input_tokens)}</td><td>{formatUsage(item.output_tokens)}</td><td>{formatUsage(item.thinking_tokens)}</td><td>{formatUsage(item.cached_input_tokens)}</td></tr>)}</tbody></table>
      <details><summary>生效参数与响应状态</summary><table><thead><tr>{['尝试', 'HTTP', '结束原因', '实际温度', '实际思考', '输出上限'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{attempts.map((item, index) => <tr key={index}><td>{index + 1}</td><td>{item.http_status ?? '未知'}</td><td>{item.finish_reason === 'stop' ? '正常结束' : item.finish_reason === 'length' ? '达到长度限制' : item.finish_reason || item.error_type || '未知'}</td><td>{item.settings_effective?.temperature == null ? '未发送' : String(item.settings_effective.temperature)}</td><td>{item.settings_effective?.reasoning_effort == null ? '未指定' : String(item.settings_effective.reasoning_effort)}</td><td>{String(item.settings_effective?.max_completion_tokens ?? item.settings_effective?.max_tokens ?? item.settings_effective?.max_output_tokens ?? '自动')}</td></tr>)}</tbody></table></details>
      </div> : <p className="generation-details-muted">历史生成没有用量记录，不能据此推断为零消耗。</p>}</details>
    {run.options && <details><summary>本次请求参数快照</summary><GenerationOptionsFields value={normalizeGenerationOptions(run.options)} onChange={() => {}} disabled /></details>}
  </article>
}

export default function GenerationDetailsDialog({ taskId, versionId, modelName, noteTitle, onClose, allowComparison = true, pollGenerationRuns = false }: { taskId: string; versionId: string; modelName: string; noteTitle?: string; onClose: () => void; allowComparison?: boolean; pollGenerationRuns?: boolean }) {
  const [reports, setReports] = useState<GenerationRun[]>([])
  const [comparisons, setComparisons] = useState<GenerationComparison[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'overview' | 'comparison'>('overview')
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [comparisonLoaded, setComparisonLoaded] = useState(false)
  const [comparisonError, setComparisonError] = useState('')
  const [error, setError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [compareOpen, setCompareOpen] = useState(false)
  const [variants, setVariants] = useState<GenerationVariant[]>([emptyVariant(), emptyVariant()])
  const [useImages, setUseImages] = useState(false)
  const [range, setRange] = useState({ start: '', end: '' })
  const [submitting, setSubmitting] = useState(false)
  const [uncertainRequest, setUncertainRequest] = useState(() => readPendingComparison(taskId, versionId)?.request_id || '')
  const [cancelId, setCancelId] = useState('')
  const [pollError, setPollError] = useState('')
  const [generationPollError, setGenerationPollError] = useState('')
  const guard = useRef(false)
  const uncertainPayload = useRef<Parameters<typeof createGenerationComparison>[0] | null>(readPendingComparison(taskId, versionId))
  const alive = useRef(true)
  const models = useModelStore(state => state.modelList)
  const loadModels = useModelStore(state => state.loadEnabledModels)
  const currentReports = reports.filter(run => !versionId || !run.version_id || run.version_id === versionId)
  const sourceReport = currentReports.find(run => run.model_name === modelName) || currentReports[0]
  const currentComparisons = comparisons.filter(run => run.version_id === versionId)
  const busy = submitting || currentComparisons.some(run => active(run.status))
  const load = useCallback(async () => {
    setLoading(true); setError('')
    const results = await Promise.allSettled([getGenerationRuns(taskId)])
    if (!alive.current) return
    if (results[0].status === 'fulfilled') setReports(Array.isArray(results[0].value) ? results[0].value : [])
    const failures = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[]
    if (failures.length) setError(failures.map(result => errorText(result.reason)).join('；'))
    setLoading(false)
  }, [taskId])
  const loadComparisons = useCallback(async () => {
    if (!allowComparison) return
    setComparisonLoading(true); setComparisonError('')
    try {
      const response = await listGenerationComparisons(taskId)
      if (!alive.current) return
      const list = Array.isArray(response) ? response : []
      setComparisons(list)
      setComparisonLoaded(true)
      const pendingId = uncertainPayload.current?.request_id
      if (pendingId && list.some(item => item.request_id === pendingId)) { setUncertainRequest(''); uncertainPayload.current = null; try { clearPendingComparison(taskId, versionId) } catch { /* A later read can safely match the same id again. */ } setSubmitError('已查到本次提交，继续查看下方记录。') }
    } catch (failure) { if (alive.current) setComparisonError(errorText(failure)) }
    finally { if (alive.current) setComparisonLoading(false) }
  }, [taskId, versionId, allowComparison])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])
  useEffect(() => {
    if (tab !== 'comparison' || !allowComparison) return
    void loadModels()
    if (!comparisonLoaded) void loadComparisons()
  }, [tab, allowComparison, comparisonLoaded, loadComparisons, loadModels])
  useEffect(() => {
    if (!pollGenerationRuns) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const runs = await getGenerationRuns(taskId)
        if (stopped || !alive.current) return
        setReports(Array.isArray(runs) ? runs : []); setGenerationPollError('')
      } catch {
        if (stopped || !alive.current) return
        setGenerationPollError('生成记录暂时未能更新，保留最后状态；稍后继续读取。')
      }
      if (!stopped) timer = setTimeout(poll, 3000)
    }
    timer = setTimeout(poll, 3000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [pollGenerationRuns, taskId])
  // Poll only accepted active runs while this dialog is mounted. Never submit from an effect.
  const activeIds = comparisons.filter(run => active(run.status)).map(run => run.id).sort().join(',')
  useEffect(() => {
    if (!activeIds) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const results = await Promise.allSettled(activeIds.split(',').map(getGenerationComparison))
      if (cancelled || !alive.current) return
      const fresh = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      setComparisons(old => old.map(item => fresh.find(run => run.id === item.id) || item))
      setPollError(results.some(result => result.status === 'rejected') ? '记录更新暂时失败，已保留最后状态；稍后继续读取。' : '')
      if (fresh.some(run => active(run.status)) || results.some(result => result.status === 'rejected')) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [activeIds])
  const prepare = () => {
    if (!allowComparison || !versionId) return
    const options = normalizeGenerationOptions(sourceReport?.options)
    const firstModel = models.find(model => model.model_name === modelName) || models[0]
    setVariants([firstModel ? { provider_id: firstModel.provider_id, model_name: firstModel.model_name, options } : emptyVariant(), { ...emptyVariant(), options: { ...options } }])
    setCompareOpen(true)
  }
  const changeVariant = (index: number, patch: Partial<GenerationVariant>) => setVariants(old => old.map((item, position) => position === index ? { ...item, ...patch } : item))
  const pickModel = (index: number, encoded: string) => {
    const [provider_id, model_name] = JSON.parse(encoded)
    const saved = readGenerationDefaults(provider_id, model_name)
    changeVariant(index, { provider_id, model_name, options: { ...saved, chunk_seconds: variants[0].options.chunk_seconds, chunk_text_chars: variants[0].options.chunk_text_chars } })
  }
  const submit = async (retrySameRequest = false) => {
    if (!allowComparison || !versionId || guard.current || busy || (uncertainRequest && !retrySameRequest)) return
    if (!retrySameRequest && (!versionId || variants.some(item => !models.some(model => model.provider_id === item.provider_id && model.model_name === item.model_name)))) { setSubmitError('请选择两组可用模型，并确认笔记版本。'); return }
    const start = range.start === '' ? undefined : Number(range.start)
    const end = range.end === '' ? undefined : Number(range.end)
    if ((start !== undefined && (!Number.isFinite(start) || start < 0)) || (end !== undefined && (!Number.isFinite(end) || end <= (start || 0))) || (start !== undefined && end === undefined)) { setSubmitError('片段范围需填写有效的起止秒数；结束必须大于开始。'); return }
    guard.current = true; setSubmitting(true); setSubmitError('')
    const payload = retrySameRequest ? uncertainPayload.current : { task_id: taskId, version_id: versionId, request_id: crypto.randomUUID(), variants: variants.map(variant => ({ ...variant, options: normalizeGenerationOptions(variant.options) })), use_images: useImages, start_time: start, end_time: end }
    if (!payload) { guard.current = false; setSubmitting(false); return }
    try { savePendingComparison(payload) }
    catch { guard.current = false; setSubmitting(false); setSubmitError('无法保存本次请求编号，本次尚未提交。请检查本地存储后再试。'); return }
    try {
      const run = await createGenerationComparison(payload)
      try { clearPendingComparison(taskId, versionId) } catch { /* The stored id will be matched against server records when reopened. */ }
      if (!alive.current) return
      setComparisons(old => [run, ...old.filter(item => item.id !== run.id)]); setCompareOpen(false); setUncertainRequest(''); uncertainPayload.current = null
    } catch (failure) {
      if (!alive.current) return
      const item = failure as { code?: number }
      if (item.code === -1 || !item.code || item.code >= 500) { uncertainPayload.current = payload; setUncertainRequest(payload.request_id); setSubmitError('尚未确认是否已接收；请刷新测试记录检查，避免重复付费。也可明确使用原请求编号确认提交，服务端会复用已接收的记录。') }
      else { clearPendingComparison(taskId, versionId); uncertainPayload.current = null; setUncertainRequest(''); setSubmitError(errorText(failure)) }
    } finally { guard.current = false; if (alive.current) setSubmitting(false) }
  }
  const cancel = async (id: string) => {
    setCancelId(id)
    try { const run = await cancelGenerationComparison(id); if (alive.current) setComparisons(old => old.map(item => item.id === id ? run : item)) }
    catch (failure) { if (alive.current) setSubmitError(errorText(failure)) }
    finally { if (alive.current) setCancelId('') }
  }
  const readOutput = async (id: string) => {
    try { const run = await getGenerationComparison(id); if (alive.current) setComparisons(old => old.map(item => item.id === id ? run : item)) }
    catch (failure) { if (alive.current) setSubmitError(errorText(failure)) }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="generation-details-panel"><DialogHeader><DialogTitle>生成详情</DialogTitle><DialogDescription className="truncate">{noteTitle || (allowComparison ? '当前版本的使用量、生成参数与独立对照测试' : '这篇任务的使用量、HTTP 尝试与生成参数记录')}</DialogDescription></DialogHeader>
    {allowComparison && <div className="generation-details-tabs" role="tablist" aria-label="生成详情"><button type="button" role="tab" id="generation-overview-tab" aria-selected={tab === 'overview'} aria-controls="generation-overview" onClick={() => setTab('overview')}>概览</button><button type="button" role="tab" id="generation-comparison-tab" aria-selected={tab === 'comparison'} aria-controls="generation-comparison" onClick={() => setTab('comparison')}>对照测试</button></div>}
    <div className="generation-details-body">
      <div className="generation-details-actions"><Button variant="outline" size="sm" onClick={() => void (tab === 'comparison' ? loadComparisons() : load())} disabled={tab === 'comparison' ? comparisonLoading : loading}>刷新记录</Button>{allowComparison && tab === 'comparison' && <Button variant="outline" size="sm" disabled={busy || comparisonLoading || !comparisonLoaded || !versionId || Boolean(uncertainRequest)} onClick={prepare}>新建对照</Button>}<span className="generation-details-muted">{versionId ? `版本 ${versionId.slice(-8)}` : '尚未保存新版本'}{pollGenerationRuns && ' · 每 3 秒更新记录'}</span></div>
      {tab === 'overview' && <section className="generation-tab-content" id="generation-overview" role={allowComparison ? 'tabpanel' : undefined} aria-labelledby={allowComparison ? 'generation-overview-tab' : undefined}>
      {error && <p role="alert" className="generation-report-error">详情读取失败：{error}</p>}
      {loading && <p className="generation-details-muted">正在读取记录…</p>}
      {!loading && !currentReports.length && <p className="generation-details-muted">这份笔记没有生成用量记录。历史生成不会补算为零，也不会自动重新调用模型。</p>}
      {currentReports.map(run => <RunReport key={run.id} run={run} />)}
      {currentReports.length > 0 && <p className="generation-details-muted">未返回的用量保持未知；缓存与思考用量可能已计入输入或输出，不能重复相加。费用按填写价格估算，不等于账单。</p>}
      {generationPollError && <p role="status" className="generation-details-muted">{generationPollError}</p>}
      </section>}
      {tab === 'comparison' && allowComparison && <section className="generation-tab-content" id="generation-comparison" role="tabpanel" aria-labelledby="generation-comparison-tab">
      <p className="generation-details-muted">新对照仅支持最新版本，使用固定来源并单独保存结果。未知用量不补算为零；缓存、思考用量不可重复相加，费用估算不等于账单。</p>
      {comparisonLoading && <p className="generation-details-muted">正在读取测试记录…</p>}
      {comparisonError && <p role="alert" className="generation-report-error">测试记录读取失败：{comparisonError}</p>}
      {comparisonLoaded && !comparisonLoading && !currentComparisons.length && !compareOpen && <p className="generation-details-muted">当前版本还没有对照测试记录。</p>}
      {compareOpen && allowComparison && <section className="generation-report"><strong>同一来源，两组参数</strong><p className="generation-details-muted">两个方案共用冻结字幕、可选证据图和当前提示词；结果保存在独立测试记录中。开始测试会调用所选模型，费用由服务商收取。</p>
        <div className="generation-comparison-columns">{variants.map((variant, index) => <div className="generation-comparison-card" key={index}><strong>方案 {index === 0 ? 'A' : 'B'}</strong><select aria-label={`对照模型 ${index === 0 ? 'A' : 'B'}`} className="generation-comparison-model" disabled={busy || Boolean(uncertainRequest)} value={variant.provider_id && variant.model_name ? JSON.stringify([variant.provider_id, variant.model_name]) : ''} onChange={event => pickModel(index, event.target.value)}><option value="" disabled>选择模型</option>{models.map(model => <option key={`${model.provider_id}:${model.model_name}`} value={JSON.stringify([model.provider_id, model.model_name])}>{model.model_name} · {model.provider_id}</option>)}</select><GenerationOptionsFields value={variant.options} disabled={busy || Boolean(uncertainRequest)} sourceLocked onChange={options => changeVariant(index, { options })} /><p className="generation-details-muted">调用上限 {comparisonBound(variant.options).calls} 次；{comparisonBound(variant.options).amount == null ? '费用上限未知（输入 Token 尚未确定或未填写价格）' : `按次费用上限 ${variant.options.price!.currency} ${comparisonBound(variant.options).amount!.toFixed(4)}`}</p></div>)}</div>
        <div className="generation-settings-grid"><label>片段开始（秒，留空为全片）<input aria-label="对照开始秒数" type="number" min={0} disabled={busy || Boolean(uncertainRequest)} value={range.start} onChange={event => setRange(old => ({ ...old, start: event.target.value }))} /></label><label>片段结束（秒）<input aria-label="对照结束秒数" type="number" min={0} disabled={busy || Boolean(uncertainRequest)} value={range.end} onChange={event => setRange(old => ({ ...old, end: event.target.value }))} /></label></div>
        <label className="generation-price-toggle"><input type="checkbox" checked={useImages} disabled={busy || Boolean(uncertainRequest)} onChange={event => setUseImages(event.target.checked)} />两组都使用原生成保存的画面（缺失时停止并说明）</label>
        <p className="generation-details-muted">总调用上限 {variants.reduce((count, variant) => count + comparisonBound(variant.options).calls, 0)} 次，包括重试。实际按分段与请求限制结束；Token 计费缺少输入量，无法保证金额上限。正在执行的单次请求取消后仍可能计费。</p>
        <div className="generation-details-actions"><Button size="sm" onClick={() => void submit()} disabled={busy || Boolean(uncertainRequest) || variants.some(item => !item.model_name)}>{submitting ? '正在确认…' : '确认并开始两组测试'}</Button><Button variant="ghost" size="sm" onClick={() => setCompareOpen(false)} disabled={submitting}>收起</Button></div>
      </section>}
      {submitError && <p role="alert" className="generation-report-error">{submitError}</p>}
      {uncertainRequest && allowComparison && <div className="generation-details-actions"><span className="generation-details-muted">待确认请求：{uncertainRequest}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void submit(true)}>用原请求编号确认提交</Button></div>}
      {pollError && <p role="status" className="generation-details-muted">{pollError}</p>}
      {currentComparisons.map(run => <section key={run.id} className="generation-report"><div className="generation-report-heading"><strong>对照测试 · {statusLabel(run.status)}</strong>{active(run.status) ? <Button variant="outline" size="sm" disabled={cancelId === run.id} onClick={() => void cancel(run.id)}>{cancelId === run.id ? '正在取消…' : '停止后续请求'}</Button> : <Button variant="ghost" size="sm" onClick={() => void readOutput(run.id)}>读取测试输出</Button>}</div><p className="generation-details-muted">独立记录 {run.id.slice(-8)}{run.source?.fingerprint ? ` · 来源 ${run.source.fingerprint.slice(0, 12)}` : ''}{run.source?.image_count != null ? ` · ${run.source.image_count} 张画面` : ''}</p><div className="generation-comparison-columns">{run.variants.map((variant, index) => <div className="generation-comparison-card" key={index}><strong>方案 {index === 0 ? 'A' : 'B'} · {variant.model_name}</strong>{variant.report ? <RunReport run={variant.report} /> : <p className="generation-details-muted">{statusLabel(variant.status || run.status)} · 尚无用量记录</p>}{variant.error && <p className="generation-report-error">{variant.error}</p>}{variant.markdown && <details><summary>查看测试输出</summary><pre>{variant.markdown}</pre></details>}</div>)}</div></section>)}
      </section>}
    </div>
  </DialogContent></Dialog>
}
