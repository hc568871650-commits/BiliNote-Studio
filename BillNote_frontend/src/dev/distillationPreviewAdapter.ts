import axios, { type AxiosAdapter } from 'axios'
import type { Task } from '@/store/taskStore'
import { previewAdapter } from './previewMock'

export const distillationPreview = new URLSearchParams(location.search).get('engine') === 'distillation'
const origin = 'http://127.0.0.1:25485'
const transport = axios.getAdapter(axios.defaults.adapter)
let verified = false

export async function loadDistillationPreview(): Promise<Task[]> {
  const { data } = await axios.get(`${origin}/health`, { timeout: 4000 })
  if (data?.app_id !== 'bilinote-distillation-fixture' || data.simulated_model !== true || data.synthetic_data !== true) {
    throw new Error('局部蒸馏验收服务身份不匹配')
  }
  verified = true
  const response = await axios.get(`${origin}/api/notes`, { timeout: 5000 })
  if (response.data?.code !== 0 || !Array.isArray(response.data.data)) throw new Error('合成笔记读取失败')
  return response.data.data
}

export const distillationPreviewAdapter: AxiosAdapter = config => {
  const path = config.url || ''
  if (/^\/(?:notes|note_library|note_folders)(?:\/|$)/.test(path)) {
    if (!verified) return Promise.reject(new Error('隔离验收服务尚未通过身份检查'))
    return transport({ ...config, baseURL: `${origin}/api`, withCredentials: false })
  }
  return previewAdapter(config)
}
