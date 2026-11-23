import request from '@/utils/request'
import toast from 'react-hot-toast'
import type { Task } from '@/store/taskStore'
import type { AxiosRequestConfig } from 'axios'
import type { GenerationOptions } from './generationRuns'

export type NoteRequestOptions = Pick<AxiosRequestConfig, 'signal' | 'timeout' | 'suppressToast'>
export interface GenerateNoteResponse { task_id: string }
export interface TaskStatusResponse {
  task_id: string
  request_id?: string
  status: string
  cancelled?: boolean
  message?: string
  last_active_status?: string
  started_at?: string | null
  finished_at?: string | null
  status_updated_at?: string | null
  audio_meta?: { title?: string }
  result?: { markdown?: Task['markdown']; transcript?: Task['transcript']; audio_meta?: Task['audioMeta']; resource_base?: string }
}

export const listNotes = () => request.get('/notes') as unknown as Promise<Task[]>
export const getNote = (id: string, options: NoteRequestOptions = {}) => request.get(`/notes/${encodeURIComponent(id)}`, options) as unknown as Promise<Task>
export const importNotes = (tasks: Task[]) => request.post('/notes/import', { tasks }) as unknown as Promise<Task[]>
export const archiveNote = (id: string) => request.post(`/notes/${encodeURIComponent(id)}/archive`) as unknown as Promise<Task>
export const restoreNote = (id: string) => request.post(`/notes/${encodeURIComponent(id)}/restore`) as unknown as Promise<Task>
export const deleteNote = (id: string) => request.delete(`/notes/${encodeURIComponent(id)}`)
export const cancelGeneration = (id: string, requestId?: string) =>
  request.post(`/notes/${encodeURIComponent(id)}/cancel`, { request_id: requestId }) as unknown as Promise<{ cancel_requested?: boolean }>

export interface GenerateNotePayload {
  video_url: string
  platform: string
  quality: string
  model_name: string
  provider_id: string
  task_id?: string
  format: Array<string>
  style: string
  extras?: string
  video_understand?: boolean
  video_interval?: number
  frame_mode?: 'dynamic' | 'fixed'
  grid_size: Array<number>
  link?: boolean
  screenshot?: boolean
  video_understanding?: boolean
  request_id?: string
  output_language?: 'zh-CN' | 'source'
  generation_options?: GenerationOptions
}

// An interrupted response can still represent an accepted job. Never automatically retry.
export const generateNote = (data: GenerateNotePayload, options: NoteRequestOptions = {}) =>
  request.post('/generate_note', data, options) as unknown as Promise<GenerateNoteResponse>

export const delete_task = async ({ video_id, platform }: { video_id: string; platform: string }) => {
  try {
    const data = {
      video_id,
      platform,
    }
    const res = await request.post('/delete_task', data)


      toast.success('任务已成功删除')
      return res
  } catch (e) {
    toast.error('请求异常，删除任务失败')
    console.error('❌ 删除任务失败:', e)
    throw e
  }
}

export const get_task_status = (task_id: string, options: NoteRequestOptions = {}) =>
  request.get('/task_status/' + encodeURIComponent(task_id), { suppressToast: true, ...options }) as unknown as Promise<TaskStatusResponse>

export interface UpgradeStructuredPayload {
  provider_id?: string
  model_name?: string
  protocol?: string
  style?: 'knowledge' | 'tutorial'
  extras?: string
}

export const upgradeNoteStructured = (taskId: string, payload: UpgradeStructuredPayload = {}) =>
  request.post(`/notes/${encodeURIComponent(taskId)}/upgrade-structured`, payload, { timeout: 180000 }) as unknown as Promise<Task>

export interface QuizAttemptRecord {
  picked_key?: string
  selected_key?: string
  correct_key?: string
  is_correct: boolean
  question?: string
  section_title?: string
  explanation?: string
  interval_days?: number
  ease?: number
  next_review_at?: string | null
  updated_at?: number | string
}

