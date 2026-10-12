import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch, type FieldErrors } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight, BookOpen, Check, FileVideo, Layers, Link2, Loader2, RefreshCw, UploadCloud } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { generateNote, get_task_status, type GenerateNotePayload } from '@/services/note'
import { uploadFile } from '@/services/upload'
import { useTaskStore, type Task } from '@/store/taskStore'
import { useModelStore } from '@/store/modelStore'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import { normalizeNoteStyle, normalizeNoteFormats } from '@/utils/noteGeneration'
import GenerationOptionsFields from '@/components/GenerationOptionsFields'
import { normalizeGenerationOptions, readGenerationDefaults, saveGenerationDefaults } from '@/utils/generationOptions'
import type { GenerationOptions } from '@/services/generationRuns'
import './generation.css'

const withScheme = (url: string) => /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url.trim() : `https://${url.trim()}`
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
type FormInput = z.input<typeof schema>
const errorText = (error: unknown) => { const e = error as { msg?: string; message?: string }; return e?.msg || e?.message || '暂时无法连接服务，请稍后重试' }
const platforms = [{ value: 'bilibili', label: '哔哩哔哩' }, { value: 'youtube', label: 'YouTube' }, { value: 'kuaishou', label: '快手' }]
const inferPlatform = (value: string) => { try { const host = new URL(withScheme(value)).hostname; return /(^|\.)(bilibili\.com|b23\.tv)$/.test(host) ? 'bilibili' : /(^|\.)(youtube\.com|youtu\.be)$/.test(host) ? 'youtube' : /(^|\.)(kuaishou\.com|gifshow\.com)$/.test(host) ? 'kuaishou' : null } catch { return null } }

