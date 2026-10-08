// Existing saved URLs are never replaced by these opt-in presets.
export const providerPresets = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'qwen', name: 'Qwen（北京）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'qwen-singapore', name: 'Qwen（新加坡）', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  { id: 'claude', name: 'Claude（阅读问答）', baseUrl: 'https://api.anthropic.com' },
  { id: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1' },
] as const

export const newProviderEnabled = 0

// Selecting Custom unlocks the currently filled URL without erasing credentials.
export function selectProviderPreset<T extends { name: string; baseUrl: string }>(draft: T, presetId: string) {
  const preset = providerPresets.find(item => item.id === presetId)
  return {
    draft: preset ? { ...draft, name: preset.name, baseUrl: preset.baseUrl } : draft,
    customEditing: !preset,
    protocol: preset ? (preset.id === 'claude' ? 'anthropic' as const : 'openai-chat' as const) : undefined,
  }
}

export function normalizeProviderUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

export function classifyProvider(_id: string | undefined, baseUrl: string) {
  const normalized = normalizeProviderUrl(baseUrl)
  let hostname = ''
  try {
    const url = new URL(baseUrl.trim())
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol')
    hostname = url.hostname
  } catch { return { kind: 'unconfigured' as const, label: '未配置有效连接', hostname } }
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return { kind: 'local' as const, label: '本地连接', hostname }
  const preset = providerPresets.find(item => normalizeProviderUrl(item.baseUrl) === normalized)
  if (preset) return { kind: 'official' as const, label: '官方预设地址', hostname }
  return { kind: 'custom' as const, label: '自定义连接', hostname }
}