export interface UserAnnotationRecord {
  id: string
  section_id: string
  section_title?: string
  block_id?: string
  anchor_text?: string
  title: string
  detail: string
  source: 'manual' | 'assistant'
  created_at?: string
  updated_at?: string
}

export interface NoteLearningState {
  task_id?: string
  quiz_attempts: Record<string, QuizAttemptRecord>
  pinned_annotations: Record<string, { pinned: boolean; note?: string; updated_at?: number | string }>
  checklist_states: Record<string, boolean>
  user_annotations?: UserAnnotationRecord[]
  updated_at?: number | string | null
}

export const getNoteLearningState = (taskId: string) =>
  request.get(`/notes/${encodeURIComponent(taskId)}/learning-state`, { suppressToast: true }) as unknown as Promise<NoteLearningState>

export const updateNoteLearningState = (
  taskId: string,
  payload: Partial<Pick<NoteLearningState, 'quiz_attempts' | 'pinned_annotations' | 'checklist_states'>>,
) =>
  request.put(`/notes/${encodeURIComponent(taskId)}/learning-state`, payload, { suppressToast: true }) as unknown as Promise<NoteLearningState>

export const createUserAnnotation = (
  taskId: string,
  payload: {
    section_id?: string
    section_title?: string
    block_id?: string
    anchor_text?: string
    title?: string
    detail: string
    source?: 'manual' | 'assistant'
  },
) =>
  request.post(`/learning/notes/${encodeURIComponent(taskId)}/annotations`, payload, { suppressToast: true }) as unknown as Promise<UserAnnotationRecord>

export const updateUserAnnotation = (
  taskId: string,
  annotationId: string,
  payload: {
    section_id?: string
    section_title?: string
    block_id?: string
    anchor_text?: string
    title?: string
    detail?: string
  },
) =>
  request.put(
    `/learning/notes/${encodeURIComponent(taskId)}/annotations/${encodeURIComponent(annotationId)}`,
    payload,
    { suppressToast: true },
  ) as unknown as Promise<UserAnnotationRecord>

export const deleteUserAnnotation = (taskId: string, annotationId: string) =>
  request.delete(
    `/learning/notes/${encodeURIComponent(taskId)}/annotations/${encodeURIComponent(annotationId)}`,
    { suppressToast: true },
  ) as unknown as Promise<{ deleted: boolean; id: string }>

export interface ReviewBankQuizOption {
  key: string
  text: string
}

export interface ReviewBankItem {
  kind: 'wrong_quiz' | 'pit_annotation'
  task_id: string
  version_id?: string | null
  note_title: string
  section_id: string
  section_title: string
  quiz_id?: string
  annotation_id?: string
  question?: string
  options?: ReviewBankQuizOption[]
  picked_key?: string
  correct_key?: string
  explanation?: string
  hint?: string
  detail?: string
  timestamp?: number | null
  timestamp_label?: string
  mastered?: boolean
  review_count?: number
  last_reviewed_at?: string | null
  next_review_at?: string | null
  interval_days?: number
  ease?: number
  is_due?: boolean
  updated_at?: number
}

export interface ReviewBankResponse {
  total: number
  wrong_quiz_count: number
  pit_count: number
  due_total?: number
  due_wrong_quizzes?: number
  due_pit_annotations?: number
  pending_total?: number
  mastered_total?: number
  items: ReviewBankItem[]
}

interface RawBackendWrongQuiz {
  task_id?: string
  version_id?: string | null
  note_title?: string
  section_id?: string
  quiz_id?: string
  section_title?: string
  short_prompt?: string
  full_question?: string
  options?: ReviewBankQuizOption[]
  selected_key?: string
  picked_key?: string
  correct_key?: string
  explanation?: string
  mastered?: boolean
  review_count?: number
  last_reviewed_at?: string | null
  next_review_at?: string | null
  interval_days?: number
  ease?: number
  is_due?: boolean
  updated_at?: number | string
}

