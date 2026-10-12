import { lazy, Suspense, useEffect, useState } from 'react'
import { Check, Clock3, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import type { Task } from '@/store/taskStore'
import { generationElapsed, generationPhase, generationStages as stages, generationTitle } from '@/utils/taskProgress'
import { hasReadableContent } from '@/utils/readingStatus'
const GenerationDetailsDialog = lazy(() => import('./GenerationDetailsDialog'))
import './generation.css'

const duration = (ms: number) => { const seconds = Math.max(0, Math.floor(ms/1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds/60)} 分 ${seconds%60} 秒` }
export default function GenerationProgress({ task, onRetry, onResume }: { task: Task; onRetry: () => Promise<void>; onResume?: () => Promise<void> }) {
  const [now,setNow] = useState(Date.now())
  const [retrying,setRetrying] = useState(false)
  const [detailsOpen,setDetailsOpen] = useState(false)
  const failed = task.status === 'FAILED'
  const terminal = failed || task.status === 'SUCCESS'
  const current = generationPhase(task)
  const elapsed = generationElapsed(task, now)
  const recent = task.lastStatusAt ? now-task.lastStatusAt : Infinity
  useEffect(() => { if (terminal) return; const timer=setInterval(()=>setNow(Date.now()),1000); return()=>clearInterval(timer) }, [task.id, terminal])
  useEffect(() => { if (!terminal) window.dispatchEvent(new Event('bilinote-refresh-task')) }, [task.id, terminal])
  return <section className="generation-progress" data-running={!failed && task.status !== 'SUCCESS'} aria-label="视频笔记生成进度"><div className="generation-progress-inner">
    <div className="generation-progress-header"><div className="generation-progress-icon">{failed ? <TriangleAlert size={22}/> : task.status === 'PENDING' ? <Clock3 size={22}/> : terminal ? <Check size={22}/> : <Loader2 size={22} className="generation-spin"/>}</div><div><h2>{failed ? '这次生成未完成' : current.title}</h2><p>{generationTitle(task)}</p></div></div>
    <div className="generation-stage-track" role="progressbar" aria-label="当前生成阶段" aria-valuetext={failed ? current.index < 0 ? '生成未完成，未记录失败阶段' : `生成未完成，停在${stages[current.index]}` : current.title}>{stages.map((name,index)=><span key={name} className={index<current.index ? 'is-done' : index===current.index ? 'is-current' : ''}/>)}</div>
    <ol className="generation-stage-list">{stages.map((name,index)=><li key={name} className={index<current.index ? 'is-done' : index===current.index ? 'is-current' : ''} aria-current={index===current.index ? 'step' : undefined}>{index<current.index ? <Check size={12}/> : <span>{String(index+1).padStart(2,'0')}</span>}{name}</li>)}</ol>
    <div className="generation-progress-detail"><p aria-live="polite">{task.statusMessage || (failed ? '后台未能完成本次任务，请检查设置后重试。' : current.detail)}</p>{failed && <p>{current.index < 0 ? '此历史任务未记录失败阶段' : `停止阶段：${stages[current.index]}`}</p>}<div className="generation-progress-meta"><span>{elapsed === undefined ? terminal ? '未记录完整耗时' : '等待开始时间' : `${terminal ? '用时' : '已用'} ${duration(elapsed)}`}</span><span>{terminal ? '任务已结束' : task.lastStatusAt ? `上次更新：${recent < 3000 ? '刚刚' : `${Math.floor(recent/1000)} 秒前`}` : '等待首次状态回传'}</span><span>{task.formData.model_name}</span></div>{!terminal && task.pollingError && <p className="generation-progress-error">进度暂时未能更新，后台任务可能仍在处理。{task.pollingError}</p>}</div>
    {task.status === 'SUBMISSION_UNKNOWN' && <p>正在自动核对是否受理。若请求没有送达，可继续提交本次请求；会复用同一请求编号。</p>}
    <div className="generation-progress-actions"><span>{failed ? hasReadableContent(task) ? '已保存的笔记版本仍然保留' : '本次未保存笔记正文' : terminal ? '笔记已保存' : '可以切换页面，任务会继续处理'}</span><button type="button" onClick={()=>setDetailsOpen(true)}>生成详情</button>{failed && <button disabled={retrying || Boolean(task.archived_at)} onClick={()=>{setRetrying(true); void onRetry().catch(()=>undefined).finally(()=>setRetrying(false))}}>{retrying ? <Loader2 size={13} className="generation-spin"/> : <RefreshCw size={13}/>}重新生成</button>}{task.status === 'SUBMISSION_UNKNOWN' && onResume && <button disabled={retrying || task.submissionInFlight} onClick={()=>{setRetrying(true);void onResume().catch(()=>undefined).finally(()=>setRetrying(false))}}>继续提交本次请求</button>}</div>
    {detailsOpen && <Suspense fallback={<p role="status">读取生成详情…</p>}><GenerationDetailsDialog key={task.id} taskId={task.id} versionId="" modelName={task.formData.model_name} allowComparison={false} pollGenerationRuns={!terminal} onClose={()=>setDetailsOpen(false)} /></Suspense>}
  </div></section>
}
