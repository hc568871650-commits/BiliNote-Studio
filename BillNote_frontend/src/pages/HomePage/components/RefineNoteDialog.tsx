import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import gfm from 'remark-gfm'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import PurposeModelPicker from '@/components/PurposeModelPicker'
import { usePurposeModelStore, type PurposeModelSelection } from '@/store/purposeModelStore'
import { useProviderProtocolStore } from '@/store/providerProtocolStore'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import type { Task } from '@/store/taskStore'
import { getRefinementContext, previewRefinement, applyRefinement, type RefinementContext, type RefinementPreview } from '@/services/noteRefinement'
import './refine-note.css'

interface Props {
  task: Task; versionId: string; texts: string[]; originalModel: PurposeModelSelection | null
  originalProtocol?: ProviderProtocol
  onClose: () => void; onApplied: (task: Task) => void
}
const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const frameReasons: Record<string, string> = { coverage:'时间段取样',stable_frame:'稳定画面',local_parameter_change:'局部变化',scene_change:'画面切换',subtitle_operation:'操作提示',fixed_interval:'定时取样' }
const frameReason = (reason: string) => reason.split(',').map(value => frameReasons[value.trim()] || value.trim()).join(' · ')
const errorMessage = (error: unknown) => {
  const value = error as { msg?: string; message?: string }
  return value?.msg || value?.message || '请求失败，请稍后重试'
}

