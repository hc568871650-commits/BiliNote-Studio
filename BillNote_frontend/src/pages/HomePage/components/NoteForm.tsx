import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useForm, useWatch, type FieldErrors } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  FileAudio,
  FileText,
  Image as ImageIcon,
  Layers,
  Link2,
  ListChecks,
  Loader2,
  RefreshCw,
  ScanEye,
  SlidersHorizontal,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  enqueueBatch,
  generateNote,
  get_task_status,
  resolveCollection,
  type CollectionItem,
  type CollectionResolution,
  type GenerateNotePayload,
} from '@/services/note'
import { uploadFile } from '@/services/upload'
import { useTaskStore, type Task } from '@/store/taskStore'
import { useFolderStore } from '@/store/folderStore'
import CollectionImportPanel from './CollectionImportPanel'
import { useModelStore } from '@/store/modelStore'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import { useCreateNoteDraftStore } from '@/store/createNoteDraftStore'
import { modelDisplayName } from '@/utils/modelDisplay'
import { normalizeNoteStyle, normalizeNoteFormats } from '@/utils/noteGeneration'
import GenerationOptionsFields from '@/components/GenerationOptionsFields'
import { normalizeGenerationOptions, readGenerationDefaults, saveGenerationDefaults } from '@/utils/generationOptions'
import type { GenerationOptions } from '@/services/generationRuns'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import { useInterfaceStore } from '@/store/interfaceStore'
import {
  extractShareInput,
  isDocumentSourceName,
  isSubtitleSourceName,
  LINK_PLATFORMS,
  looksLikeCollectionUrl,
  PLATFORM_LABELS,
  withScheme,
} from '@/utils/sourceUrl'
import './generation.css'

const platformLabels = PLATFORM_LABELS
const schema = z.object({
  video_url: z.string().default(''), platform: z.string(), model_name: z.string().min(1, '请选择生成模型'),
  style: z.enum(['tutorial', 'knowledge']), quality: z.enum(['fast', 'medium', 'slow']),
  format: z.array(z.string()).default(['link', 'screenshot']), extras: z.string().default(''),
  video_understanding: z.boolean().default(false), frame_mode: z.enum(['dynamic', 'fixed']).default('dynamic'),
  video_interval: z.coerce.number().min(1).max(30).default(6),
  grid_size: z.tuple([z.coerce.number().min(1).max(10), z.coerce.number().min(1).max(10)]).default([2, 2]),
}).superRefine((data, ctx) => {
  if (!data.video_url.trim()) { ctx.addIssue({ code: 'custom', path: ['video_url'], message: data.platform === 'local' ? '请选择视频文件或填写本地路径' : '请先粘贴视频链接' }); return }
  if (data.platform !== 'local') {
    try { const url = new URL(withScheme(data.video_url)); if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error() }
    catch { ctx.addIssue({ code: 'custom', path: ['video_url'], message: '请输入有效的视频链接' }) }
  }
})
export type NoteFormValues = z.output<typeof schema>
export type FormInput = z.input<typeof schema>
const errorText = (error: unknown) => { const e = error as { msg?: string; message?: string }; return e?.msg || e?.message || '暂时无法连接服务，请稍后重试' }
const platforms = LINK_PLATFORMS

