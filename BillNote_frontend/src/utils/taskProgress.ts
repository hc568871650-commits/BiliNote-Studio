import type { Task } from '@/store/taskStore'

export const generationStages = ['接收任务', '获取视频', '转写字幕', '整理笔记', '保存结果']
const phases: Record<string, { index: number; title: string; detail: string }> = {
  PENDING: { index: 0, title: '任务已排队', detail: '等待后台开始处理。' },
  PARSING: { index: 0, title: '正在准备视频', detail: '初始化处理器并解析来源。' },
  DOWNLOADING: { index: 1, title: '正在获取视频', detail: '正在读取来源、下载媒体或复用缓存。' },
  TRANSCRIBING: { index: 2, title: '正在整理原始字幕', detail: '正在提取字幕或转写音频，耗时取决于视频长度。' },
  FORMATTING: { index: 3, title: '正在处理画面与排版', detail: '正在选择截图或整理笔记中的来源与图片。' },
  SUMMARIZING: { index: 3, title: '正在蒸馏笔记', detail: '模型正在根据字幕与所选画面整理内容。' },
  SAVING: { index: 4, title: '正在保存结果', detail: '正在保存笔记、图片及来源信息。' },
  SUCCESS: { index: 4, title: '生成完成', detail: '正在载入完整笔记。' },
}
export const isKnownActivePhase = (status?: string) => Boolean(status && status !== 'SUCCESS' && phases[status])
export function generationPhase(task: Pick<Task, 'status' | 'last_active_status'>) {
  const status = task.status === 'FAILED' ? task.last_active_status : task.status
  return (status && phases[status]) || { index: -1, title: '正在同步生成进度', detail: '正在向后台读取当前处理阶段。' }
}

export function generationTitle(task?: Pick<Task, 'audioMeta' | 'formData'>) {
  if (task?.audioMeta?.title?.trim()) return task.audioMeta.title
  if (task?.formData?.platform === 'local') {
    const filename = task.formData.video_url?.split(/[\\/]/).pop()
    if (filename) return filename
    return '本地视频（标题待读取）'
  }
  return '视频标题待解析'
}
export function generationElapsed(task: Pick<Task, 'status' | 'started_at' | 'finished_at' | 'attemptStartedAt'>, now: number) {
  const started = task.started_at ? Date.parse(task.started_at) : task.attemptStartedAt
  const terminal = ['FAILED', 'SUCCESS'].includes(task.status)
  const end = terminal ? (task.finished_at ? Date.parse(task.finished_at) : NaN) : now
  return started !== undefined && Number.isFinite(started) && Number.isFinite(end) ? Math.max(0, end - started) : undefined
}

// Older note endpoints omit polling metadata. Preserve only metadata for the same attempt.
export function mergeTaskSnapshot(local: Task | undefined, remote: Task): Task {
  if (local?.status === 'SUBMISSION_UNKNOWN' && remote.formData?.request_id !== local.formData?.request_id) return local
  if (!local || (local.formData?.request_id && remote.formData?.request_id && local.formData.request_id !== remote.formData.request_id)) return remote
  const older = local.status_updated_at && remote.status_updated_at && Date.parse(remote.status_updated_at) < Date.parse(local.status_updated_at)
  if (older || (['FAILED', 'SUCCESS'].includes(local.status) && !['FAILED', 'SUCCESS'].includes(remote.status))) {
    return { ...remote, ...local, archived_at: remote.archived_at }
  }
  const terminal = ['FAILED', 'SUCCESS'].includes(remote.status)
  return {
    ...local, ...remote,
    audioMeta: { ...local.audioMeta, ...remote.audioMeta, title: remote.audioMeta?.title || local.audioMeta?.title || '' },
    statusMessage: remote.statusMessage || (terminal && local.status === remote.status ? local.statusMessage : undefined),
    last_active_status: remote.last_active_status || (isKnownActivePhase(remote.status) ? remote.status : local.last_active_status || (isKnownActivePhase(local.status) ? local.status : undefined)),
    started_at: remote.started_at || local.started_at,
    finished_at: terminal ? remote.finished_at || local.finished_at : undefined,
  }
}
