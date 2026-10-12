import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import GenerationProgress from '../src/pages/HomePage/components/GenerationProgress'
import { generationElapsed, generationPhase, generationTitle, mergeTaskSnapshot } from '../src/utils/taskProgress'
import type { Task } from '../src/store/taskStore'
const task = { id: 'failed', status: 'FAILED', statusMessage: '模型输出因长度限制被截断（finish_reason=length），未保存半截正文', last_active_status: 'SUMMARIZING', started_at: '2026-10-11T00:00:00Z', finished_at: '2026-10-11T00:00:06Z', audioMeta: { title: '真实视频名称' }, markdown: '', formData: { model_name: 'test', platform: 'local', video_url: 'C:\\videos\\课程.mp4', request_id: 'one' } } as Task
const render = (value: Task) => renderToStaticMarkup(<GenerationProgress task={value} onRetry={async () => undefined} />)
const html = render(task)
assert.ok(html.includes('finish_reason=length'))
assert.ok(html.includes('停止阶段：整理笔记'))
assert.ok(html.includes('用时 6 秒'))
assert.ok(html.includes('本次未保存笔记正文'))
assert.ok(html.includes('真实视频名称'))
assert.ok(!html.includes('刷新进度'))
assert.ok(!html.includes('已保存的笔记版本仍然保留'))
assert.ok(!html.includes('正在同步最新状态'))
assert.ok(!html.includes('generation-spin'))
assert.ok(render({ ...task, markdown: [{ content: '旧版完整笔记' } as any] }).includes('已保存的笔记版本仍然保留'))
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
const unknownUI = renderToStaticMarkup(<GenerationProgress task={{ ...task, status: 'SUBMISSION_UNKNOWN', submissionInFlight: false }} onRetry={async () => undefined} onResume={async () => undefined} />)
assert.ok(unknownUI.includes('继续提交本次请求'))
assert.ok(unknownUI.includes('复用同一请求编号'))
assert.ok(!unknownUI.includes('刷新进度'))
console.log('generation progress: terminal detail / honest phase / fixed time / versions / titles / no manual refresh passed')