interface RawBackendPitAnnotation {
  task_id?: string
  version_id?: string | null
  note_title?: string
  section_id?: string
  section_title?: string
  annotation_id?: string
  short_hint?: string
  full_detail?: string
  hint?: string
  detail?: string
  note?: string
  timestamp?: number | null
  timestamp_label?: string
  mastered?: boolean
  review_count?: number
  last_reviewed_at?: string | null
  next_review_at?: string | null
  interval_days?: number
  ease?: number
  is_due?: boolean
  updated_at?: number | string
}

interface RawReviewBankPayload {
  total?: number
  wrong_quiz_count?: number
  pit_count?: number
  due_total?: number
  due_wrong_quizzes?: number
  due_pit_annotations?: number
  pending_total?: number
  mastered_total?: number
  items?: ReviewBankItem[]
  wrong_quizzes?: RawBackendWrongQuiz[]
  pit_annotations?: RawBackendPitAnnotation[]
  counts?: {
    wrong_quizzes?: number
    pit_annotations?: number
    due_total?: number
    due_wrong_quizzes?: number
    due_pit_annotations?: number
    pending_total?: number
    mastered_total?: number
  }
}

function toTimestampNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function normalizeReviewBankResponse(raw: unknown): ReviewBankResponse {
  const payload = (raw && typeof raw === 'object' ? raw : {}) as RawReviewBankPayload
  if (Array.isArray(payload.items)) {
    const wrongCount = Number.isFinite(payload.wrong_quiz_count)
      ? Number(payload.wrong_quiz_count)
      : payload.items.filter(item => item.kind === 'wrong_quiz').length
    const pitCount = Number.isFinite(payload.pit_count)
      ? Number(payload.pit_count)
      : payload.items.filter(item => item.kind === 'pit_annotation').length
    const total = Number.isFinite(payload.total) ? Number(payload.total) : wrongCount + pitCount
    return {
      total,
      wrong_quiz_count: wrongCount,
      pit_count: pitCount,
      items: payload.items,
    }
  }

  const wrongItems: ReviewBankItem[] = (payload.wrong_quizzes || []).map(item => ({
    kind: 'wrong_quiz',
    task_id: String(item.task_id || ''),
    version_id: item.version_id ?? null,
    note_title: String(item.note_title || item.task_id || ''),
    section_id: String(item.section_id || ''),
    quiz_id: String(item.quiz_id || item.section_id || ''),
    section_title: String(item.section_title || ''),
    question: String(item.full_question || item.short_prompt || ''),
    options: Array.isArray(item.options) ? item.options : [],
    picked_key: item.selected_key || item.picked_key || undefined,
    correct_key: item.correct_key || undefined,
    explanation: item.explanation ? String(item.explanation) : undefined,
    mastered: Boolean(item.mastered),
    review_count: Number(item.review_count || 0),
    last_reviewed_at: item.last_reviewed_at ?? null,
    next_review_at: item.next_review_at ?? null,
    interval_days: Number.isFinite(item.interval_days) ? Number(item.interval_days) : undefined,
    ease: Number.isFinite(item.ease) ? Number(item.ease) : undefined,
    is_due: typeof item.is_due === 'boolean' ? item.is_due : undefined,
    updated_at: toTimestampNumber(item.updated_at),
  }))

  const pitItems: ReviewBankItem[] = (payload.pit_annotations || []).map(item => ({
    kind: 'pit_annotation',
    task_id: String(item.task_id || ''),
    version_id: item.version_id ?? null,
    note_title: String(item.note_title || item.task_id || ''),
    section_id: String(item.section_id || ''),
    section_title: String(item.section_title || ''),
    annotation_id: item.annotation_id ? String(item.annotation_id) : undefined,
    hint: String(item.short_hint || item.hint || ''),
    detail: String(item.full_detail || item.detail || item.note || ''),
    timestamp: item.timestamp ?? null,
    timestamp_label: item.timestamp_label ? String(item.timestamp_label) : undefined,
    mastered: Boolean(item.mastered),
    review_count: Number(item.review_count || 0),
    last_reviewed_at: item.last_reviewed_at ?? null,
    next_review_at: item.next_review_at ?? null,
    interval_days: Number.isFinite(item.interval_days) ? Number(item.interval_days) : undefined,
    ease: Number.isFinite(item.ease) ? Number(item.ease) : undefined,
    is_due: typeof item.is_due === 'boolean' ? item.is_due : undefined,
    updated_at: toTimestampNumber(item.updated_at),
  }))

  const wrongCount = Number.isFinite(payload.counts?.wrong_quizzes)
    ? Number(payload.counts?.wrong_quizzes)
    : wrongItems.length
  const pitCount = Number.isFinite(payload.counts?.pit_annotations)
    ? Number(payload.counts?.pit_annotations)
    : pitItems.length

  return {
    total: wrongCount + pitCount,
    wrong_quiz_count: wrongCount,
    pit_count: pitCount,
    due_total: payload.counts?.due_total ?? payload.due_total,
    due_wrong_quizzes: payload.counts?.due_wrong_quizzes ?? payload.due_wrong_quizzes,
    due_pit_annotations: payload.counts?.due_pit_annotations ?? payload.due_pit_annotations,
    pending_total: payload.counts?.pending_total ?? payload.pending_total,
    mastered_total: payload.counts?.mastered_total ?? payload.mastered_total,
    items: [...wrongItems, ...pitItems],
  }
}

