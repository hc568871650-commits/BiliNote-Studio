import axios, { type AxiosAdapter } from 'axios'
import type { Task } from '@/store/taskStore'
import { previewAdapter } from './previewMock'
export const generationUsagePreview = new URLSearchParams(location.search).get('engine') === 'generation-usage'
const origin = 'http://127.0.0.1:29485'
const transport = axios.getAdapter(axios.defaults.adapter)
let verified = false
export async function loadGenerationUsagePreview(): Promise<Task[]> {
  const response = await axios.get(`${origin}/health`, { timeout: 4000 })
  if (response.data?.app_id !== 'bilinote-generation-usage-fixture' || response.data.simulated_model !== true || response.data.synthetic_data !== true) throw new Error('用量测试服务身份不匹配')
  verified = true
  const result = await axios.get(`${origin}/api/notes`, { timeout: 5000 })
  if (result.data?.code !== 0) throw new Error('无法读取示例笔记')
  return result.data.data
}
export const generationUsagePreviewAdapter: AxiosAdapter = async config => {
  const url = config.url || ''
  if (/^\/(notes(?:\/|$)|generation-comparisons(?:\/|\?|$))/.test(url)) {
    if (!verified) throw new Error('请先验证独立用量服务')
    return transport({ ...config, baseURL: `${origin}/api`, url })
  }
  return previewAdapter(config)
}
