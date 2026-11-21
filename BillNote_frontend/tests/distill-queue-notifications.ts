import assert from 'node:assert/strict'
import {
  DEFAULT_DISTILL_NOTIFICATION_MODE,
  createInitialTrackerState,
  evaluateNotificationTransition,
  type DistillJobRecord,
} from '../src/utils/distillNotifications.ts'

function makeJob(overrides: Partial<DistillJobRecord> & Pick<DistillJobRecord, 'job_id' | 'task_id' | 'status'>): DistillJobRecord {
  return {
    kind: 'generate',
    batch_id: null,
    title: `测试笔记 ${overrides.job_id}`,
    progress: overrides.status === 'SUCCESS' || overrides.status === 'FAILED' || overrides.status === 'CANCELLED' ? 100 : 40,
    stage_message: overrides.status === 'SUCCESS' ? '生成完成' : '处理中',
    model_name: 'gpt-5.4',
    provider_id: 'p1',
    created_at: '2026-11-20T10:00:00Z',
    started_at: '2026-11-20T10:00:01Z',
    finished_at: null,
    updated_at: '2026-11-20T10:00:02Z',
    error_summary: null,
    retryable: true,
    ...overrides,
  }
}

// 0. 默认提醒档位必须为 all_done
assert.equal(DEFAULT_DISTILL_NOTIFICATION_MODE, 'all_done', '默认完成提醒档位应为 all_done')

// 1. 冷启动首包 snapshot 含历史已完成/失败任务 -> 绝不提醒
{
  const initial = createInitialTrackerState()
  const { next, notifications } = evaluateNotificationTransition(
    initial,
    {
      type: 'snapshot',
      active: [makeJob({ job_id: 'j-active', task_id: 't-active', status: 'TRANSCRIBING' })],
      recent: [
        makeJob({ job_id: 'j-old-ok', task_id: 't-old-ok', status: 'SUCCESS', finished_at: '2026-11-20T09:00:00Z' }),
        makeJob({ job_id: 'j-old-fail', task_id: 't-old-fail', status: 'FAILED', error_summary: '历史超时' }),
      ],
    },
    'each',
  )
  assert.equal(notifications.length, 0, '冷启动首包 snapshot 不应触发任何历史任务提醒')
  assert.equal(next.initialized, true)
  assert.ok(next.trackedActiveIds['j-active'], '首包中的活跃任务应被登记追踪')
}

// 2. each 模式单篇成功/失败 -> 逐篇立即提醒
{
  let state = createInitialTrackerState()
  state = evaluateNotificationTransition(
    state,
    { type: 'snapshot', active: [], recent: [] },
    'each',
  ).next

  state = evaluateNotificationTransition(
    state,
    { type: 'job_event', eventName: 'job.updated', job: makeJob({ job_id: 'j1', task_id: 't1', status: 'SUMMARIZING' }), activeCount: 2 },
    'each',
  ).next
  state = evaluateNotificationTransition(
    state,
    { type: 'job_event', eventName: 'job.updated', job: makeJob({ job_id: 'j2', task_id: 't2', status: 'DOWNLOADING' }), activeCount: 2 },
    'each',
  ).next

  const res1 = evaluateNotificationTransition(
    state,
    { type: 'job_event', eventName: 'job.completed', job: makeJob({ job_id: 'j1', task_id: 't1', status: 'SUCCESS', title: '连接池原理' }), activeCount: 1 },
    'each',
  )
  assert.equal(res1.notifications.length, 1, 'each 模式第 1 篇完成应立即提醒')
  assert.equal(res1.notifications[0].kind, 'single_success')
  assert.equal(res1.notifications[0].taskId, 't1')

  const res2 = evaluateNotificationTransition(
    res1.next,
    { type: 'job_event', eventName: 'job.failed', job: makeJob({ job_id: 'j2', task_id: 't2', status: 'FAILED', error_summary: '上游 502' }), activeCount: 0 },
    'each',
  )
  assert.equal(res2.notifications.length, 1, 'each 模式第 2 篇失败应立即提醒')
  assert.equal(res2.notifications[0].kind, 'single_failed')
  assert.match(res2.notifications[0].detail, /上游 502/)
}