export const fetchReviewBank = async (params: { kind?: 'all' | 'wrong_quiz' | 'pit'; status?: 'due' | 'pending' | 'mastered' | 'all'; limit?: number } = {}) => {
  const raw = await (request.get('/learning/review-bank', { params, suppressToast: true }) as unknown as Promise<unknown>)
  return normalizeReviewBankResponse(raw)
}

export interface ReviewQuizPracticeResult {
  task_id: string
  section_id: string
  quiz_id: string
  selected_key: string
  correct_key: string
  is_correct: boolean
  mastered: boolean
  review_count: number
  last_reviewed_at: string
  interval_days?: number
  ease?: number
  next_review_at?: string | null
  is_due?: boolean
  explanation?: string
}

export const submitReviewQuizPractice = async (payload: {
  task_id: string
  section_id: string
  selected_key?: string
  mastered?: boolean
}): Promise<ReviewQuizPracticeResult> => {
  return await request.post('/learning/review-bank/practice', payload, { suppressToast: true })
}

export const updateReviewPitStatus = async (payload: {
  task_id: string
  section_id: string
  annotation_id: string
  mastered?: boolean
  remembered?: boolean
}): Promise<{
  task_id: string
  section_id: string
  annotation_id: string
  mastered: boolean
  review_count: number
  interval_days?: number
  next_review_at?: string | null
  is_due?: boolean
}> => {
  return await request.post('/learning/review-bank/pit-status', payload, { suppressToast: true })
}

export interface TopicQuizQuestion {
  task_id: string
  version_id?: string | null
  note_title: string
  section_id: string
  section_title: string
  short_prompt?: string
  full_question: string
  options: ReviewBankQuizOption[]
  correct_key: string
  explanation?: string
  ever_wrong?: boolean
  attempt_count?: number
}

export interface TopicQuizResponse {
  questions: TopicQuizQuestion[]
  total_available: number
  note_count: number
}

export const fetchTopicQuiz = async (payload: {
  folder_id?: string
  task_ids?: string[]
  limit?: number
  include_archived?: boolean
}): Promise<TopicQuizResponse> => {
  return await request.post('/learning/topic-quiz', payload, { suppressToast: true })
}

export interface RelatedNoteItem {
  task_id: string
  title: string
  platform?: string
  score: number
  shared_tags: string[]
  reason: string
}

export const fetchRelatedNotes = async (taskId: string, limit = 3): Promise<RelatedNoteItem[]> => {
  const res = (await request.get(`/learning/notes/${encodeURIComponent(taskId)}/related`, {
    params: { limit },
    suppressToast: true,
  })) as unknown as { items?: RelatedNoteItem[] }
  return Array.isArray(res?.items) ? res.items : []
}

export interface MediaConcatSegment {
  index?: number
  label?: string
  start: number
  end: number
  duration?: number
}