export default function RefineNoteDialog({ task, versionId, texts, originalModel, originalProtocol, onClose, onApplied }: Props) {
  const readingDefault = usePurposeModelStore(state => state.defaults.reading)
  const [model, setModel] = useState<PurposeModelSelection | null>(originalModel || readingDefault)
  const providerProtocol = useProviderProtocolStore(state => state.protocols[model?.provider_id || ''] || 'openai-chat')
  const protocol = originalProtocol && originalModel?.provider_id === model?.provider_id && originalModel?.model_name === model?.model_name ? originalProtocol : providerProtocol
  const [context, setContext] = useState<RefinementContext | null>(null)
  const [draft, setDraft] = useState<RefinementPreview | null>(null)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [instruction, setInstruction] = useState('')
  const [useVideo, setUseVideo] = useState(false)
  const [phase, setPhase] = useState<'context' | 'idle' | 'preview' | 'apply'>('context')
  const [error, setError] = useState('')
  const [contextAttempt, setContextAttempt] = useState(0)
  const epoch = useRef(0)
  const requestBusy = useRef(false)
  const selection = { version_id: versionId, texts }
  const busy = phase !== 'idle'
  useEffect(() => {
    const requestId = ++epoch.current
    setPhase('context'); setError('')
    getRefinementContext(task.id, { version_id: versionId, texts }).then(value => {
      if (epoch.current !== requestId) return
      setContext(value)
      setStart(value.start_time == null ? '' : String(value.start_time))
      setEnd(value.end_time == null ? '' : String(value.end_time))
    }).catch(error => { if (epoch.current === requestId) setError(errorMessage(error)) })
      .finally(() => { if (epoch.current === requestId) setPhase('idle') })
    return () => {
      // Invalidate all requests, including previews started after context loaded.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++
    }
  }, [task.id, versionId, texts, contextAttempt])
  // A protocol change also changes what will be sent to the model.
  useEffect(() => { setDraft(null) }, [protocol])
  const generate = async () => {
    if (requestBusy.current || busy || !context || task.archived_at) return
    const startTime = Number(start), endTime = Number(end)
    if (!start.trim() || !end.trim() || !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) {
      setError('请输入有效时间范围：开始秒数 ≥ 0，结束秒数 > 开始秒数'); return
    }
    if (!model?.provider_id || !model.model_name) { setError('请先选择用于重新蒸馏的模型'); return }
    const requestId = ++epoch.current
    requestBusy.current = true
    setPhase('preview'); setError(''); setDraft(null)
    try {
      const result = await previewRefinement(task.id, { ...selection, start_time: startTime, end_time: endTime,
        instruction, ...model, protocol, use_video: useVideo && context.video_available })
      if (epoch.current === requestId) setDraft(result)
    } catch (error) { if (epoch.current === requestId) setError(errorMessage(error)) }
    finally { requestBusy.current = false; if (epoch.current === requestId) setPhase('idle') }
  }
  const apply = async () => {
    if (requestBusy.current || busy || !draft || task.archived_at) return
    const requestId = ++epoch.current
    requestBusy.current = true
    setPhase('apply'); setError('')
    try {
      const updated = await applyRefinement(task.id, draft.draft_id)
      if (epoch.current === requestId) onApplied(updated)
    } catch (error) { if (epoch.current === requestId) setError(errorMessage(error)) }
    finally { requestBusy.current = false; if (epoch.current === requestId) setPhase('idle') }
  }
  const close = () => { if (phase !== 'apply') { epoch.current++; onClose() } }
  const resourceURL = (url: string) => {
    if (!url.startsWith('/')) return url
    const base = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/api\/?$/, '').replace(/\/$/, '')
    return base + url
  }
  const sourceResourceBase = Array.isArray(task.markdown) ? task.markdown.find(version => version.ver_id === versionId)?.resource_base || task.resource_base : task.resource_base
  const resolveImage = (src: string, revised: boolean) => {
    if (revised && src.startsWith('images/')) {
      const frame = draft?.evidence.frames.find(frame => frame.image_url.endsWith(`/${src.slice('images/'.length)}`))
      if (frame) return resourceURL(frame.image_url)
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) return src
    if (src.startsWith('/')) return resourceURL(src)
    return sourceResourceBase ? new URL(src, new URL(resourceURL(sourceResourceBase), window.location.origin)).toString() : src
  }
  const imageComponents = (revised: boolean) => ({ img: (props: object) => {
    const src = 'src' in props && typeof props.src === 'string' ? props.src : ''
    const alt = 'alt' in props && typeof props.alt === 'string' ? props.alt : '来源截图'
    return <img src={resolveImage(src, revised)} alt={alt} loading="lazy" />
  } })
  return <Dialog open onOpenChange={open => { if (!open) close() }}>
    <DialogContent className="refine-note-dialog" showCloseButton={phase !== 'apply'} onEscapeKeyDown={event => { if (phase === 'apply') event.preventDefault() }} onPointerDownOutside={event => event.preventDefault()}>
      <DialogTitle>重新蒸馏选中段落</DialogTitle>
      <DialogDescription>根据原字幕和可用画面补充步骤、依据与核验方法。比较修订稿后，采纳并保存为新版本。</DialogDescription>
      <div className="refine-note-body">
        <fieldset disabled={busy || Boolean(task.archived_at)} className="refine-note-settings">
          <div className="refine-note-range"><label>开始（秒）<input type="number" min="0" step="0.1" value={start} onChange={event => { setStart(event.target.value); setDraft(null) }} /></label><label>结束（秒）<input type="number" min="0" step="0.1" value={end} onChange={event => { setEnd(event.target.value); setDraft(null) }} /></label><span>{context ? `${context.transcript_count} 条来源字幕` : '正在定位来源…'}</span></div>
          {context && (context.start_time == null || context.end_time == null) && <p className="refine-note-hint">选中内容没有可定位时间，请按原视频输入开始和结束秒数。</p>}
          <label className="refine-note-instruction">补充要求<textarea rows={3} placeholder="例如：逐步说明软件操作、参数、原因和常见错误；不要补写来源未支持的结论。" value={instruction} onChange={event => { setInstruction(event.target.value); setDraft(null) }} /></label>
          <div className="refine-note-model"><PurposeModelPicker label="重新蒸馏模型" value={model} disabled={busy || Boolean(task.archived_at)} onChange={value => { setModel(value); setDraft(null) }} /><label><input type="checkbox" checked={useVideo} disabled={!context?.video_available || busy} onChange={event => { setUseVideo(event.target.checked); setDraft(null) }} />分析画面</label><span className="refine-note-hint">{context?.video_available ? '开启后结合关键帧分析' : '没有可用视频，使用字幕分析'}</span></div>
        </fieldset>
        {error && <div role="alert" className="refine-note-error">{error}{!context && phase === 'idle' && <button onClick={() => setContextAttempt(value => value + 1)}>重新定位来源</button>}</div>}
        <div className="refine-note-compare"><section><h3>原文</h3><div className="markdown-body"><ReactMarkdown remarkPlugins={[gfm]} skipHtml components={imageComponents(false)}>{draft?.before || context?.before || texts.join('\n\n')}</ReactMarkdown></div></section><section><h3>修订稿</h3>{draft ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[gfm]} skipHtml components={imageComponents(true)}>{draft.after}</ReactMarkdown></div> : <p className="refine-note-hint">{phase === 'preview' ? '正在根据来源生成修订稿，请稍候…' : '生成后在这里比较，再决定是否采纳。'}</p>}</section></div>
        {draft && <details className="refine-note-evidence" open><summary>来源依据 · {timeLabel(draft.start_time!)}–{timeLabel(draft.end_time!)} · {draft.evidence.transcript.length} 条字幕 · {draft.evidence.frames.length} 张关键帧</summary><div className="refine-note-subtitles">{draft.evidence.transcript.map((segment, index) => <p key={index}><time>{timeLabel(segment.start)}–{timeLabel(segment.end)}</time>{segment.text}</p>)}</div><div className="refine-note-frames">{draft.evidence.frames.map((frame, index) => <figure key={index}><img src={resourceURL(frame.image_url)} alt={`来源关键帧 ${timeLabel(frame.time)}`} loading="lazy" /><figcaption>{timeLabel(frame.time)} · {frameReason(frame.reason)}</figcaption></figure>)}</div></details>}
      </div>
      <div className="refine-note-actions"><span role="status">{phase === 'context' ? '定位来源中…' : phase === 'preview' ? '正在生成（最多等待 180 秒）' : phase === 'apply' ? '保存新版本中…' : ''}</span><button onClick={close} disabled={phase === 'apply'}>关闭</button><button onClick={() => void generate()} disabled={busy || !context || !model || Boolean(task.archived_at)}>生成修订稿</button><button className="refine-note-accept" onClick={() => void apply()} disabled={busy || !draft || Boolean(task.archived_at)}>采纳并保存新版本</button></div>
    </DialogContent>
  </Dialog>
}
