import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { exportNoteDiagnostics, getNoteDiagnostics, retryNoteSave, type NoteDiagnostics } from '@/services/noteDiagnostics'
import { useTaskStore } from '@/store/taskStore'

const errorText = (error: unknown) => { const item = error as { msg?: string; message?: string }; return item?.msg || item?.message || '请求失败，请稍后重试' }
const label = (name: string) => ({ pending: '等待', parsing: '解析来源', downloading: '下载', transcribing: '转写', summarizing: '模型生成', formatting: '整理格式', saving: '保存笔记', success: '完成', failed: '失败', download: '下载', transcribe: '转写', summarize: '模型生成', model: '模型生成', save_content: '保存正文', save_index: '保存索引', index: '保存索引', content: '保存正文', save: '保存' }[name.toLowerCase()] || name)
const statusLabel = (status: string) => ({ completed: '完成', success: '完成', succeeded: '完成', failed: '失败', error: '失败', running: '进行中', pending: '待执行', skipped: '跳过', interrupted: '已中断', cancelled: '已取消' }[status.toLowerCase()] || status)
const outcome = (value: boolean | null | undefined) => value === true ? '完成' : value === false ? '未完成' : '未记录'
function NoteDiagnosticsContent({ taskId }: { taskId: string }) {
  const [data, setData] = useState<NoteDiagnostics | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const controller = useRef<AbortController | null>(null)
  const operation = useRef(false)
  const epoch = useRef(0)
  const invalidate = useCallback(() => { ++epoch.current; controller.current?.abort() }, [])
  const load = useCallback(async () => {
    const current = ++epoch.current
    controller.current?.abort()
    const control = new AbortController(); controller.current = control
    setLoading(true); setError('')
    try { const result = await getNoteDiagnostics(taskId, control.signal); if (current === epoch.current && !control.signal.aborted) setData(result) }
    catch (failure) { if (current === epoch.current && !control.signal.aborted) setError(`${errorText(failure)}；可重新读取，或稍后再打开生成详情。`) }
    finally { if (current === epoch.current && !control.signal.aborted) setLoading(false) }
  }, [taskId])
  useEffect(() => {
    setData(null); setMessage(''); void load()
    return invalidate
  }, [load, invalidate])
  const perform = async (kind: 'copy' | 'export' | 'save') => {
    if (!data || operation.current) return
    operation.current = true
    const current = epoch.current; const control = controller.current
    setBusy(kind); setError(''); setMessage('')
    const valid = () => current === epoch.current && !control?.signal.aborted
    try {
      if (kind === 'copy') {
        await navigator.clipboard.writeText(JSON.stringify({ task_id: data.task_id, trace_id: data.trace_id, historical: data.historical, stages: data.stages, error: data.error, outcomes: data.outcomes, save_recovery: data.save_recovery }, null, 2))
        if (valid()) setMessage('诊断摘要已复制')
      } else if (kind === 'export') {
        const file = await exportNoteDiagnostics(taskId, control?.signal)
        if (!valid()) return
        const url = URL.createObjectURL(file.blob)
        const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage('诊断包已下载')
      } else {
        await retryNoteSave(taskId, control?.signal)
        if (!valid()) return
        await useTaskStore.getState().loadTask(taskId)
        if (!valid()) return
        setMessage('保存已恢复，未重复调用模型'); setBusy(''); await load()
      }
    } catch (failure) { if (valid()) setError(`${errorText(failure)}；请刷新诊断确认当前保存结果后再试。`) }
    finally { operation.current = false; if (valid()) setBusy('') }
  }
  const failed = data?.stages?.find(stage => ['failed', 'error'].includes(stage.status.toLowerCase()))
  return <section id="generation-diagnostics" role="tabpanel" aria-labelledby="generation-diagnostics-tab" className="generation-tab-content">
    <div className="generation-details-actions"><Button variant="outline" size="sm" disabled={loading || Boolean(busy)} onClick={() => void load()}>刷新诊断</Button></div>
    {loading && <p role="status" className="generation-details-muted">正在读取诊断…</p>}
    {error && <p role="alert" className="generation-report-error">{error}</p>}
    {data && <article className="generation-report">
      {data.save_recovery?.available && <div className="rounded-md border border-primary/30 bg-primary/5 p-3"><div className="generation-report-heading"><strong>生成结果可恢复</strong><Button size="sm" disabled={loading || Boolean(busy)} onClick={() => void perform('save')}>{busy === 'save' ? '保存中…' : '重试保存'}</Button></div><p className="generation-details-muted">只重试保存，不重复调用模型。</p></div>}
      <div className="generation-report-heading"><strong>诊断 ID</strong><code className="break-all">{data.trace_id || '未记录'}</code></div>
      {data.historical && <p className="generation-details-muted">历史任务，未记录完整现场</p>}
      <dl className="generation-report-summary"><div><dt>模型生成</dt><dd>{outcome(data.outcomes?.model_completed)}</dd></div><div><dt>正文保存</dt><dd>{outcome(data.outcomes?.content_saved)}</dd></div><div><dt>索引保存</dt><dd>{outcome(data.outcomes?.index_saved)}</dd></div></dl>
      {failed && <p>失败阶段：{label(failed.name)}</p>}
      {data.error && <p role="alert" className="generation-report-error">{data.error.message || data.error.type || '错误详情未记录'}{data.error.http_status != null && ` · HTTP ${data.error.http_status}`}{data.error.winerror != null && ` · Windows ${data.error.winerror}`}</p>}
      {data.error?.request_id && <p className="generation-details-muted break-all">请求 ID：{data.error.request_id}</p>}
      {data.error && <details><summary>错误信息</summary><dl className="generation-report-stats"><div><dt>分类</dt><dd>{data.error.category || '未记录'}</dd></div><div><dt>类型</dt><dd>{data.error.type || '未记录'}</dd></div><div><dt>系统错误码</dt><dd>{data.error.errno ?? '未记录'}</dd></div></dl></details>}
      {!!data.stages?.length && <details><summary>阶段记录</summary><dl className="generation-report-stats">{data.stages.map((stage, index) => <div key={`${stage.name}:${index}`}><dt>{label(stage.name)}</dt><dd>{statusLabel(stage.status)}{typeof stage.duration_ms === 'number' ? ` · ${(stage.duration_ms / 1000).toFixed(1)} 秒` : ''}</dd></div>)}</dl></details>}
      <div className="generation-details-actions"><Button variant="outline" size="sm" disabled={loading || Boolean(busy)} onClick={() => void perform('copy')}>{busy === 'copy' ? '复制中…' : '复制诊断摘要'}</Button><Button variant="outline" size="sm" disabled={loading || Boolean(busy)} onClick={() => void perform('export')}>{busy === 'export' ? '下载中…' : '导出诊断包'}</Button></div>
      {!data.save_recovery?.available && data.save_recovery?.reason && <p className="generation-details-muted">{data.save_recovery.reason}</p>}
    </article>}
    {message && <p role="status" className="generation-details-muted">{message}</p>}
  </section>
}

export default function NoteDiagnosticsPanel({ taskId }: { taskId: string }) {
  return <NoteDiagnosticsContent key={taskId} taskId={taskId} />
}