export interface NoteMediaInfo {
  available: boolean
  media_type: string | null
  size: number
  url: string | null
  synthetic?: boolean
  concat_segments?: MediaConcatSegment[]
}

export const getNoteMediaInfo = async (taskId: string): Promise<NoteMediaInfo> => {
  return await request.get(`/media/${encodeURIComponent(taskId)}/info`, {
    suppressToast: true,
    timeout: 6000,
  })
}

export interface TranslatedTranscriptSegment {
  start: number
  end: number
  text: string
  translated_text?: string
}

export interface TranslateCaptionsResponse {
  task_id: string
  translated: boolean
  cached: boolean
  translated_count?: number
  total_count?: number
  missing_count?: number
  language?: string
  segments: TranslatedTranscriptSegment[]
}

export const translateNoteCaptions = async (
  taskId: string,
  options?: { target_lang?: string; force?: boolean; provider_id?: string; model_name?: string },
): Promise<TranslateCaptionsResponse> => {
  return await request.post(
    `/media/${encodeURIComponent(taskId)}/translate-captions`,
    {
      target_lang: options?.target_lang || 'zh-CN',
      force: Boolean(options?.force),
      provider_id: options?.provider_id,
      model_name: options?.model_name,
    },
    {
      suppressToast: true,
      timeout: 120000,
    },
  )
}

export const noteMediaStreamUrl = (baseURL: string, taskId: string) => {
  const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
  if (/^https?:\/\//i.test(apiBase)) {
    return `${apiBase}/media/${encodeURIComponent(taskId)}`
  }
  const origin = (baseURL || '').replace(/\/$/, '')
  return `${origin}${apiBase}/media/${encodeURIComponent(taskId)}`
}

export interface CollectionItem {
  index: number
  title: string
  url: string
  video_id: string
  duration: number | null
  platform: string
  already_exists: boolean
  existing_task_id: string | null
}

export interface CollectionResolution {
  collection_title: string
  platform: string
  source_url: string
  is_collection: boolean
  total_count: number
  items: CollectionItem[]
}

export const resolveCollection = async (url: string): Promise<CollectionResolution> => {
  return await request.post('/ingestion/resolve-collection', { url }, { timeout: 30000, suppressToast: true })
}

export interface EnqueueBatchPayload {
  items: Array<{ title: string; url: string; platform?: string }>
  model_name: string
  provider_id: string
  quality?: 'fast' | 'medium' | 'slow'
  style?: 'tutorial' | 'knowledge'
  format?: string[]
  extras?: string
  screenshot?: boolean
  link?: boolean
  video_understanding?: boolean
  video_interval?: number
  grid_size?: number[]
  frame_mode?: 'dynamic' | 'fixed'
  output_language?: 'zh-CN' | 'source'
  generation_options?: GenerationOptions
  create_folder?: boolean
  folder_name?: string
  folder_id?: string
}

export interface EnqueueBatchResult {
  batch_id: string
  folder: { id: string; name: string } | null
  enqueued: Array<{ task_id: string; job_id: string; title: string; url: string; platform: string }>
  skipped: Array<{ index: number; reason: string }>
}

export const enqueueBatch = async (payload: EnqueueBatchPayload): Promise<EnqueueBatchResult> => {
  return await request.post('/ingestion/enqueue-batch', payload, { timeout: 30000, suppressToast: true })
}

export interface BatchUpgradeStructuredPayload {
  task_ids: string[]
  provider_id: string
  model_name: string
  protocol?: string
  style?: 'tutorial' | 'knowledge'
  extras?: string
  generation_options?: GenerationOptions
}

export interface BatchUpgradeStructuredResult {
  batch_id: string
  enqueued: Array<{ task_id: string; job_id: string; title: string }>
  skipped: Array<{ task_id: string; reason: string }>
}

export const batchUpgradeStructured = async (
  payload: BatchUpgradeStructuredPayload,
): Promise<BatchUpgradeStructuredResult> => {
  return await request.post('/notes/batch-upgrade-structured', payload, { timeout: 30000, suppressToast: true })
}
