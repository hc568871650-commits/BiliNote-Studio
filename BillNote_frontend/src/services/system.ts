import request from '@/utils/request'

export interface SysHealth {
  backend: 'ok' | 'error'
  ffmpeg: 'ok' | 'missing'
  db: 'ok' | 'error'
  whisper_model: {
    /** 当前选中的模型 size，例如 'tiny' / 'base' / 'large-v3' */
    size: string | null
    /** 转写器类型 */
    type: string | null
    /** 是否已完整下载到本地（仅本地引擎有意义） */
    downloaded: boolean
    /** 是否实际检查过 —— 在线引擎跳过检查时为 false */
    checked: boolean
  }
}

/** 详细健康状态：用于设置页 / 启动诊断。后端始终返回 200，按字段判断各项。 */
export const getSysHealth = async (): Promise<SysHealth> => {
  return await request.get('/sys_health')
}

/** 保留旧 systemCheck 函数名（App.tsx 启动时仍调用），返回值同 getSysHealth。 */
export const systemCheck = getSysHealth

export interface DeployStatus {
  simulated?: boolean
  backend: {
    status: string
    port: number
  }
  cuda: {
    available: boolean
    /** 新增：torch 是否安装。轻量部署没装 torch 时为 false，避免误判为 CUDA 故障 */
    torch_installed?: boolean
    version: string | null
    gpu_name: string | null
  }
  whisper: {
    model_size: string
    transcriber_type: string
    /** 新增：模型是否已完整下载（fast-whisper 看 model.bin / mlx 看 config.json） */
    downloaded: boolean
  }
  ffmpeg: {
    available: boolean
  }
}

export const getDeployStatus = async (): Promise<DeployStatus> => {
  return await request.get('/deploy_status')
}

export interface StorageCategory {
  id: 'temp_media' | 'note_results' | 'screenshots' | 'vector_db' | 'database'
  label: string
  bytes: number
  files: number
  clearable: boolean
}

export interface PlaybackCachePolicy {
  enabled: boolean
  retention_days: 0 | 7 | 30 | 90
  max_size_mb: number
}

export interface StorageSummary {
  total_bytes: number
  categories: StorageCategory[]
  playback_cache: PlaybackCachePolicy
}

export const getSystemStorage = async (): Promise<StorageSummary> => {
  return await request.get('/system/storage', { suppressToast: true })
}

export const clearTempMediaCache = async (): Promise<{
  deleted_files: number
  freed_bytes: number
  storage: StorageSummary
}> => {
  return await request.post('/system/storage/clear-cache', {}, { suppressToast: true })
}

export const getPlaybackCachePolicy = async (): Promise<PlaybackCachePolicy> => {
  return await request.get('/system/playback-cache', { suppressToast: true })
}

export const updatePlaybackCachePolicy = async (
  payload: Partial<PlaybackCachePolicy>,
): Promise<PlaybackCachePolicy> => {
  return await request.put('/system/playback-cache', payload, { suppressToast: true })
}

export const getBackupDownloadUrl = (includeSecrets = false): string => {
  const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
  return `${apiBase}/system/backup?include_secrets=${includeSecrets ? 'true' : 'false'}`
}

export interface RestoreBackupResult {
  restored_files: number
  pre_backup_path: string
  backup_created_at?: string | null
  include_secrets: boolean
}

export const restoreLibraryBackup = async (file: File): Promise<RestoreBackupResult> => {
  const form = new FormData()
  form.append('file', file)
  return await request.post('/system/restore', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 180000,
    suppressToast: true,
  })
}

export interface UpdateCheckResult {
  checked: boolean
  has_update: boolean
  current_version: string
  latest_version: string
  release_url: string
  summary: string
  published_at?: string | null
}

export const checkAppUpdate = async (currentVersion?: string): Promise<UpdateCheckResult> => {
  return await request.get('/system/check-update', {
    params: currentVersion ? { current_version: currentVersion } : undefined,
    suppressToast: true,
    timeout: 12000,
  })
}

