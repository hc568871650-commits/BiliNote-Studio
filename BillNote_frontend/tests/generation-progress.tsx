import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import GenerationProgress from '../src/pages/HomePage/components/GenerationProgress'
import { generationElapsed, generationPhase, generationStatusLabel, generationTitle, mergeTaskSnapshot } from '../src/utils/taskProgress'
import type { Task } from '../src/store/taskStore'

const task = {
  id: 'failed',
  status: 'FAILED',
  statusMessage: '模型输出因长度限制被截断（finish_reason=length），未保存半截正文',
  last_active_status: 'SUMMARIZING',
  started_at: '2026-10-11T00:00:00Z',
  finished_at: '2026-10-11T00:00:06Z',
  audioMeta: { title: '真实视频名称' },
  markdown: '',
  formData: { model_name: 'test-model', platform: 'local', video_url: 'C:\\videos\\课程.mp4', request_id: 'one' },
} as Task

const render = (value: Task) => renderToStaticMarkup(<GenerationProgress task={value} onRetry={async () => undefined} />)
const html = render(task)
assert.ok(html.includes('aria-label="笔记生成进度"'), 'uses neutral progress label')
assert.ok(render({ ...task, cancelled: true }).includes('已取消生成'))
assert.ok(!render({ ...task, status: 'SUMMARIZING', cancelled: true }).includes('已取消生成'), 'running status must not display cancelled title')
assert.equal(generationStatusLabel({ ...task, cancelled: true }), '已取消')
assert.ok(render({ ...task, status: 'TRANSCRIBING' }).includes('取消生成'))
assert.ok(html.includes('finish_reason=length'))
assert.ok(html.includes('停止阶段：整理笔记'))
assert.ok(html.includes('用时 6 秒'))
assert.ok(!html.includes('本次未保存笔记正文'), 'does not hardcode unsaved body claim for all failures')
assert.ok(!html.includes('任务已结束'), 'removes duplicate terminal text')
assert.ok(!html.includes('test-model'), 'model name is deferred to details dialog')
assert.ok(html.includes('真实视频名称'))
assert.ok(html.includes('诊断与恢复'))
assert.ok(html.includes('重新生成'))
assert.ok(!html.includes('刷新进度'))
assert.ok(!html.includes('已保存的笔记版本仍然保留'))
assert.ok(!html.includes('正在同步最新状态'))
assert.ok(!html.includes('generation-spin'))
assert.ok(render({ ...task, markdown: [{ ver_id: 'v1', content: '旧版完整笔记', style: 'tutorial', model_name: 'm', created_at: '' }] }).includes('已保存的笔记版本仍然保留'))
assert.ok(render({ ...task, submissionInFlight: true }).includes('disabled=""'), 'retry is disabled while submission is in flight')

const pollingErrHtml = render({ ...task, status: 'SUMMARIZING', lastStatusAt: Date.now() - 5000, pollingError: '网络超时' })
assert.ok(pollingErrHtml.includes('上次更新：'), 'retains last update time when polling fails')
assert.ok(pollingErrHtml.includes('网络超时'))

const legacy = { ...task, last_active_status: undefined, finished_at: undefined }
assert.equal(generationPhase(legacy).index, -1)
assert.ok(render(legacy).includes('此历史任务未记录失败阶段'))
assert.ok(!render(legacy).includes('aria-current="step"'))
assert.ok(render(legacy).includes('未记录完整耗时'))
assert.equal(generationElapsed(task, Date.now()), 6000)
assert.equal(generationElapsed(task, Date.now() + 60000), 6000, 'failure elapsed never advances')
assert.equal(generationTitle({ ...task, audioMeta: { ...task.audioMeta, title: '' } }), '课程.mp4')
assert.equal(generationTitle({ ...task, audioMeta: { ...task.audioMeta, title: '' }, formData: { ...task.formData, platform: 'bilibili' } }), '视频标题待解析')

const otherAttempt = mergeTaskSnapshot(task, { ...legacy, statusMessage: undefined, formData: { ...task.formData, request_id: 'two' } })
assert.equal(otherAttempt.statusMessage, undefined, 'different attempts cannot borrow failure details')
assert.equal(mergeTaskSnapshot(task, { ...task, status: 'SUMMARIZING', statusMessage: 'old running response' }).status, 'FAILED', 'same-attempt detail arriving after failure never reactivates polling')
assert.equal(mergeTaskSnapshot({ ...task, status: 'SUBMISSION_UNKNOWN', formData: { ...task.formData, request_id: 'unconfirmed' } }, task).status, 'SUBMISSION_UNKNOWN', 'startup sync cannot discard the unconfirmed request')

const unknownUI = renderToStaticMarkup(
  <GenerationProgress
    task={{ ...task, status: 'SUBMISSION_UNKNOWN', submissionInFlight: false }}
    onRetry={async () => undefined}
    onResume={async () => undefined}
  />,
)
assert.ok(unknownUI.includes('继续提交本次请求'))
assert.ok(unknownUI.includes('复用同一请求编号'))
assert.ok(unknownUI.includes('诊断与恢复'))
assert.ok(!unknownUI.includes('生成详情</button>'))
assert.ok(!unknownUI.includes('刷新进度'))
assert.ok(!unknownUI.includes('重新生成'))

const archivedUnknownUI = renderToStaticMarkup(
  <GenerationProgress
    task={{ ...task, status: 'SUBMISSION_UNKNOWN', archived_at: '2026-10-12T00:00:00Z', submissionInFlight: false }}
    onRetry={async () => undefined}
    onResume={async () => undefined}
  />,
)
assert.match(archivedUnknownUI, /<button[^>]*disabled=""[^>]*>继续提交本次请求<\/button>/, 'resume is disabled for archived task')

for (const [status, expected] of Object.entries({
  PENDING: '等待中',
  PARSING: '准备中',
  DOWNLOADING: '获取视频',
  TRANSCRIBING: '转写中',
  SUMMARIZING: '生成中',
  FORMATTING: '整理中',
  SAVING: '保存中',
  SUCCESS: '生成完成',
  FAILED: '失败',
  SUBMISSION_UNKNOWN: '提交待确认',
  PROCESSING: '阶段未知',
})) {
  assert.equal(generationStatusLabel({ status } as Task), expected)
}
assert.equal(generationStatusLabel({ ...task, last_active_status: 'SAVING' }), '失败', 'terminal status takes priority over last active stage')
console.log('generation progress: terminal detail / honest phase / fixed time / versions / titles / guards passed')
