import axios, { type AxiosAdapter } from 'axios'
import type { Task } from '@/store/taskStore'
import { previewAdapter } from './previewMock'

// Development-only transport. Never imported by the production App entry.
export const graphPreview = new URLSearchParams(location.search).get('engine') === 'graph'
const origin = 'http://127.0.0.1:19487'
const transport = axios.getAdapter(axios.defaults.adapter)
let verified = false

export async function loadGraphPreview(): Promise<Task[]> {
  const { data: identity } = await axios.get(`${origin}/health`, { timeout: 4000 })
  if (identity?.app_id !== 'bilinote-organizer-fixture' || identity.simulated_model !== true || identity.engine !== 'langgraph') {
    throw new Error('端口 19487 不是指定的隔离测试服务，已停止连接。')
  }
  verified = true
  const { data: response } = await axios.get(`${origin}/api/notes`, { timeout: 5000 })
  if (response?.code !== 0 || !Array.isArray(response.data)) throw new Error('独立测试笔记库未就绪。')
  return response.data
}

export const graphPreviewAdapter: AxiosAdapter = async config => {
  const path = config.url || ''
  if (path === '/generate_note' || path === '/chat/ask') return { data: { code: 1, msg: '此环境验证整理流程。视频生成和阅读问答请返回交互模拟页面试用。', data: null }, status: 200, statusText: 'OK', headers: {}, config }
  if (/^\/(?:organizer(?:\/|$)|notes(?:\/|$)|note_folders(?:\/|$)|note_library(?:\/|$))/.test(path)) {
    if (!verified) throw new Error('独立测试服务尚未通过身份检查。')
    return transport({ ...config, baseURL: `${origin}/api`, url: path, withCredentials: false })
  }
  return previewAdapter(config)
}