// 3. all_done 模式（默认）：3 篇依次跑完第 1、2 篇时不弹，第 3 篇归零时合并弹 1 条汇总提醒
// 4. all_done 批次结束后新提交第 4 篇 -> 新开批次计数，不累加旧批次
{
  let state = createInitialTrackerState()
  state = evaluateNotificationTransition(state, { type: 'snapshot', active: [], recent: [] }, 'all_done').next

  for (const id of ['1', '2', '3']) {
    state = evaluateNotificationTransition(
      state,
      { type: 'job_event', eventName: 'job.updated', job: makeJob({ job_id: `j${id}`, task_id: `t${id}`, status: 'QUEUED' }) },
      'all_done',
    ).next
  }

  const r1 = evaluateNotificationTransition(
    state,
    { type: 'job_event', eventName: 'job.completed', job: makeJob({ job_id: 'j1', task_id: 't1', status: 'SUCCESS' }) },
    'all_done',
  )
  assert.equal(r1.notifications.length, 0, 'all_done 第 1/3 篇完成时不应弹窗')

  const r2 = evaluateNotificationTransition(
    r1.next,
    { type: 'job_event', eventName: 'job.failed', job: makeJob({ job_id: 'j2', task_id: 't2', status: 'FAILED', error_summary: '网络中断' }) },
    'all_done',
  )
  assert.equal(r2.notifications.length, 0, 'all_done 第 2/3 篇失败但队列未归零时不应弹窗')

  const r3 = evaluateNotificationTransition(
    r2.next,
    { type: 'job_event', eventName: 'job.completed', job: makeJob({ job_id: 'j3', task_id: 't3', status: 'SUCCESS', title: '第三篇笔记' }) },
    'all_done',
  )
  assert.equal(r3.notifications.length, 1, 'all_done 队列归零时应合并弹出 1 条汇总提醒')
  assert.equal(r3.notifications[0].kind, 'batch_done')
  assert.equal(r3.notifications[0].succeededCount, 2)
  assert.equal(r3.notifications[0].failedCount, 1)
  assert.equal(r3.notifications[0].taskId, 't3')
  assert.equal(r3.next.batchSucceeded, 0, '批次归零汇总后成功计数应重置')
  assert.equal(r3.next.batchFailed, 0, '批次归零汇总后失败计数应重置')

  // 新批次：第 4 篇独立计数
  const r4Start = evaluateNotificationTransition(
    r3.next,
    { type: 'job_event', eventName: 'job.updated', job: makeJob({ job_id: 'j4', task_id: 't4', status: 'SUMMARIZING', title: '第四篇笔记' }) },
    'all_done',
  )
  const r4Done = evaluateNotificationTransition(
    r4Start.next,
    { type: 'job_event', eventName: 'job.completed', job: makeJob({ job_id: 'j4', task_id: 't4', status: 'SUCCESS', title: '第四篇笔记' }) },
    'all_done',
  )
  assert.equal(r4Done.notifications.length, 1)
  assert.equal(r4Done.notifications[0].succeededCount, 1, '新批次不应累加旧批次计数')
  assert.equal(r4Done.notifications[0].failedCount, 0)
  assert.equal(r4Done.notifications[0].taskId, 't4')
}

// 5. off 模式全程零提醒
{
  let state = createInitialTrackerState()
  state = evaluateNotificationTransition(state, { type: 'snapshot', active: [], recent: [] }, 'off').next
  state = evaluateNotificationTransition(
    state,
    { type: 'job_event', eventName: 'job.updated', job: makeJob({ job_id: 'j-off', task_id: 't-off', status: 'SUMMARIZING' }) },
    'off',
  ).next
  const res = evaluateNotificationTransition(
    state,
    { type: 'job_event', eventName: 'job.completed', job: makeJob({ job_id: 'j-off', task_id: 't-off', status: 'SUCCESS' }) },
    'off',
  )
  assert.equal(res.notifications.length, 0, 'off 模式不应产生任何提醒')
}

console.log('distill-queue-notifications: ALL PASSED')