export default function NoteForm({ onSubmitted, creating = false }: { onSubmitted?: () => void; creating?: boolean }) {
  const navigate = useNavigate()
  const currentTask = useTaskStore(state => creating ? null : state.tasks.find(task => task.id === state.currentTaskId) || null)
  const generationModel = usePurposeModelStore(state => state.defaults.generation)
  const modelList = useModelStore(state => state.modelList)
  const modelsLoading = useModelStore(state => state.enabledLoading)
  const modelsError = useModelStore(state => state.enabledError)
  const loadModels = useModelStore(state => state.loadEnabledModels)
  const draft = useCreateNoteDraftStore()
  const updateDraft = draft.update
  const [initialDraft] = useState(() => creating ? useCreateNoteDraftStore.getState() : null)
  const [providerId, setLocalProviderId] = useState(initialDraft?.providerId || generationModel?.provider_id || '')
  const setProviderId = useCallback((value: string) => { setLocalProviderId(value); if (creating) updateDraft({ providerId: value }) }, [creating, updateDraft])
  const [generationOptions, setLocalGenerationOptions] = useState<GenerationOptions>(() => initialDraft?.generationOptions
    ? normalizeGenerationOptions(initialDraft.generationOptions) : readGenerationDefaults(initialDraft?.providerId || generationModel?.provider_id || '', initialDraft?.values.model_name || generationModel?.model_name || ''))
  const setGenerationOptions = useCallback((value: GenerationOptions) => { setLocalGenerationOptions(value); if (creating) updateDraft({ generationOptions: value }) }, [creating, updateDraft])
  const [localSubmitting, setLocalSubmitting] = useState(false)
  const submitting = creating ? draft.submitting : localSubmitting
  const setSubmitting = (value: boolean) => creating ? draft.update({ submitting: value }) : setLocalSubmitting(value)
  const [checking, setChecking] = useState(false)
  const [localUploading, setLocalUploading] = useState(false)
  const uploading = creating ? draft.uploading : localUploading
  const setUploading = (value: boolean) => creating ? draft.update({ uploading: value }) : setLocalUploading(value)
  const [localUploadProgress, setLocalUploadProgress] = useState<number | null>(null)
  const uploadProgress = creating ? draft.uploadProgress : localUploadProgress
  const setUploadProgress = (value: number | null) => creating ? draft.update({ uploadProgress: value }) : setLocalUploadProgress(value)
  const [localFileName, setLocalFileName] = useState('')
  const fileName = creating ? draft.fileName : localFileName
  const setFileName = (value: string) => creating ? draft.update({ fileName: value }) : setLocalFileName(value)
  const [localNotice, setLocalNotice] = useState('')
  const [extractHint, setExtractHint] = useState('')
  const [draggingFile, setDraggingFile] = useState(false)
  const [collectionResolution, setCollectionResolution] = useState<CollectionResolution | null>(null)
  const [resolvingCollection, setResolvingCollection] = useState(false)
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const collectionResolveSeq = useRef(0)
  const notice = creating ? draft.notice : localNotice
  const setNotice = useCallback((value: string) => creating ? updateDraft({ notice: value }) : setLocalNotice(value), [creating, updateDraft])
  const [localPending, setLocalPending] = useState<GenerateNotePayload | null>(null)
  const pending = creating ? draft.pending : localPending
  const setPending = useCallback((value: GenerateNotePayload | null) => creating ? updateDraft({ pending: value }) : setLocalPending(value), [creating, updateDraft])
  const [localSubmittedAt, setLocalSubmittedAt] = useState(0)
  const submittedAt = creating ? draft.submittedAt : localSubmittedAt
  const setSubmittedAt = (value: number) => creating ? draft.update({ submittedAt: value }) : setLocalSubmittedAt(value)
  const [now, setNow] = useState(Date.now())
  const submitGuard = useRef(false)
  const uploadGuard = useRef(false)
  const alive = useRef(true)
  const uploadController = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const form = useForm<FormInput, unknown, NoteFormValues>({ resolver: zodResolver(schema), defaultValues: {
    video_url: '', platform: 'bilibili', model_name: generationModel?.model_name || '', style: 'tutorial', quality: 'medium',
    format: ['link', 'screenshot'], extras: '', video_understanding: false, frame_mode: 'dynamic', video_interval: 6, grid_size: [2, 2],
    ...initialDraft?.values,
  } })
  const platform = useWatch({ control: form.control, name: 'platform' })
  const videoUrl = useWatch({ control: form.control, name: 'video_url' })
  // Local files are normally dropped or picked; the path field opens on request or for a typed path.
  const [pathRequested, setPathRequested] = useState(false)
  const pathOpen = pathRequested || (platform === 'local' && Boolean(videoUrl) && !fileName)
  const format = useWatch({ control: form.control, name: 'format' })
  const vision = useWatch({ control: form.control, name: 'video_understanding' })
  const frameMode = useWatch({ control: form.control, name: 'frame_mode' })
  const modelName = useWatch({ control: form.control, name: 'model_name' })
  const quality = useWatch({ control: form.control, name: 'quality' })
  const extras = useWatch({ control: form.control, name: 'extras' })
  const editing = Boolean(currentTask)
  const generating = Boolean(currentTask && !['SUCCESS', 'FAILED'].includes(currentTask.status))
  const locked = submitting || checking || uploading || generating || Boolean(pending) || Boolean(currentTask?.archived_at)
  useEffect(() => {
    if (!creating) return
    const subscription = form.watch(values => useCreateNoteDraftStore.getState().update({ values: values as Partial<FormInput> }))
    return () => subscription.unsubscribe()
  }, [creating, form])
  useEffect(() => {
    // An upload or submission can complete after navigation remounts this form.
    if (creating && typeof draft.values.video_url === 'string' && draft.values.video_url !== form.getValues('video_url')) {
      form.setValue('video_url', draft.values.video_url)
    }
  }, [creating, draft.values.video_url, form])
  const modelOptionsKey = useRef(`${providerId}:${modelName}`)
  useEffect(() => {
    const key = `${providerId}:${modelName}`
    if (creating && key === modelOptionsKey.current) return
    modelOptionsKey.current = key
    const data = useTaskStore.getState().tasks.find(task => task.id === currentTask?.id)?.formData as (Task['formData'] & { generation_options?: GenerationOptions }) | undefined
    setGenerationOptions(data?.provider_id === providerId && data.model_name === modelName && data.generation_options
      ? normalizeGenerationOptions(data.generation_options) : readGenerationDefaults(providerId, modelName || ''))
  }, [providerId, modelName, currentTask?.id, creating, setGenerationOptions])
  useEffect(() => { alive.current = true; void loadModels(); return () => { alive.current = false; if (!creating) uploadController.current?.abort() } }, [loadModels, creating])
  useEffect(() => {
    if (!submitting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [submitting])
  const loadedTask = useRef('')
  useEffect(() => {
    if (!currentTask || loadedTask.current === currentTask.id) return
    loadedTask.current = currentTask.id
    const data = currentTask.formData as typeof currentTask.formData & Partial<NoteFormValues>
    setProviderId(data.provider_id); setNotice(''); setPending(null)
    form.reset({ video_url: data.video_url || '', platform: data.platform || 'bilibili', model_name: data.model_name || '',
      style: normalizeNoteStyle(data.style), quality: ['fast', 'slow'].includes(data.quality) ? data.quality as 'fast' | 'slow' : 'medium',
      format: normalizeNoteFormats(data.format ?? (data.screenshot ? ['screenshot'] : [])), extras: data.extras || '',
      video_understanding: data.video_understanding || false, frame_mode: data.frame_mode === 'fixed' ? 'fixed' : 'dynamic',
      video_interval: data.video_interval || 6, grid_size: data.grid_size || [2, 2] })
  }, [currentTask, form, setProviderId, setNotice, setPending])
  useEffect(() => {
    if (creating && generationModel && !useCreateNoteDraftStore.getState().values.model_name && !form.getFieldState('model_name').isDirty) {
      form.setValue('model_name', generationModel.model_name); setProviderId(generationModel.provider_id)
    }
  }, [creating, generationModel, form, setProviderId])

  const upload = async (file: File) => {
    if (uploadGuard.current || locked || editing) return
    uploadGuard.current = true
    const controller = new AbortController(); uploadController.current = controller
    setUploading(true); setUploadProgress(null); setFileName(file.name); setNotice('')
    try {
      const data = new FormData(); data.append('file', file)
      const result = await uploadFile(data, { signal: controller.signal, suppressToast: true, onUploadProgress: event => {
        if ((alive.current || creating) && event.total) setUploadProgress(Math.min(100, Math.round(event.loaded / event.total * 100)))
      } })
      if (alive.current) form.setValue('video_url', result.url, { shouldValidate: true })
      else if (creating) useCreateNoteDraftStore.getState().update({ values: { ...useCreateNoteDraftStore.getState().values, video_url: result.url } })
      if (alive.current || creating) setUploadProgress(100)
    } catch (error) { if ((alive.current || creating) && !controller.signal.aborted) setNotice(`上传未完成：${errorText(error)}`) }
    finally { uploadGuard.current = false; if (alive.current || creating) setUploading(false) }
  }
  const accepted = (payload: GenerateNotePayload) => {
    const store = useTaskStore.getState()
    const selectedBefore = store.currentTaskId
    if (!store.tasks.some(task => task.id === payload.task_id)) store.addPendingTask(payload.task_id!, payload.platform, payload)
    else {
      store.updateTaskContent(payload.task_id!, { status: 'PENDING', cancelled: false, last_active_status: 'PENDING', started_at: undefined, finished_at: undefined, status_updated_at: undefined, formData: payload as Task['formData'], attemptStartedAt: Date.now(), phaseStartedAt: Date.now(), submissionError: undefined, pollingError: undefined, statusMessage: '已接收，等待处理' })
      store.setCurrentTask(payload.task_id!)
    }
    const added = useTaskStore.getState().tasks.find(task => task.id === payload.task_id)
    if (payload.platform === 'local' && fileName && added) store.updateTaskContent(payload.task_id!, { audioMeta: { ...added.audioMeta, title: fileName } })
    if (creating) {
      // 恢复用户原本阅读中的选中笔记，避免新建入队把侧边栏高亮切走
      if (selectedBefore && selectedBefore !== payload.task_id) {
        store.setCurrentTask(selectedBefore)
      }
      if (alive.current) form.reset({ ...form.getValues(), video_url: '' })
      useCreateNoteDraftStore.getState().clearSource()
      void useDistillQueueStore.getState().refresh()
      toast.success('已加入蒸馏队列，可继续添加下一条')
      setPending(null); setNotice('')
      return
    }
    if (!alive.current) { store.setCurrentTask(selectedBefore); return }
    setPending(null); setNotice(''); onSubmitted?.()
  }
  const checkPending = async () => {
    if (!pending || checking) return
    setChecking(true)
    try {
      const status = await get_task_status(pending.task_id!, { timeout: 8000, suppressToast: true })
      if (status.request_id !== pending.request_id) { setNotice('尚未查到这次提交的受理记录，请稍后再次检查'); return }
      accepted(pending)
    } catch (error) { setNotice(`尚未确认任务是否已接收：${errorText(error)}。请稍后再次检查，避免重复生成。`) }
    finally { if (alive.current) setChecking(false) }
  }
  const onSubmit = async (values: NoteFormValues) => {
    if (submitGuard.current || locked) return
    if (!modelList.some(model => model.model_name === values.model_name && model.provider_id === providerId)) { setNotice('当前模型不可用，请重新选择或刷新模型列表'); return }
    submitGuard.current = true
    setSubmitting(true); setNotice(''); setSubmittedAt(Date.now()); setNow(Date.now())
    const outputLanguage = useInterfaceStore.getState().outputLanguage || 'zh-CN'
    const payload: GenerateNotePayload = { ...values, video_url: values.platform === 'local' ? values.video_url.trim() : withScheme(values.video_url),
      format: normalizeNoteFormats(values.format), link: true, screenshot: values.format.includes('screenshot'), provider_id: providerId,
      task_id: currentTask?.id || crypto.randomUUID(), request_id: crypto.randomUUID(), output_language: outputLanguage, generation_options: normalizeGenerationOptions(generationOptions) }
    if (creating) setPending(payload)
    try {
      if (!creating && currentTask) {
        // Regeneration shares the durable request identity and reconciliation path
        // used by the reader's retry action, including a lost admission response.
        await useTaskStore.getState().retryTask(payload.task_id!, payload)
        if (alive.current && useTaskStore.getState().currentTaskId === payload.task_id) {
          setPending(null); setNotice(''); onSubmitted?.()
        }
      } else {
        const response = await generateNote(payload, { timeout: 30000, suppressToast: true })
        if (!response?.task_id || response.task_id !== payload.task_id) throw new Error('尚未收到一致的任务编号')
        accepted(payload)
      }
    } catch (error) {
      if (!alive.current && !creating) return
      const e = error as { code?: number; data?: { reason?: string } }
      if (e?.code === -1 || !e?.code || e.code >= 500) {
        if (!creating && currentTask) {
          setPending(null); setNotice('')
          if (useTaskStore.getState().currentTaskId === payload.task_id) onSubmitted?.()
        } else {
          setPending(payload); setNotice('本次提交尚未确认。后台可能已接收，请先检查任务状态。')
        }
      } else {
        if (creating) setPending(null)
        setNotice(errorText(error))
        if (e?.data?.reason === 'transcriber_model_not_ready') setNotice(`${errorText(error)}。请在设置 → 音频转写中检查。`)
      }
    } finally { submitGuard.current = false; if (alive.current || creating) setSubmitting(false) }
  }
  const invalid = (errors: FieldErrors<FormInput>) => {
    setNotice(Object.values(errors).find(value => value?.message)?.message?.toString() || '请检查输入内容')
  }
  const switchSource = (local: boolean) => { if (!editing && !locked) { setPathRequested(false); setCollectionResolution(null); form.setValue('platform', local ? 'local' : 'bilibili'); form.setValue('video_url', ''); setFileName(''); setNotice('') } }
  const pickModel = (value: string) => { const [provider, model] = JSON.parse(value); setProviderId(provider); form.setValue('model_name', model, { shouldDirty: true, shouldValidate: true }) }

  const triggerResolveCollection = useCallback(async (rawUrl: string, { silentSingle = false }: { silentSingle?: boolean } = {}) => {
    const cleaned = extractShareInput(rawUrl).url.trim()
    if (!cleaned || editing) return
    const seq = ++collectionResolveSeq.current
    setResolvingCollection(true)
    setNotice('')
    try {
      const result = await resolveCollection(cleaned)
      if (!alive.current || collectionResolveSeq.current !== seq) return
      if (result.is_collection && result.items.length > 1) {
        setCollectionResolution(result)
      } else {
        setCollectionResolution(null)
        if (!silentSingle) {
          toast('该链接为单个视频，可直接点击「开始生成」')
        }
      }
    } catch (error) {
      if (!alive.current || collectionResolveSeq.current !== seq) return
      setCollectionResolution(null)
      if (!silentSingle) {
        setNotice(`合集解析失败：${errorText(error)}`)
      }
    } finally {
      if (alive.current && collectionResolveSeq.current === seq) {
        setResolvingCollection(false)
      }
    }
  }, [editing, setNotice])

  const handleBatchSubmit = async ({
    selectedItems,
    createFolder,
    folderName,
  }: {
    selectedItems: CollectionItem[]
    createFolder: boolean
    folderName: string
  }) => {
    if (batchSubmitting || locked || !selectedItems.length) return
    const values = form.getValues()
    if (!modelList.some(model => model.model_name === values.model_name && model.provider_id === providerId)) {
      setNotice('当前模型不可用，请先在下方选择可用模型')
      return
    }
    setBatchSubmitting(true)
    setNotice('')
    try {
      const result = await enqueueBatch({
        items: selectedItems.map(item => ({
          title: item.title,
          url: item.url,
          platform: item.platform,
        })),
        model_name: values.model_name,
        provider_id: providerId,
        quality: values.quality,
        style: values.style,
        format: normalizeNoteFormats(values.format),
        extras: values.extras,
        screenshot: values.format?.includes('screenshot') || false,
        link: true,
        video_understanding: Boolean(values.video_understanding),
        video_interval: Number(values.video_interval) || 6,
        grid_size: Array.isArray(values.grid_size) ? values.grid_size.map(Number) : [2, 2],
        frame_mode: values.frame_mode || 'dynamic',
        output_language: useInterfaceStore.getState().outputLanguage || 'zh-CN',
        generation_options: normalizeGenerationOptions(generationOptions),
        create_folder: createFolder,
        folder_name: createFolder ? folderName : undefined,
      })
      void useDistillQueueStore.getState().refresh()
      if (result.folder) {
        void useFolderStore.getState().loadFolders().catch(() => undefined)
      }
      if (alive.current) {
        setCollectionResolution(null)
        form.reset({ ...form.getValues(), video_url: '' })
        setExtractHint('')
      }
      if (creating) {
        useCreateNoteDraftStore.getState().clearSource()
      }
      const folderTip = result.folder ? `，已归入「${result.folder.name}」` : ''
      toast.success(`已将 ${result.enqueued.length} 集加入蒸馏队列${folderTip}`)
    } catch (error) {
      if (alive.current) {
        setNotice(`批量入队失败：${errorText(error)}`)
      }
    } finally {
      if (alive.current) setBatchSubmitting(false)
    }
  }

  const handleUrlInput = (raw: string, onChange: (value: string) => void) => {
    if (platform === 'local') {
      setExtractHint('')
      onChange(raw)
      return
    }
    const { url, platform: detected, extracted } = extractShareInput(raw)
    onChange(url)
    setCollectionResolution(null)
    if (detected) form.setValue('platform', detected)
    if (extracted) {
      setExtractHint(detected ? `已提取${platformLabels[detected] || ''}链接并自动识别平台` : '已从分享文本中提取纯净链接')
    } else {
      setExtractHint('')
    }
    if (!editing && looksLikeCollectionUrl(url)) {
      void triggerResolveCollection(url, { silentSingle: true })
    }
  }

  const isLocal = platform === 'local'
  const isSubtitleSource = isLocal && (isSubtitleSourceName(fileName) || isSubtitleSourceName(videoUrl || ''))
  const isDocumentSource = isLocal && (isDocumentSourceName(fileName) || isDocumentSourceName(videoUrl || ''))
  const qualityOptions = [
    { value: 'fast', label: '较小' },
    { value: 'medium', label: '标准' },
    { value: 'slow', label: '高清' },
  ] as const
  const qualityIndex = Math.max(0, qualityOptions.findIndex(item => item.value === quality))
  const frameModeOptions = [
    { value: 'dynamic', label: '动态关键帧' },
    { value: 'fixed', label: '固定间隔' },
  ] as const
  const frameModeIndex = frameMode === 'fixed' ? 1 : 0
  const reasoningLabels: Record<string, string> = {
    auto: '思考自动',
    none: '关闭思考',
    low: '思考低',
    medium: '思考中',
    high: '思考高',
    max: '思考最高',
  }
  const advancedSummary = [
    !isLocal ? `${qualityOptions[qualityIndex]?.label || '标准'}画质` : null,
    reasoningLabels[generationOptions.reasoning_effort] || '思考自动',
    extras?.trim() ? '已填补充要求' : null,
  ].filter(Boolean).join(' · ')
  const currentModelMeta = modelList.find(model => model.provider_id === providerId && model.model_name === modelName)
  const currentModelLabel = modelName
    ? modelDisplayName(currentModelMeta || { model_name: modelName })
    : (modelsLoading ? '加载模型…' : '选择模型')

  return (
    <Form {...form}>
      <form className={`generation-form composer-form ${editing ? 'composer-form--editing' : ''}`} onSubmit={form.handleSubmit(onSubmit, invalid)}>
        <div className="composer-card">
          {editing ? (
            <div className="composer-editing-source">
              <span className="composer-editing-source-tag">
                {isLocal ? <FileAudio size={13} strokeWidth={1.7} aria-hidden="true" /> : <Link2 size={13} strokeWidth={1.7} aria-hidden="true" />}
                <span>{isLocal ? '本地文件' : (platformLabels[platform] || '视频链接')}</span>
              </span>
              <span className="composer-editing-source-value" title={videoUrl || ''}>
                {videoUrl || '已关联原视频来源'}
              </span>
            </div>
          ) : (
            <>
              <div className="composer-card-head">
                <div
                  className="codex-segmented composer-source-segmented"
                  role="group"
                  aria-label="视频来源"
                  style={{ '--segment-count': 2, '--segment-index': isLocal ? 1 : 0 } as CSSProperties}
                >
                  <span className="codex-segmented-thumb" aria-hidden="true" />
                  <button
                    type="button"
                    className={`codex-segmented-tab ${!isLocal ? 'is-active' : ''}`}
                    disabled={locked}
                    aria-pressed={!isLocal}
                    onClick={() => switchSource(false)}
                  >
                    <Link2 size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span>视频链接</span>
                  </button>
                  <button
                    type="button"
                    className={`codex-segmented-tab ${isLocal ? 'is-active' : ''}`}
                    disabled={locked}
                    aria-pressed={isLocal}
                    onClick={() => switchSource(true)}
                  >
                    <FileAudio size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span>本地文件</span>
                  </button>
                </div>

                {!isLocal ? (
                  <div className="composer-platform-chip">
                    <FormField
                      control={form.control}
                      name="platform"
                      render={({ field }) => (
                        <FormItem>
                          <Select value={field.value} onValueChange={field.onChange} disabled={locked}>
                            <SelectTrigger aria-label="视频平台" className="composer-mini-select rounded-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {platforms.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="composer-head-link"
                    disabled={locked}
                    onClick={() => setPathRequested(open => !open)}
                  >
                    {pathOpen ? '隐藏路径输入' : '填写本地路径'}
                  </button>
                )}
              </div>

              <div className="composer-card-body">
                {!isLocal && (
                  <FormField
                    control={form.control}
                    name="video_url"
                    render={({ field }) => (
                      <FormItem className="composer-url-field">
                        <div className="composer-url-row">
                          <FormControl>
                            <Input
                              {...field}
                              className="composer-url-input"
                              disabled={locked}
                              aria-label="视频链接"
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              enterKeyHint="done"
                              placeholder="粘贴视频、X、小宇宙播客或网页文章链接，自动识别来源…"
                              onChange={event => handleUrlInput(event.target.value, field.onChange)}
                            />
                          </FormControl>
                          {Boolean(field.value) && !locked && (
                            <>
                              {platforms.find(item => item.value === platform)?.supportsCollection !== false && (
                                <button
                                  type="button"
                                  className="composer-collection-trigger"
                                  disabled={resolvingCollection || batchSubmitting}
                                  title="解析多 P 合集或播放列表"
                                  onClick={() => void triggerResolveCollection(field.value || '')}
                                >
                                  {resolvingCollection ? (
                                    <Loader2 size={12} className="generation-spin" aria-hidden="true" />
                                  ) : (
                                    <Layers size={12} strokeWidth={1.75} aria-hidden="true" />
                                  )}
                                  <span>{resolvingCollection ? '解析中…' : '解析合集'}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className="composer-url-clear"
                                aria-label="清空链接"
                                title="清空链接"
                                onClick={() => { field.onChange(''); setExtractHint(''); setCollectionResolution(null) }}
                              >
                                <X size={13} strokeWidth={1.75} aria-hidden="true" />
                              </button>
                            </>
                          )}
                        </div>
                        {extractHint && <p className="composer-extract-hint" role="status"><Sparkles size={12} strokeWidth={1.7} aria-hidden="true" /><span>{extractHint}</span></p>}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {!isLocal && collectionResolution && (
                  <CollectionImportPanel
                    resolution={collectionResolution}
                    modelLabel={currentModelLabel}
                    submitting={batchSubmitting}
                    disabled={locked}
                    onDismiss={() => setCollectionResolution(null)}
                    onSubmitBatch={handleBatchSubmit}
                  />
                )}

                {isLocal && (
                  <div className="composer-local-stack">
                    <input
                      ref={fileInput}
                      type="file"
                      accept="video/*,audio/*,.srt,.vtt,.pdf,.md,.markdown,.txt"
                      hidden
                      disabled={locked}
                      onChange={event => {
                        const file = event.target.files?.[0]
                        if (file) void upload(file)
                        event.target.value = ''
                      }}
                    />
                    <button
                      className={`composer-upload ${draggingFile ? 'is-dragging' : ''} ${fileName && !uploading && uploadProgress === 100 ? 'is-ready' : ''}`}
                      type="button"
                      disabled={locked}
                      onClick={() => fileInput.current?.click()}
                      onDragOver={event => { event.preventDefault(); if (!draggingFile) setDraggingFile(true) }}
                      onDragLeave={() => setDraggingFile(false)}
                      onDrop={event => {
                        event.preventDefault()
                        setDraggingFile(false)
                        if (event.dataTransfer.files[0]) void upload(event.dataTransfer.files[0])
                      }}
                    >
                      <span className="composer-upload-icon" aria-hidden="true">
                        {uploading ? <Loader2 size={18} className="generation-spin" /> : (isSubtitleSource || isDocumentSource) ? <FileText size={18} strokeWidth={1.65} /> : <UploadCloud size={18} strokeWidth={1.65} />}
                      </span>
                      <span className="composer-upload-copy">
                        <strong>{uploading ? `正在上传${uploadProgress === null ? '…' : ` · ${uploadProgress}%`}` : fileName || '拖入音视频、字幕或文档，或点击选择'}</strong>
                        <span>
                          {isSubtitleSource
                            ? '已识别字幕文件，将跳过转写直接生成'
                            : isDocumentSource
                              ? '已识别本地文档，将跳过转写直接生成'
                              : fileName && !uploading && uploadProgress === 100
                                ? '文件已就绪，可直接开始生成'
                                : '支持 MP4、MKV、MP3、M4A、SRT、VTT、PDF、MD、TXT'}
                        </span>
                      </span>
                      {uploading && <progress className="composer-upload-progress" max="100" value={uploadProgress ?? undefined} aria-label="文件上传进度" />}
                    </button>
                    {(isSubtitleSource || isDocumentSource) && (
                      <p className="composer-subtitle-pill" role="status">
                        <Sparkles size={12} strokeWidth={1.7} aria-hidden="true" />
                        <span>{isDocumentSource ? '已识别本地文档，将跳过转写直接生成' : '已识别字幕文件，将跳过转写直接生成'}</span>
                      </p>
                    )}
                    {pathOpen && (
                      <FormField
                        control={form.control}
                        name="video_url"
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                {...field}
                                className="composer-path-input"
                                disabled={locked}
                                aria-label="本地视频路径"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder="填写本机文件完整路径，例如 D:\Videos\lesson.mp4"
                                onChange={event => handleUrlInput(event.target.value, field.onChange)}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="composer-card-foot">
            <div className="composer-controls-left">
              <div className="composer-model-group">
                <FormField
                  control={form.control}
                  name="model_name"
                  render={({ field }) => (
                    <FormItem className="composer-model-item">
                      <Select
                        value={providerId && field.value ? JSON.stringify([providerId, field.value]) : ''}
                        onValueChange={pickModel}
                        onOpenChange={open => { if (open) void loadModels() }}
                        disabled={locked || (!modelList.length && modelsLoading)}
                      >
                        <FormControl>
                          <SelectTrigger aria-label="生成模型" className="composer-model-trigger rounded-full">
                            <Sparkles size={13} strokeWidth={1.7} className="composer-model-icon" aria-hidden="true" />
                            <SelectValue placeholder={modelsLoading ? '加载模型…' : '选择模型'}>
                              {currentModelLabel}
                            </SelectValue>
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {modelList.map(model => (
                            <SelectItem
                              key={`${model.provider_id}:${model.model_name}`}
                              value={JSON.stringify([model.provider_id, model.model_name])}
                              title={model.model_name}
                            >
                              {modelDisplayName(model)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <button
                  type="button"
                  className="composer-icon-btn"
                  aria-label="刷新模型列表"
                  title="刷新模型列表"
                  disabled={modelsLoading || locked}
                  onClick={() => void loadModels({ force: true })}
                >
                  <RefreshCw size={13} strokeWidth={1.7} className={modelsLoading ? 'generation-spin' : ''} aria-hidden="true" />
                </button>
              </div>

              <div className="composer-toggle-chips" role="group" aria-label="视觉增强选项">
                <FormField
                  control={form.control}
                  name="format"
                  render={({ field }) => {
                    const checked = field.value?.includes('screenshot') || false
                    return (
                      <FormItem>
                        <label
                          className={`composer-chip-toggle ${checked ? 'is-checked' : ''} ${locked ? 'is-disabled' : ''}`}
                          title="动态选取原片关键画面插入笔记"
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            disabled={locked}
                            checked={checked}
                            onChange={event => field.onChange(event.target.checked ? ['link', 'screenshot'] : ['link'])}
                          />
                          <ImageIcon size={13} strokeWidth={1.7} aria-hidden="true" />
                          <span>自动配图</span>
                        </label>
                      </FormItem>
                    )
                  }}
                />
                <FormField
                  control={form.control}
                  name="video_understanding"
                  render={({ field }) => {
                    const checked = Boolean(field.value)
                    return (
                      <FormItem>
                        <label
                          className={`composer-chip-toggle ${checked ? 'is-checked' : ''} ${locked ? 'is-disabled' : ''}`}
                          title="将原片关键帧交给多模态模型理解"
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            disabled={locked}
                            checked={checked}
                            onChange={event => field.onChange(event.target.checked)}
                          />
                          <ScanEye size={13} strokeWidth={1.7} aria-hidden="true" />
                          <span>画面理解</span>
                        </label>
                      </FormItem>
                    )
                  }}
                />
              </div>
            </div>

            <div className="composer-actions-right">
              {editing && (
                <button type="button" className="composer-secondary-btn" onClick={() => navigate('/?view=create')}>
                  新建一篇
                </button>
              )}
              {pending && !submitting ? (
                <button type="button" className="composer-primary-btn" disabled={checking} onClick={() => void checkPending()}>
                  {checking ? <Loader2 size={14} className="generation-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                  <span>检查状态</span>
                </button>
              ) : (
                <button type="submit" className="composer-primary-btn" disabled={locked || (!modelList.length && modelsLoading)}>
                  {(submitting || generating) ? (
                    <Loader2 size={14} className="generation-spin" aria-hidden="true" />
                  ) : (
                    <ArrowUp size={15} strokeWidth={2} aria-hidden="true" />
                  )}
                  <span>{submitting ? '正在提交…' : generating ? '正在生成' : editing ? '生成新版本' : '开始生成'}</span>
                </button>
              )}
            </div>
          </div>

          {(modelsError || (!modelList.length && !modelsLoading) || submitting || uploading || generating || notice) && (
            <div className="composer-card-status" aria-live="polite">
              {notice && <p role="alert" className="generation-error">{notice}</p>}
              {modelsError && <p className="generation-inline-note">{modelsError}</p>}
              {!modelList.length && !modelsLoading && <p className="generation-inline-note">请先在左侧「设置 · 模型与 API」中添加可用模型。</p>}
              {submitting && (
                <p className="generation-submit-state">
                  <Loader2 size={13} className="generation-spin" aria-hidden="true" />
                  <span>正在确认任务已接收{now - submittedAt >= 1000 ? ` · ${Math.floor((now - submittedAt) / 1000)} 秒` : '…'}</span>
                </p>
              )}
              {!submitting && uploading && <p className="generation-submit-state">文件上传完成后即可生成</p>}
              {!submitting && !uploading && generating && <p className="generation-submit-state">这篇笔记正在生成，可返回查看进度</p>}
            </div>
          )}
        </div>

        <FormField
          control={form.control}
          name="style"
          render={({ field }) => (
            <FormItem className="composer-style-section">
              <div className="composer-style-grid" role="radiogroup" aria-label="笔记类型">
                {([
                  { value: 'tutorial', title: '教程笔记', description: '保留实操顺序，前置关键避坑', Icon: ListChecks },
                  { value: 'knowledge', title: '知识笔记', description: '打破时间流水账，按概念体系重组', Icon: BookOpen },
                ] as const).map(item => {
                  const active = field.value === item.value
                  const Icon = item.Icon
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      key={item.value}
                      className={`composer-style-card ${active ? 'is-active' : ''}`}
                      disabled={locked}
                      onClick={() => field.onChange(item.value)}
                    >
                      <span className="composer-style-icon" aria-hidden="true">
                        <Icon size={15} strokeWidth={1.7} />
                      </span>
                      <span className="composer-style-copy">
                        <strong>{item.title}</strong>
                        <span>{item.description}</span>
                      </span>
                      <span className="composer-style-check" aria-hidden="true">
                        {active && <Check size={12} strokeWidth={2.2} />}
                      </span>
                    </button>
                  )
                })}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />

        <details
          className="composer-advanced"
          open={creating ? draft.advancedOpen : undefined}
          onToggle={event => { if (creating) draft.update({ advancedOpen: event.currentTarget.open }) }}
        >
          <summary className="composer-advanced-summary">
            <span className="composer-advanced-title">
              <SlidersHorizontal size={13} strokeWidth={1.7} aria-hidden="true" />
              <span>进阶设置与补充要求</span>
            </span>
            <span className="composer-advanced-meta">
              {advancedSummary && <span className="composer-advanced-pill">{advancedSummary}</span>}
              <ChevronDown size={14} strokeWidth={1.75} className="composer-advanced-chevron" aria-hidden="true" />
            </span>
          </summary>

          <div className="composer-advanced-body">
            <FormField
              control={form.control}
              name="extras"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="composer-field-label">补充要求</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      className="composer-textarea"
                      disabled={locked}
                      placeholder="例如：重点记录参数、菜单路径与避坑细节"
                      rows={2}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="composer-segmented-row">
              {!isLocal && (
                <FormField
                  control={form.control}
                  name="quality"
                  render={({ field }) => (
                    <FormItem className="composer-segmented-item">
                      <FormLabel className="composer-field-label">下载质量</FormLabel>
                      <div
                        className="codex-segmented composer-inline-segmented"
                        role="radiogroup"
                        aria-label="下载质量"
                        style={{ '--segment-count': 3, '--segment-index': qualityIndex } as CSSProperties}
                      >
                        <span className="codex-segmented-thumb" aria-hidden="true" />
                        {qualityOptions.map(opt => (
                          <button
                            key={opt.value}
                            type="button"
                            role="radio"
                            aria-checked={field.value === opt.value}
                            disabled={locked}
                            className={`codex-segmented-tab ${field.value === opt.value ? 'is-active' : ''}`}
                            onClick={() => field.onChange(opt.value)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="frame_mode"
                render={({ field }) => {
                  const disabledFrame = locked || (!vision && !format?.includes('screenshot'))
                  return (
                    <FormItem className="composer-segmented-item">
                      <FormLabel className="composer-field-label">取帧方式</FormLabel>
                      <div
                        className={`codex-segmented composer-inline-segmented ${disabledFrame ? 'is-disabled' : ''}`}
                        role="radiogroup"
                        aria-label="取帧方式"
                        style={{ '--segment-count': 2, '--segment-index': frameModeIndex } as CSSProperties}
                      >
                        <span className="codex-segmented-thumb" aria-hidden="true" />
                        {frameModeOptions.map(opt => (
                          <button
                            key={opt.value}
                            type="button"
                            role="radio"
                            aria-checked={field.value === opt.value}
                            disabled={disabledFrame}
                            className={`codex-segmented-tab ${field.value === opt.value ? 'is-active' : ''}`}
                            onClick={() => field.onChange(opt.value)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </FormItem>
                  )
                }}
              />

              {frameMode === 'fixed' && (
                <FormField
                  control={form.control}
                  name="video_interval"
                  render={({ field }) => (
                    <FormItem className="composer-interval-item">
                      <FormLabel className="composer-field-label">间隔（秒）</FormLabel>
                      <Input {...field} type="number" min={1} max={30} disabled={locked} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <GenerationOptionsFields value={generationOptions} onChange={setGenerationOptions} disabled={locked} compactMode />

            <div className="generation-details-actions">
              <button
                type="button"
                className="generation-secondary"
                disabled={locked || !providerId || !modelName}
                onClick={() => {
                  try {
                    saveGenerationDefaults(providerId, modelName || '', generationOptions)
                    toast.success('已保存该模型的生成默认值')
                  } catch {
                    toast.error('未能保存默认值，请检查本地存储')
                  }
                }}
              >
                存为该模型默认
              </button>
              <button
                type="button"
                className="generation-secondary"
                disabled={locked}
                onClick={() => setGenerationOptions(readGenerationDefaults(providerId, modelName || ''))}
              >
                恢复默认
              </button>
            </div>
          </div>
        </details>
      </form>
    </Form>
  )
}
