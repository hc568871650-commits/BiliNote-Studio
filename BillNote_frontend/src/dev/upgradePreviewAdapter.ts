import axios, { type AxiosAdapter } from 'axios'
import type { AskPayload } from '@/services/chat'
import type { Task } from '@/store/taskStore'
import { previewAdapter } from './previewMock'

export const upgradePreview = new URLSearchParams(location.search).get('engine') === 'upgrade'
const origin = 'http://127.0.0.1:23485'
const transport = axios.getAdapter(axios.defaults.adapter)
let verified = false
export async function loadUpgradePreview(): Promise<Task[]> {
  const {data} = await axios.get(`${origin}/health`,{timeout:4000})
  if (data?.app_id !== 'bilinote-ai-upgrade-fixture' || data.simulated_model !== true) throw new Error('AI 升级验收服务身份不匹配')
  verified = true
  const response = await axios.get(`${origin}/api/notes`,{timeout:5000})
  if (response.data?.code !== 0 || !Array.isArray(response.data.data)) throw new Error('合成笔记读取失败')
  return response.data.data
}
export const upgradePreviewAdapter: AxiosAdapter = config => {
  const path = config.url || ''
  if (/^\/(?:model_capabilities|web_search|organizer|chat|notes|note_library|note_folders)(?:\/|$)/.test(path)) {
    if (!verified) return Promise.reject(new Error('隔离验收服务尚未通过身份检查'))
    return transport({...config,baseURL:`${origin}/api`,withCredentials:false})
  }
  return previewAdapter(config)
}
export function upgradeChatStream(payload: AskPayload, signal: AbortSignal) {
  if (!verified) return Promise.reject(new Error('隔离验收服务尚未通过身份检查'))
  return fetch(`${origin}/api/chat/ask/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal})
}