export default function NoteForm({ onSubmitted, creating = false }: { onSubmitted?: () => void; creating?: boolean }) {
  const navigate = useNavigate()
  const currentTask = useTaskStore(state => creating ? null : state.tasks.find(task => task.id === state.currentTaskId) || null)
  const generationModel = usePurposeModelStore(state => state.defaults.generation)
  const modelList = useModelStore(state => state.modelList)
  const modelsLoading = useModelStore(state => state.enabledLoading)
  const modelsError = useModelStore(state => state.enabledError)
  const loadModels = useModelStore(state => state.loadEnabledModels)
  const [providerId, setProviderId] = useState(generationModel?.provider_id || '')
  const [generationOptions, setGenerationOptions] = useState<GenerationOptions>(() => readGenerationDefaults(generationModel?.provider_id || '', generationModel?.model_name || ''))
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [fileName, setFileName] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<GenerateNotePayload | null>(null)
  const [submittedAt, setSubmittedAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const submitGuard = useRef(false)
  const uploadGuard = useRef(false)
  const alive = useRef(true)
  const uploadController = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const form = useForm<FormInput, unknown, NoteFormValues>({ resolver: zodResolver(schema), defaultValues: {
    video_url: '', platform: 'bilibili', model_name: generationModel?.model_name || '', style: 'tutorial', quality: 'medium',
    format: ['link', 'screenshot'], extras: '', video_understanding: false, frame_mode: 'dynamic', video_interval: 6, grid_size: [2, 2],
  } })
  const platform = useWatch({ control: form.control, name: 'platform' })
  const style = useWatch({ control: form.control, name: 'style' })
  const format = useWatch({ control: form.control, name: 'format' })
  const vision = useWatch({ control: form.control, name: 'video_understanding' })
  const frameMode = useWatch({ control: form.control, name: 'frame_mode' })
  const modelName = useWatch({ control: form.control, name: 'model_name' })
  const editing = Boolean(currentTask)
  const generating = Boolean(currentTask && !['SUCCESS', 'FAILED'].includes(currentTask.status))
  const locked = submitting || checking || uploading || generating || Boolean(pending) || Boolean(currentTask?.archived_at)
  useEffect(() => {
    const data = currentTask?.formData as (Task['formData'] & { generation_options?: GenerationOptions }) | undefined
    setGenerationOptions(data?.provider_id === providerId && data.model_name === modelName && data.generation_options
      ? normalizeGenerationOptions(data.generation_options) : readGenerationDefaults(providerId, modelName || ''))
  }, [providerId, modelName, currentTask?.id])
  useEffect(() => { alive.current = true; void loadModels(); return () => { alive.current = false; uploadController.current?.abort() } }, [loadModels])
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
  }, [currentTask, form])
  useEffect(() => {
    if (creating && generationModel && !form.getFieldState('model_name').isDirty) {
      form.setValue('model_name', generationModel.model_name); setProviderId(generationModel.provider_id)
    }
  }, [creating, generationModel, form])

  const upload = async (file: File) => {
    if (uploadGuard.current || locked || editing) return
    uploadGuard.current = true
    const controller = new AbortController(); uploadController.current = controller
    setUploading(true); setUploadProgress(null); setFileName(file.name); setNotice('')
    try {
      const data = new FormData(); data.append('file', file)
      const result = await uploadFile(data, { signal: controller.signal, suppressToast: true, onUploadProgress: event => {
        if (alive.current && event.total) setUploadProgress(Math.min(100, Math.round(event.loaded / event.total * 100)))
      } })
      if (alive.current) { form.setValue('video_url', result.url, { shouldValidate: true }); setUploadProgress(100) }
    } catch (error) { if (alive.current && !controller.signal.aborted) setNotice(`上传未完成：${errorText(error)}`) }
    finally { uploadGuard.current = false; if (alive.current) setUploading(false) }
  }
  const accepted = (payload: GenerateNotePayload) => {
    const store = useTaskStore.getState()
    const selectedBefore = store.currentTaskId
    if (!store.tasks.some(task => task.id === payload.task_id)) store.addPendingTask(payload.task_id!, payload.platform, payload)
    else {
      store.updateTaskContent(payload.task_id!, { status: 'PENDING', last_active_status: 'PENDING', started_at: undefined, finished_at: undefined, status_updated_at: undefined, formData: payload as Task['formData'], attemptStartedAt: Date.now(), phaseStartedAt: Date.now(), submissionError: undefined, pollingError: undefined, statusMessage: '已接收，等待处理' })
      store.setCurrentTask(payload.task_id!)
    }
    const added = useTaskStore.getState().tasks.find(task => task.id === payload.task_id)
    if (payload.platform === 'local' && fileName && added) store.updateTaskContent(payload.task_id!, { audioMeta: { ...added.audioMeta, title: fileName } })
    if (!alive.current) { store.setCurrentTask(selectedBefore); return }
    if (creating) { form.reset({ ...form.getValues(), video_url: '' }); setFileName(''); setUploadProgress(null) }
    setPending(null); setNotice(''); toast.success('任务已接收，可查看生成进度', { id: `submitted-${payload.task_id}` }); onSubmitted?.()
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
    const payload: GenerateNotePayload = { ...values, video_url: values.platform === 'local' ? values.video_url.trim() : withScheme(values.video_url),
      format: normalizeNoteFormats(values.format), link: true, screenshot: values.format.includes('screenshot'), provider_id: providerId,
      task_id: currentTask?.id || crypto.randomUUID(), request_id: crypto.randomUUID(), generation_options: normalizeGenerationOptions(generationOptions) }
    try {
      const response = await generateNote(payload, { timeout: 30000, suppressToast: true })
      if (!response?.task_id || response.task_id !== payload.task_id) throw new Error('尚未收到一致的任务编号')
      accepted(payload)
    } catch (error) {
      if (!alive.current) return
      const e = error as { code?: number; data?: { reason?: string } }
      if (e?.code === -1 || !e?.code || e.code >= 500) {
        setPending(payload); setNotice('本次提交尚未确认。后台可能已接收，请先检查任务状态。')
      } else {
        setNotice(errorText(error))
        if (e?.data?.reason === 'transcriber_model_not_ready') setNotice(`${errorText(error)}。请在设置 → 音频转写中检查。`)
      }
    } finally { submitGuard.current = false; if (alive.current) setSubmitting(false) }
  }
  const invalid = (errors: FieldErrors<FormInput>) => {
    setNotice(Object.values(errors).find(value => value?.message)?.message?.toString() || '请检查输入内容')
  }
  const switchSource = (local: boolean) => { if (!editing && !locked) { form.setValue('platform', local ? 'local' : 'bilibili'); form.setValue('video_url', ''); setFileName(''); setNotice('') } }
  const pickModel = (value: string) => { const [provider, model] = JSON.parse(value); setProviderId(provider); form.setValue('model_name', model, { shouldDirty: true, shouldValidate: true }) }

  return <Form {...form}><form className="generation-form" onSubmit={form.handleSubmit(onSubmit, invalid)}>
    <div className="generation-main">
      <section className="generation-section generation-source">
        <div className="generation-section-title"><span className="generation-step">01</span><h2>添加视频</h2><span className="generation-source-tabs" role="group" aria-label="视频来源"><button type="button" disabled={editing || locked} aria-pressed={platform !== 'local'} onClick={() => switchSource(false)}><Link2 size={14} />视频链接</button><button type="button" disabled={editing || locked} aria-pressed={platform === 'local'} onClick={() => switchSource(true)}><FileVideo size={14} />本地文件</button></span></div>
        <div className="generation-source-input">
          {platform !== 'local' && <FormField control={form.control} name="platform" render={({ field }) => <FormItem><Select value={field.value} onValueChange={field.onChange} disabled={editing || locked}><SelectTrigger aria-label="视频平台"><SelectValue /></SelectTrigger><SelectContent>{platforms.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></FormItem>} />}
          <FormField control={form.control} name="video_url" render={({ field }) => <FormItem className="generation-url"><FormControl><Input {...field} disabled={editing || locked} aria-label={platform === 'local' ? '本地视频路径' : '视频链接'} placeholder={platform === 'local' ? '填写本地路径，或选择下方文件' : '粘贴视频链接，自动识别支持的平台'} onChange={event => { field.onChange(event); if (platform !== 'local') { const detected = inferPlatform(event.target.value); if (detected) form.setValue('platform', detected) } }} /></FormControl><FormMessage /></FormItem>} />
        </div>
        {platform === 'local' && <><input ref={fileInput} type="file" accept="video/*,audio/*" hidden disabled={locked || editing} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '' }} /><button className="generation-upload" type="button" disabled={locked || editing} onClick={() => fileInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files[0]) void upload(event.dataTransfer.files[0]) }}><UploadCloud size={22} /><strong>{uploading ? `正在上传${uploadProgress === null ? '…' : ` · ${uploadProgress}%`}` : fileName || '拖入视频，或点击选择文件'}</strong><span>{fileName && !uploading && uploadProgress === 100 ? '文件已就绪' : '视频和音频文件均可上传'}</span>{uploading && <progress max="100" value={uploadProgress ?? undefined} aria-label="文件上传进度" />}</button></>}
      </section>
      <section className="generation-section">
        <div className="generation-section-title"><span className="generation-step">02</span><h2>选择笔记类型</h2></div>
        <FormField control={form.control} name="style" render={({ field }) => <FormItem><div className="generation-types" role="group" aria-label="笔记类型">{[{ value:'tutorial', title:'教程笔记', description:'保留操作顺序、关键参数与结果', icon:Layers }, { value:'knowledge', title:'知识笔记', description:'梳理概念、推理与重要例子', icon:BookOpen }].map(item => <button type="button" key={item.value} disabled={locked} aria-pressed={field.value === item.value} onClick={() => field.onChange(item.value)}><item.icon size={19} /><strong>{item.title}</strong><span>{item.description}</span>{field.value === item.value && <Check size={14} className="generation-type-check" />}</button>)}</div><FormMessage /></FormItem>} />
        <div className="generation-options">
          <FormField control={form.control} name="format" render={({ field }) => <FormItem><label><input type="checkbox" disabled={locked} checked={field.value?.includes('screenshot') || false} onChange={event => field.onChange(event.target.checked ? ['link','screenshot'] : ['link'])} /><span><strong>自动配图</strong><small>动态选择有用的原片画面</small></span></label></FormItem>} />
          <FormField control={form.control} name="video_understanding" render={({ field }) => <FormItem><label><input type="checkbox" disabled={locked} checked={field.value || false} onChange={event => field.onChange(event.target.checked)} /><span><strong>结合画面理解</strong><small>将关键帧交给支持看图的模型</small></span></label></FormItem>} />
        </div>
      </section>
      <details className="generation-advanced"><summary>更多设置与补充要求</summary><div className="generation-advanced-fields">
        <FormField control={form.control} name="extras" render={({ field }) => <FormItem><FormLabel>希望重点保留什么？</FormLabel><FormControl><Textarea {...field} disabled={locked} placeholder="例如：重点记录参数、菜单路径与作者的纠错过程" rows={3} /></FormControl></FormItem>} />
        <div className="generation-technical"><FormField control={form.control} name="frame_mode" render={({ field }) => <FormItem><FormLabel>取帧方式</FormLabel><Select value={field.value} onValueChange={field.onChange} disabled={locked || (!vision && !format?.includes('screenshot'))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dynamic">动态选择关键帧</SelectItem><SelectItem value="fixed">固定间隔（对照）</SelectItem></SelectContent></Select></FormItem>} />
        {frameMode === 'fixed' && <FormField control={form.control} name="video_interval" render={({ field }) => <FormItem><FormLabel>间隔（秒）</FormLabel><Input {...field} type="number" min={1} max={30} disabled={locked} /><FormMessage /></FormItem>} />}
        <FormField control={form.control} name="quality" render={({ field }) => <FormItem><FormLabel>下载质量</FormLabel><Select value={field.value} onValueChange={field.onChange} disabled={locked}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fast">较小文件</SelectItem><SelectItem value="medium">标准</SelectItem><SelectItem value="slow">较高质量</SelectItem></SelectContent></Select></FormItem>} /></div>
      </div></details>
    </div>
    <aside className="generation-review" aria-label="本次生成设置">
      <div className="generation-section-title"><span className="generation-step">03</span><h2>确认并生成</h2></div>
      <FormField control={form.control} name="model_name" render={({ field }) => <FormItem><FormLabel>生成模型</FormLabel><Select value={providerId && field.value ? JSON.stringify([providerId, field.value]) : ''} onValueChange={pickModel} onOpenChange={open => { if (open) void loadModels() }} disabled={locked || (!modelList.length && modelsLoading)}><FormControl><SelectTrigger aria-label="生成模型"><SelectValue placeholder={modelsLoading ? '正在加载模型…' : '选择模型'}>{field.value || (modelsLoading ? '正在加载模型…' : '选择模型')}</SelectValue></SelectTrigger></FormControl><SelectContent>{modelList.map(model => <SelectItem key={`${model.provider_id}:${model.model_name}`} value={JSON.stringify([model.provider_id, model.model_name])}>{model.model_name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>} />
      <div className="generation-model-actions"><button type="button" disabled={modelsLoading || locked} onClick={() => void loadModels({ force: true })}><RefreshCw size={12} className={modelsLoading ? 'generation-spin' : ''} />刷新模型</button><button type="button" onClick={() => navigate('/settings/model')}>模型设置</button></div>
      {modelsError && <p className="generation-inline-note">{modelsError}</p>}
      {!modelList.length && !modelsLoading && <p className="generation-inline-note">请先在模型设置中添加可用模型。</p>}
      <details className="generation-advanced"><summary>生成参数与费用</summary><div className="generation-advanced-fields">
        <GenerationOptionsFields value={generationOptions} onChange={setGenerationOptions} disabled={locked} />
        <p className="generation-details-muted">调整仅用于本次生成。只有点击保存，才会成为这个服务商与模型的默认值。</p>
        <div className="generation-details-actions"><button type="button" className="generation-secondary" disabled={locked || !providerId || !modelName} onClick={() => { try { saveGenerationDefaults(providerId, modelName || '', generationOptions); toast.success('已保存该模型的生成默认值') } catch { toast.error('未能保存默认值，请检查本地存储') } }}>保存为该模型默认</button><button type="button" className="generation-secondary" disabled={locked} onClick={() => setGenerationOptions(readGenerationDefaults(providerId, modelName || ''))}>恢复已保存默认</button></div>
      </div></details>
      <dl className="generation-summary"><div><dt>笔记</dt><dd>{style === 'knowledge' ? '知识笔记' : '教程笔记'}</dd></div><div><dt>配图</dt><dd>{format?.includes('screenshot') ? '自动选择' : '关闭'}</dd></div><div><dt>画面分析</dt><dd>{vision ? '开启' : '关闭'}</dd></div><div><dt>原片定位</dt><dd>自动保留</dd></div></dl>
      <p className="generation-inline-note">提交后可查看每个处理阶段，离开页面也会继续生成。</p>
      <div className="generation-submit-state" aria-live="polite">{submitting ? <><Loader2 size={15} className="generation-spin" /><span>正在确认任务已接收{now - submittedAt >= 1000 ? ` · ${Math.floor((now-submittedAt)/1000)} 秒` : '…'}</span></> : uploading ? '文件上传完成后即可生成' : generating ? '这篇笔记正在生成，可返回查看进度' : null}</div>
      {notice && <p role="alert" className="generation-error">{notice}</p>}
      {pending ? <button type="button" className="generation-primary" disabled={checking} onClick={() => void checkPending()}>{checking ? <Loader2 size={16} className="generation-spin" /> : <RefreshCw size={16} />}检查任务状态</button> : <button type="submit" className="generation-primary" disabled={locked || (!modelList.length && modelsLoading)}>{submitting || generating ? <Loader2 size={16} className="generation-spin" /> : <ArrowRight size={16} />}{submitting ? '正在提交…' : generating ? '正在生成' : editing ? '生成新版本' : '开始生成'}</button>}
      {editing && <button type="button" className="generation-secondary" onClick={() => navigate('/?view=create')}>创建另一篇笔记</button>}
      <span className="generation-footnote">{editing ? '生成完成后保留当前版本' : modelName ? '使用所选模型处理视频内容' : '选择模型后开始'}</span>
    </aside>
  </form></Form>
}
