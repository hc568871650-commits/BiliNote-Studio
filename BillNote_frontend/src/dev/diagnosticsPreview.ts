import JSZip from 'jszip'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import type { NoteDiagnostics } from '@/services/noteDiagnostics'
import type { Task } from '@/store/taskStore'

const params = new URLSearchParams(location.search)
export const diagnosticsPreview = params.get('diagnostics') === '1'
export const diagnosticsTaskId = 'ui-diagnostics-save-failure'
const failures = new Set<string>()
export async function diagnosticsEndpoint(config: InternalAxiosRequestConfig, tasks: Task[]): Promise<AxiosResponse | null> {
  const match = (config.url || '').match(/^\/notes\/([^/]+)\/(diagnostics(?:\/export)?|retry-save)$/)
  if (!match) return null
  const id = decodeURIComponent(match[1]); const action = match[2]
  const task = tasks.find(item => item.id === id)
  const mode = action === 'diagnostics' ? 'read' : action === 'retry-save' ? 'save' : 'export'
  const fail = params.get('diagnosticsError') === `${mode}-once` && !failures.has(mode)
  if (fail) { failures.add(mode); throw { code: 503, msg: '合成临时错误，请重试', data: null } }
  const delay = Math.min(5000, Math.max(0, Number(params.get('diagnosticsDelay')) || 0))
  if (delay) await new Promise(resolve => setTimeout(resolve, delay))
  const recoverable = diagnosticsPreview && id === diagnosticsTaskId && task?.status === 'FAILED'
  const summary: NoteDiagnostics = {
    task_id: id, trace_id: id === diagnosticsTaskId ? 'synthetic-save-failure-20261013' : null,
    historical: id !== diagnosticsTaskId,
    stages: id === diagnosticsTaskId ? [{ name: 'model', status: 'completed', duration_ms: 2100 }, { name: 'save_content', status: 'completed', duration_ms: 30 }, { name: 'save_index', status: recoverable ? 'failed' : 'completed', duration_ms: 10 }] : [],
    error: recoverable ? { category: 'save', type: 'PermissionError', message: '合成示例：笔记索引暂时不可写', errno: 13, winerror: 5, http_status: null, request_id: null, frames: [] } : null,
    outcomes: { model_completed: id === diagnosticsTaskId ? true : null, content_saved: Boolean(task && (Array.isArray(task.markdown) ? task.markdown.length : task.markdown)), index_saved: recoverable ? false : task?.status === 'SUCCESS' },
    save_recovery: { available: recoverable, reason: recoverable ? '保留了完整正文，可重新写入索引' : '没有待恢复的保存结果' }, events: [],
  }
  let data: unknown = summary
  if (action === 'retry-save') {
    if (!recoverable || !task) throw { code: 409, msg: '没有可恢复的保存结果，请刷新诊断', data: null }
    task.status = 'SUCCESS'; task.statusMessage = '合成示例：保存已恢复，未调用模型'
    data = { task, diagnostics: { ...summary, error: null, outcomes: { ...summary.outcomes, index_saved: true }, save_recovery: { available: false, reason: '保存已恢复' } } }
  }
  if (action === 'diagnostics/export') {
    const zip = new JSZip(); zip.file('diagnostics.json', JSON.stringify({ ...summary, simulated: true }, null, 2))
    return { data: await zip.generateAsync({ type: 'blob' }), status: 200, statusText: 'OK', headers: { 'content-disposition': 'attachment; filename="synthetic-diagnostics.zip"' }, config }
  }
  return { data: { code: 0, msg: '合成诊断响应', data: structuredClone(data) }, status: 200, statusText: 'OK', headers: {}, config }
}
