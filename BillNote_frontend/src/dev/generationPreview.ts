import type { AxiosRequestConfig } from 'axios'
import type { Task } from '@/store/taskStore'

export type GenerationScenario = 'slow' | 'offline' | 'failed'
const query = new URLSearchParams(location.search).get('generation')
export const generationScenario: GenerationScenario | null = query === 'slow' || query === 'offline' || query === 'failed' ? query : null
interface GenerationFixture {
  mode: GenerationScenario
  startedAt: number
  statusChecks: number
  markdown: Task['markdown']
  transcript: Task['transcript']
}
type FixtureTask = Task & { generationFixture?: GenerationFixture }
const phases = [
  [0, 'PENDING', '模拟排队'], [5000, 'PARSING', '模拟解析链接'],
  [10000, 'DOWNLOADING', '模拟下载'], [17000, 'TRANSCRIBING', '模拟转写'],
  [27000, 'FORMATTING', '模拟整理格式'], [32000, 'SUMMARIZING', '模拟总结'],
  [40000, 'SAVING', '模拟保存'], [45000, 'SUCCESS', '模拟完成 · 无模型调用'],
] as const

export function startGenerationFixture(task: Task, mode: GenerationScenario, previous?: Task) {
  const fixtureTask = task as FixtureTask
  const versions = Array.isArray(task.markdown) ? task.markdown.map(version => ({ ...version, ver_id: `${task.id}-${task.formData.request_id || crypto.randomUUID()}` })) : task.markdown
  const oldVersions = Array.isArray(previous?.markdown) ? previous.markdown : []
  fixtureTask.generationFixture = {
    mode, startedAt: Date.now(), statusChecks: 0,
    markdown: Array.isArray(versions) ? [...versions, ...oldVersions] : versions, transcript: task.transcript,
  }
  task.started_at = new Date(fixtureTask.generationFixture.startedAt).toISOString()
  task.finished_at = undefined
  // Regeneration retains saved versions while the new fixture is pending.
  task.markdown = previous?.markdown || ''
  task.transcript = previous?.transcript || { full_text: '', language: '', raw: null, segments: [] }
  advanceGenerationFixture(task)
}

export function advanceGenerationFixture(task: Task, now = Date.now()) {
  const fixture = (task as FixtureTask).generationFixture
  if (!fixture) return false
  const failedPhases = [[0, 'SUMMARIZING', '【模拟】正在蒸馏笔记'], [6000, 'FAILED', '【模拟】笔记生成未完成：模型输出因长度限制被截断（finish_reason=length），未保存半截正文；请提高输出预算或缩小来源范围后手动重试。']] as const
  const timeline = fixture.mode === 'failed' ? failedPhases : phases
  const phase = [...timeline].reverse().find(([at]) => now - fixture.startedAt >= at) || timeline[0]
  const changed = task.status !== phase[1] || task.statusMessage !== phase[2]
  task.status = phase[1]
  task.statusMessage = phase[2]
  task.last_active_status = phase[1] === 'FAILED' ? 'SUMMARIZING' : phase[1] === 'SUCCESS' ? 'SAVING' : phase[1]
  task.status_updated_at = new Date(fixture.startedAt + phase[0]).toISOString()
  if (['FAILED', 'SUCCESS'].includes(task.status)) task.finished_at = task.status_updated_at
  task.phaseStartedAt = fixture.startedAt + phase[0]
  if (task.status === 'SUCCESS') {
    task.markdown = fixture.markdown
    task.transcript = fixture.transcript
  }
  return changed
}

export const hasGenerationFixture = (task: Task) => Boolean((task as FixtureTask).generationFixture)
export function generationTransportFailure(task: Task) {
  const fixture = (task as FixtureTask).generationFixture
  if (!fixture || task.status === 'SUCCESS') return false
  fixture.statusChecks++
  return fixture.mode === 'offline' && fixture.statusChecks <= 3
}

export function fixtureDelay(ms: number, signal?: AxiosRequestConfig['signal']) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('模拟等待已取消')); return }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', abort); reject(new Error('模拟等待已取消')) }
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', abort); resolve() }, ms)
    signal?.addEventListener?.('abort', abort)
  })
}
