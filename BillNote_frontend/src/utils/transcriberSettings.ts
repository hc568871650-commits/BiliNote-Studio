import type { GroqConnection, TranscriberConfig, TranscriberUpdate } from '@/services/transcriber'

export interface TranscriberDraft {
  type: string
  fastModel: string
  mlxModel: string
  groqModel: string
  connection: GroqConnection
  newName: string
  newTarget: string
}

export function loadTranscriberDraft(config: TranscriberConfig, cached: TranscriberDraft | null): TranscriberDraft {
  return cached || {
    type: config.transcriber_type,
    fastModel: config.whisper_model_size,
    mlxModel: config.mlx_whisper_model_size || config.whisper_model_size,
    groqModel: config.groq_model || 'whisper-large-v3-turbo',
    connection: config.groq_connection || { base_url: 'https://api.groq.com/openai/v1', api_key: '', enabled: true },
    newName: '',
    newTarget: '',
  }
}

/** Only the selected engine's settings may be sent; inactive drafts stay untouched. */
export function buildTranscriberUpdate(draft: TranscriberDraft): TranscriberUpdate {
  const payload: TranscriberUpdate = { transcriber_type: draft.type }
  if (draft.type === 'fast-whisper') payload.whisper_model_size = draft.fastModel
  if (draft.type === 'mlx-whisper') payload.mlx_whisper_model_size = draft.mlxModel
  if (draft.type === 'groq') {
    payload.groq_model = draft.groqModel.trim()
    payload.groq_connection = { ...draft.connection, base_url: draft.connection.base_url.trim() }
  }
  return payload
}
