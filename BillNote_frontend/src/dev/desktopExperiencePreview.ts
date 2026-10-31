import axios, { type AxiosAdapter } from 'axios'
import type { Task } from '@/store/taskStore'
import { previewAdapter } from './previewMock'

export const desktopExperiencePreview = import.meta.env.MODE === 'desktop-experience-preview'
export const DESKTOP_PREVIEW_ORIGIN = 'http://127.0.0.1:29483'
const transport = axios.getAdapter(axios.defaults.adapter)
let verified = false

function clientTask(task: Task): Task {
  return task.id === 'example-submission-unknown'
    ? { ...task, status: 'SUBMISSION_UNKNOWN', submissionInFlight: false,
        submissionError: '示例：提交响应中断，无法确认服务器是否受理',
        statusMessage: '示例：受理状态未知；未收到服务器任务确认' }
    : task
}

// Only these methods and relative paths can reach the fixture. Every other API stays in the synthetic adapter.
const routes: Array<[string, RegExp]> = [
  ['get', /^\/library\/search$/],
  ['get', /^\/notes$/],
  ['post', /^\/notes\/import$/],
  ['get', /^\/notes\/[A-Za-z0-9_-]+(?:\/diagnostics(?:\/export)?)?$/],
  ['post', /^\/notes\/[A-Za-z0-9_-]+\/(?:retry-save|archive|restore)$/],
  ['delete', /^\/notes\/[A-Za-z0-9_-]+$/],
  ['get', /^\/note_folders$/],
  ['post', /^\/note_folders(?:\/move)?$/],
  ['patch', /^\/note_folders\/[A-Za-z0-9_-]+$/],
  ['delete', /^\/note_folders\/[A-Za-z0-9_-]+$/],
  ['get', /^\/note_library$/],
  ['post', /^\/note_library\/update$/],
  ['get', /^\/task_status\/example-[A-Za-z0-9_-]+$/],
]

export async function loadDesktopExperiencePreview(): Promise<Task[]> {
  const health = await axios.get(`${DESKTOP_PREVIEW_ORIGIN}/health`, { timeout: 4000, withCredentials: false })
  const identity = health.data?.data
  if (identity?.app_id !== 'desktop-experience-preview' || identity.synthetic_data !== true ||
      identity.simulated_model !== true || identity.external_network !== false) {
    throw new Error('电脑版验收服务身份不匹配，已阻止继续连接')
  }
  verified = true
  const response = await axios.get(`${DESKTOP_PREVIEW_ORIGIN}/api/notes`, { timeout: 5000, withCredentials: false })
  if (response.data?.code !== 0 || !Array.isArray(response.data.data)) throw new Error('无法读取独立示例笔记')
  return response.data.data.map(clientTask)
}

export const desktopExperiencePreviewAdapter: AxiosAdapter = config => {
  const path = config.url || ''
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..')) {
    return Promise.reject(new Error('隔离预览只允许相对 API 路径'))
  }
  const method = (config.method || 'get').toLowerCase()
  if (method === 'get' && /^\/notes\/example-[A-Za-z0-9_-]+\/generation-runs$/.test(path)) {
    return Promise.resolve({ data: { code: 0, msg: '合成故障无模型用量记录', data: [] },
      status: 200, statusText: 'OK', headers: {}, config })
  }
  if (method === 'get' && path === '/task_status/example-submission-unknown') {
    return Promise.resolve({ data: { code: 404, msg: '示例：尚无法确认任务是否受理，不代表生成失败', data: null },
      status: 200, statusText: 'OK', headers: {}, config })
  }
  if (routes.some(([allowedMethod, pattern]) => method === allowedMethod && pattern.test(path))) {
    if (!verified) return Promise.reject(new Error('独立验收服务尚未通过身份检查'))
    const forwarded = { ...config, baseURL: `${DESKTOP_PREVIEW_ORIGIN}/api`, withCredentials: false }
    if (method === 'post' && path === '/notes/import') {
      // Fixtures are already durable; store rehydration must never re-upload their long bodies.
      forwarded.method = 'get'
      forwarded.url = '/notes'
      forwarded.data = undefined
      forwarded.headers = config.headers.concat()
      forwarded.headers.delete('Content-Type')
      forwarded.headers.delete('Content-Length')
      forwarded.headers.delete('Transfer-Encoding')
    }
    return transport(forwarded).then(response => {
      // XHR adapters return JSON text before Axios applies transformResponse.
      if (typeof response.data === 'string' && path.startsWith('/notes')) response.data = JSON.parse(response.data)
      if (response.data?.code === 0 && /^\/notes(?:\/import)?$/.test(path) && Array.isArray(response.data.data)) {
        response.data.data = response.data.data.map(clientTask)
      } else if (response.data?.code === 0 && path === '/notes/example-submission-unknown') {
        response.data.data = clientTask(response.data.data)
      }
      return response
    })
  }
  // Prevent library/folder mutations from silently diverging into previewMock's unrelated state.
  if (/^\/(?:notes|note_folders|note_library|library)(?:\/|$)/.test(path)) {
    return Promise.reject(new Error('此资料库操作未开放给隔离预览'))
  }
  return previewAdapter(config)
}
