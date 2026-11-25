/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import MarkdownViewer from '@/pages/HomePage/components/MarkdownViewer'
import DistillQueuePanel from '@/components/DistillQueue/DistillQueuePanel'
import { WorkspaceTopbarContext } from '@/layouts/WorkspaceTopbarContext'
import { useTaskStore, type Task } from '@/store/taskStore'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import { hasReadableContent } from '@/utils/readingStatus'
import request from '@/utils/request'
import type { StructuredNoteDocument } from '@/types/structuredNote'

const requests: Array<{ method: string; url: string; data?: Record<string, unknown> }> = []
let nextGenerateBehavior: 'ok' | 'network_unknown' = 'ok'
let saveRecoveryAvailable = true

request.defaults.suppressToast = true
request.defaults.adapter = async config => {
  const url = String(config.url || '')
  const method = String(config.method || 'get').toUpperCase()
  const data = typeof config.data === 'string' && config.data.trim().startsWith('{')
    ? JSON.parse(config.data) as Record<string, unknown>
    : (config.data as Record<string, unknown> | undefined)
  requests.push({ method, url, data })

  if (url === '/generate_note') {
    if (nextGenerateBehavior === 'network_unknown') {
      throw { code: -1, msg: '模拟网络中断' }
    }
    return { data: { code: 0, data: { task_id: data?.task_id || 't1' } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.includes('/diagnostics')) {
    const taskId = url.split('/')[2] || 't1'
    return {
      data: {
        code: 0,
        data: {
          task_id: taskId,
          trace_id: 'trace-fixture',
          historical: false,
          stages: [{ name: 'summarizing', status: 'failed', duration_ms: 1200 }],
          error: { message: '模拟保存或生成失败', type: 'RuntimeError' },
          outcomes: { model_completed: saveRecoveryAvailable, content_saved: false, index_saved: false },
          save_recovery: { available: saveRecoveryAvailable, reason: saveRecoveryAvailable ? '' : '无可恢复正文' },
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  if (url.includes('/retry-save')) {
    return { data: { code: 0, data: { ok: true } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.startsWith('/notes/') && url.endsWith('/media')) {
    return { data: { code: 0, data: { available: false, media_type: null, size: 0, url: null } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.startsWith('/notes/') && url.endsWith('/learning_state')) {
    return { data: { code: 0, data: { quiz_attempts: {}, user_annotations: [] } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.startsWith('/notes/') && url.endsWith('/related')) {
    return { data: { code: 0, data: [] }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.includes('/generation_runs')) {
    return { data: { code: 0, data: [] }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.includes('/review_bank')) {
    return { data: { code: 0, data: { items: [], total: 0, due_total: 0 } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.startsWith('/jobs/') && url.endsWith('/retry')) {
    return { data: { code: 0, data: { job_id: 'job-fail', task_id: 'task-queue-fail', status: 'PENDING' } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.startsWith('/jobs/') && url.endsWith('/cancel')) {
    return { data: { code: 0, data: { job_id: 'job-run', cancelled: true } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (url.startsWith('/notes/') && method === 'GET') {
    const id = url.replace(/^\/notes\//, '').split('/')[0]
    const task = useTaskStore.getState().tasks.find(item => item.id === id)
    return { data: { code: 0, data: task || null }, status: 200, statusText: 'OK', headers: {}, config }
  }
  return { data: { code: 0, data: {} }, status: 200, statusText: 'OK', headers: {}, config }
}

function makeTask(partial: Partial<Task> & { id: string }): Task {
  return {
    id: partial.id,
    markdown: partial.markdown ?? '',
    transcript: partial.transcript ?? { full_text: '', language: '', raw: null, segments: [] },
    status: partial.status ?? 'PENDING',
    statusMessage: partial.statusMessage,
    cancelled: partial.cancelled ?? false,
    last_active_status: partial.last_active_status,
    started_at: partial.started_at,
    finished_at: partial.finished_at,
    archived_at: partial.archived_at ?? null,
    audioMeta: {
      cover_url: '',
      duration: 60,
      file_path: '',
      platform: 'bilibili',
      raw_info: null,
      title: partial.audioMeta?.title ?? `任务 ${partial.id}`,
      video_id: 'BV1xx',
      ...partial.audioMeta,
    },
    createdAt: partial.createdAt ?? '2026-11-25T00:00:00Z',
    formData: {
      request_id: 'req-init',
      video_url: 'https://www.bilibili.com/video/BV1xx',
      link: true,
      screenshot: false,
      platform: 'bilibili',
      quality: 'medium',
      model_name: 'gpt-test',
      provider_id: 'prov-1',
      style: 'tutorial',
      ...partial.formData,
    },
  }
}

function Harness({ showQueue }: { showQueue: boolean }) {
  const [leftSlot, setLeftSlot] = useState<HTMLDivElement | null>(null)
  const [rightSlot, setRightSlot] = useState<HTMLDivElement | null>(null)
  const tasks = useTaskStore(state => state.tasks)
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const currentTask = tasks.find(item => item.id === currentTaskId) || null
  const status: 'idle' | 'loading' | 'success' | 'failed' = !currentTask
    ? 'idle'
    : currentTask.status === 'SUCCESS'
      ? 'success'
      : currentTask.status === 'FAILED'
        ? (hasReadableContent(currentTask) ? 'success' : 'failed')
        : 'loading'

  const topbarCtx = useMemo(() => ({
    active: true,
    leftSlot,
    rightSlot,
    onConfigure: () => {},
    closeSidebar: () => {},
    setHasTopbarOwner: () => {},
  }), [leftSlot, rightSlot])

  return (
    <MemoryRouter>
      <WorkspaceTopbarContext.Provider value={topbarCtx}>
        <div id="test-shell" style={{ display: 'flex', flexDirection: 'column', height: '720px', width: '1280px' }}>
          <header className="workspace-topbar" data-mode="read">
            <div className="workspace-tab"><span>{currentTask?.audioMeta?.title || '空'}</span></div>
            <div ref={setLeftSlot} className="workspace-topbar-left" />
            <div ref={setRightSlot} className="workspace-topbar-right" />
          </header>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {currentTask ? <MarkdownViewer key={currentTask.id} status={status} /> : <div id="no-task">空</div>}
          </div>
          {showQueue && <DistillQueuePanel variant="inline" />}
        </div>
      </WorkspaceTopbarContext.Provider>
    </MemoryRouter>
  )
}

const sleep = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn: () => boolean, label: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(25)
  }
  throw new Error(`等待超时: ${label}\nDOM:\n${document.body.innerText.slice(0, 1200)}`)
}
function findButton(label: string, root: ParentNode = document): HTMLButtonElement | null {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find(btn => btn.textContent?.trim() === label || btn.getAttribute('aria-label') === label) || null
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${message}`)
}

async function runSuite() {
  const errors: string[] = []
  window.addEventListener('error', event => errors.push(`window.error: ${event.message}`))
  window.addEventListener('unhandledrejection', event => errors.push(`unhandledrejection: ${String(event.reason)}`))
  const origConsoleError = console.error
  console.error = (...args: unknown[]) => {
    const msg = args.map(item => String(item)).join(' ')
    if (/Rendered more hooks|Rendered fewer hooks|Invalid hook call|Hook/i.test(msg)) {
      errors.push(`console.error: ${msg}`)
    }
    origConsoleError(...args)
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let setShowQueue!: (v: boolean) => void
  function RootWrapper() {
    const [showQueue, _setShowQueue] = useState(false)
    useEffect(() => { setShowQueue = _setShowQueue }, [])
    return <Harness showQueue={showQueue} />
  }

  const results: string[] = []

  // 1. Same mounted instance: loading -> FAILED -> cancel confirm(0) -> confirm regenerate(1) -> SUBMISSION_UNKNOWN(resume 1) -> SUCCESS
  useTaskStore.setState({
    tasks: [makeTask({ id: 't-flow', status: 'SUMMARIZING', last_active_status: 'SUMMARIZING', formData: { request_id: 'req-1' } as Task['formData'] })],
    currentTaskId: 't-flow',
  })
  root.render(<RootWrapper />)
  await waitFor(() => Boolean(document.querySelector('section[aria-label="笔记生成进度"]')), '首次生成进度页渲染')
  assert(document.querySelector('.workspace-topbar-status-pill') === null, '首次无正文时顶栏不去重渲染状态胶囊')
  assert(findButton('思维导图')?.disabled === true, '无正文时思维导图按钮禁用')
  assert(findButton('原文参照')?.disabled === true, '无原文时原文参照按钮禁用')
  assert(findButton('AI 问答')?.disabled === true, '无正文且无原文时 AI 问答按钮禁用')
  assert(findButton('复习库')?.disabled === false, '复习库保持可用')
  assert(findButton('生成设置')?.disabled === false, '生成设置保持可用')

  // Transition same mounted instance to FAILED (cancelled: true first)
  useTaskStore.getState().updateTaskContent('t-flow', {
    status: 'FAILED',
    cancelled: true,
    last_active_status: 'SUMMARIZING',
    statusMessage: '用户取消了生成',
  })
  await waitFor(() => document.body.innerText.includes('已取消生成'), '同实例切至已取消失败态')
  assert(document.querySelector('.workspace-topbar-status-pill') === null, '首次失败顶栏不重复展示失败按钮')

  // Click regenerate -> opens confirm dialog -> click cancel => 0 generate requests
  requests.length = 0
  const retryBtn = findButton('重新生成')
  assert(retryBtn && !retryBtn.disabled, '失败画布显示重新生成按钮')
  retryBtn.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '点击重新生成弹出付费确认弹窗')
  assert(document.querySelector('[role="alertdialog"]')?.textContent?.includes('可能产生模型调用费用'), '确认框含费用说明')
  findButton('取消', document.querySelector('[role="alertdialog"]')!)!.click()
  await waitFor(() => !document.querySelector('[role="alertdialog"]'), '取消确认后关闭弹窗')
  assert(requests.filter(r => r.url === '/generate_note').length === 0, '取消付费确认应发起 0 次请求')

  // Click regenerate -> confirm (even rapid double click) => 1 request, clears cancelled, simulates SUBMISSION_UNKNOWN on network failure
  nextGenerateBehavior = 'network_unknown'
  findButton('重新生成')!.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '二次点击打开确认弹窗')
  const confirmRegenBtn = findButton('确认重新生成', document.querySelector('[role="alertdialog"]')!)!
  confirmRegenBtn.click()
  confirmRegenBtn.click()
  await waitFor(
    () => useTaskStore.getState().tasks[0].status === 'SUBMISSION_UNKNOWN' && !useTaskStore.getState().tasks[0].submissionInFlight,
    '网络中断并完成单次尝试后进入 SUBMISSION_UNKNOWN',
  )
  const firstRetryCalls = requests.filter(r => r.url === '/generate_note')
  assert(firstRetryCalls.length === 1, `确认重生成应发起 1 次请求，实际 ${firstRetryCalls.length}`)
  assert(useTaskStore.getState().tasks[0].cancelled === false, '重新发起请求后必须清除 cancelled')
  assert(!document.body.innerText.includes('已取消生成'), '非终态绝不显示已取消生成')
  const unknownReqId = useTaskStore.getState().tasks[0].formData.request_id

  // Resume same submission -> 1 request with exact same request_id -> PENDING -> SUCCESS
  nextGenerateBehavior = 'ok'
  await waitFor(() => Boolean(findButton('继续提交本次请求')), 'SUBMISSION_UNKNOWN 显示继续提交本次请求')
  findButton('继续提交本次请求')!.click()
  await waitFor(() => useTaskStore.getState().tasks[0].status === 'PENDING', '续交成功后转为 PENDING')
  const afterResumeCalls = requests.filter(r => r.url === '/generate_note')
  assert(afterResumeCalls.length === 2, '续交应新增恰好 1 次请求')
  assert(afterResumeCalls[1].data?.request_id === unknownReqId, '续交必须复用同一 request_id')

  // Transition to SUCCESS with readable markdown
  useTaskStore.getState().updateTaskContent('t-flow', {
    status: 'SUCCESS',
    markdown: '# 生成成功正文\n\n这里是完整内容。',
  })
  await waitFor(() => document.body.innerText.includes('生成成功正文'), '成功后切换为阅读器正文')
  assert(findButton('思维导图')?.disabled === false, '有正文后思维导图恢复可用')
  assert(findButton('AI 问答')?.disabled === false, '有正文后 AI 问答恢复可用')
  results.push('1. 同实例 loading->FAILED->取消确认(0)->确认重生成(1)->SUBMISSION_UNKNOWN(同ID续交1)->SUCCESS 无 Hooks 异常 PASS')

  // 2. Historical readable version: regenerating & failed keep old body + scrollTop, single topbar pill -> diagnostics save_recovery(0 model calls) & paid regenerate
  const longBody = '# 历史可读版本\n\n' + Array.from({ length: 60 }, (_, idx) => `第 ${idx + 1} 段较长正文内容用于产生滚动条以验证滚动位置保持。`).join('\n\n')
  useTaskStore.setState({
    tasks: [
      makeTask({
        id: 't-hist',
        status: 'SUCCESS',
        markdown: [
          { ver_id: 'v-hist-1', content: longBody, style: 'tutorial', model_name: 'gpt-test', created_at: '2026-11-24T00:00:00Z' },
        ],
        transcript: { full_text: '原文内容', language: 'zh', raw: null, segments: [{ start: 0, end: 5, text: '第一句原文' }] },
      }),
    ],
    currentTaskId: 't-hist',
  })
  await waitFor(() => Boolean(document.querySelector('[data-testid="reader-viewport"]')), '历史版本阅读器渲染')
  const viewport = document.querySelector<HTMLElement>('[data-testid="reader-viewport"]')!
  viewport.style.overflow = 'auto'
  viewport.style.height = '240px'
  viewport.scrollTop = 180
  const savedScrollTop = viewport.scrollTop
  assert(savedScrollTop > 0, '设置旧版阅读滚动位置成功')

  // Start background regeneration -> old content & scrollTop preserved, single running topbar pill
  useTaskStore.getState().updateTaskContent('t-hist', { status: 'SUMMARIZING', last_active_status: 'SUMMARIZING' })
  await waitFor(() => Boolean(document.querySelector('.workspace-topbar-status-pill.is-running')), '后台重生成中顶栏展示单个紧凑进行中胶囊')
  assert(document.querySelector('[data-testid="reader-viewport"]') === viewport, '后台重生成不卸载旧版 ReaderPane 实例')
  assert(viewport.scrollTop === savedScrollTop, `后台重生成保持旧版滚动位置 (${viewport.scrollTop} vs ${savedScrollTop})`)
  assert(document.body.innerText.includes('历史可读版本'), '后台重生成保持旧版正文不闪空')

  // Background regeneration fails -> old content & scrollTop preserved, single failed topbar pill, no bare regenerate button
  useTaskStore.getState().updateTaskContent('t-hist', { status: 'FAILED', last_active_status: 'SUMMARIZING', statusMessage: '保存失败' })
  await waitFor(() => Boolean(document.querySelector('.workspace-topbar-status-pill.is-failed')), '历史版重生成失败顶栏展示单个紧凑恢复胶囊')
  assert(document.querySelector('[data-testid="reader-viewport"]') === viewport, '历史版失败不卸载旧版 ReaderPane 实例')
  assert(viewport.scrollTop === savedScrollTop, '历史版失败保持旧版滚动位置')
  assert(findButton('重新生成') === null, '顶栏已移除裸露的重新生成按钮')

  // Open diagnostics from topbar pill -> test retry save (0 model calls), paid regenerate, and resume submission
  requests.length = 0
  saveRecoveryAvailable = true
  document.querySelector<HTMLButtonElement>('.workspace-topbar-status-pill.is-failed')!.click()
  await waitFor(() => Boolean(findButton('重试保存')), '诊断弹窗加载出重试保存入口')
  findButton('重试保存')!.click()
  await waitFor(() => document.body.innerText.includes('保存已恢复，未重复调用模型'), '完成重试保存且显示恢复提示')
  assert(requests.some(r => r.url.includes('/retry-save')), '触发重试保存请求')
  assert(requests.filter(r => r.url === '/generate_note').length === 0, '重试保存绝不发起模型生成请求')

  // Test paid regenerate inside diagnostics panel (cancel = 0, confirm = 1 -> SUBMISSION_UNKNOWN -> resume = 1 same ID)
  nextGenerateBehavior = 'network_unknown'
  await waitFor(() => {
    const btn = findButton('重新生成', document.querySelector('[role="dialog"]')!)
    return Boolean(btn && !btn.disabled)
  }, '诊断弹窗提供可用的重新生成按钮')
  const diagRetry = findButton('重新生成', document.querySelector('[role="dialog"]')!)!
  diagRetry.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '诊断弹窗点重新生成弹出付费确认')
  findButton('取消', document.querySelector('[role="alertdialog"]')!)!.click()
  await waitFor(() => !document.querySelector('[role="alertdialog"]'), '诊断弹窗取消付费确认关闭弹窗')
  assert(requests.filter(r => r.url === '/generate_note').length === 0, '诊断弹窗取消付费确认发起 0 次请求')
  diagRetry.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '诊断弹窗二次打开付费确认')
  findButton('确认重新生成', document.querySelector('[role="alertdialog"]')!)!.click()
  await waitFor(
    () => requests.filter(r => r.url === '/generate_note').length === 1 && !useTaskStore.getState().tasks[0].submissionInFlight,
    '确认后发起 1 次重生成请求',
  )
  const diagUnknownId = useTaskStore.getState().tasks[0].formData.request_id
  nextGenerateBehavior = 'ok'
  await waitFor(() => Boolean(findButton('继续本次提交', document.querySelector('[role="dialog"]')!)), '诊断弹窗在 SUBMISSION_UNKNOWN 下提供继续本次提交')
  findButton('继续本次提交', document.querySelector('[role="dialog"]')!)!.click()
  await waitFor(() => requests.filter(r => r.url === '/generate_note').length === 2, '诊断弹窗续交发起 1 次同 ID 请求')
  assert(requests.filter(r => r.url === '/generate_note')[1].data?.request_id === diagUnknownId, '诊断弹窗续交复用同一 request_id')
  // Close details dialog
  const closeBtn = document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')
  closeBtn?.click()
  await sleep(60)
  results.push('2. 历史可读版重生成中/失败保持旧版与滚动位置 + 顶栏单入口 + 诊断重试保存(0模型请求)/付费重生成/同ID续交 PASS')

  // 3. Cross-task switch from map / full chat to first-failed task resets view & disables tools & Ctrl+. blocked
  const taskA = makeTask({
    id: 'task-a',
    status: 'SUCCESS',
    markdown: '# 任务A正文\n\n完整笔记',
    transcript: { full_text: 'A原文', language: 'zh', raw: null, segments: [{ start: 0, end: 2, text: 'A原文' }] },
  })
  const taskB = makeTask({
    id: 'task-b-failed',
    status: 'FAILED',
    last_active_status: 'DOWNLOADING',
    statusMessage: '下载视频失败：403 Forbidden',
    markdown: '',
  })
  useTaskStore.setState({ tasks: [taskA, taskB], currentTaskId: 'task-a' })
  await waitFor(() => document.body.innerText.includes('任务A正文'), '切换到任务 A')
  // Open AI chat on task A
  findButton('AI 问答')!.click()
  await waitFor(() => findButton('AI 问答')?.getAttribute('aria-pressed') === 'true', '任务 A 打开 AI 问答')
  // Switch to first-failed task B
  useTaskStore.getState().setCurrentTask('task-b-failed')
  await waitFor(() => document.body.innerText.includes('下载视频失败：403 Forbidden'), '切至首次失败任务 B 直接看到失败原因')
  assert(findButton('AI 问答')?.disabled === true, '任务 B 禁用 AI 问答')
  assert(findButton('AI 问答')?.getAttribute('aria-pressed') === 'false', '跨任务切换重置问答状态')
  assert(findButton('思维导图')?.disabled === true, '任务 B 禁用思维导图')
  // Press Ctrl+. must NOT open chat
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true }))
  await sleep(50)
  assert(findButton('AI 问答')?.getAttribute('aria-pressed') === 'false', '无可用上下文时 Ctrl+. 不打开问答')
  results.push('3. 跨任务切换（AI问答->首次失败）重置视图并守卫工具栏与 Ctrl+. 快捷键 PASS')

  // 4. Success empty version (no onboarding guide, no progress page), pure structured note, latest empty + older readable default fallback & switch back
  useTaskStore.setState({
    tasks: [makeTask({ id: 't-success-empty', status: 'SUCCESS', markdown: '' })],
    currentTaskId: 't-success-empty',
  })
  await waitFor(() => document.body.innerText.includes('该版本没有可读正文'), '成功空版显示空正文提示')
  assert(!document.body.innerText.includes('粘贴链接或拖入本地文件开始生成'), '成功空版不再误显示新建引导')
  assert(Boolean(findButton('查看详情')), '成功空版提供查看详情按钮')

  const structuredDoc: StructuredNoteDocument = {
    schema_version: 1,
    note_style: 'tutorial',
    title: '纯结构化笔记标题',
    sections: [
      {
        id: 'sec-1',
        title: '核心机制',
        level: 2,
        time_ranges: [],
        core_takeaways: [{ spans: [{ text: '纯结构化字段同样判定为可读正文' }] }],
        blocks: [{ type: 'paragraph', spans: [{ text: '这里是结构化段落内容。' }] }],
        annotations: [],
        quiz: null,
      },
    ],
  }
  useTaskStore.setState({
    tasks: [
      makeTask({
        id: 't-structured',
        status: 'SUCCESS',
        markdown: [{ ver_id: 'v-struct', content: '', structured: structuredDoc, style: 'tutorial', model_name: 'gpt-test', created_at: '2026-11-25T00:00:00Z' }],
      }),
    ],
    currentTaskId: 't-structured',
  })
  await waitFor(() => document.body.innerText.includes('纯结构化字段同样判定为可读正文'), '纯 structured 正文正常渲染')
  assert(findButton('思维导图')?.disabled === false, '纯 structured 正文启用思维导图')

  useTaskStore.setState({
    tasks: [
      makeTask({
        id: 't-latest-empty',
        status: 'SUCCESS',
        markdown: [
          { ver_id: 'v-new-empty', content: '   ', style: 'tutorial', model_name: 'gpt-test', created_at: '2026-11-25T02:00:00Z' },
          { ver_id: 'v-old-ok', content: '# 旧版可读正文内容', style: 'tutorial', model_name: 'gpt-test', created_at: '2026-11-25T01:00:00Z' },
        ],
      }),
    ],
    currentTaskId: 't-latest-empty',
  })
  await waitFor(() => document.body.innerText.includes('旧版可读正文内容'), '最新版空而旧版可读时默认选中旧版可读版本')
  // Manually navigate to the empty version via sourceNavigationStore -> see empty version state + switch back button
  const { useSourceNavigationStore } = await import('@/store/sourceNavigationStore')
  useSourceNavigationStore.getState().open({
    note_id: 't-latest-empty',
    version_id: 'v-new-empty',
    text: '',
    source_type: 'note',
    metadata_only: true,
  })
  await waitFor(() => Boolean(findButton('切回可读版本')), '切到空版本显示切回可读版本按钮')
  assert(document.body.innerText.includes('该版本没有可读正文'), '空版本显示简洁提示')
  assert(Boolean(findButton('查看详情')), '空版本提供查看详情按钮')
  findButton('切回可读版本')!.click()
  await waitFor(() => document.body.innerText.includes('旧版可读正文内容'), '点击切回可读版本恢复旧版正文')
  results.push('4. 成功空版、纯 structured 正文、最新版空而旧版可读默认选版与切回可读版本 PASS')

  // 5. DistillQueuePanel retry & cancel confirmation dialogs
  useTaskStore.setState({
    tasks: [makeTask({ id: 'task-queue-fail', status: 'FAILED', cancelled: true, markdown: '' })],
    currentTaskId: 'task-queue-fail',
  })
  useDistillQueueStore.setState({
    activeJobs: [
      {
        job_id: 'job-run',
        task_id: 'task-queue-run',
        title: '队列运行中任务',
        kind: 'generate',
        status: 'SUMMARIZING',
        stage_message: '整理笔记',
        progress: 60,
        retryable: false,
        created_at: '2026-11-25T00:00:00Z',
      },
    ],
    recentJobs: [
      {
        job_id: 'job-fail',
        task_id: 'task-queue-fail',
        title: '队列失败任务',
        kind: 'generate',
        status: 'FAILED',
        progress: 0,
        retryable: true,
        error_summary: '模型超时',
        created_at: '2026-11-25T00:00:00Z',
      },
    ],
    activeCount: 1,
    busyJobIds: {},
  })
  setShowQueue(true)
  await waitFor(() => Boolean(findButton('重试')) && Boolean(findButton('取消')), '蒸馏队列面板渲染')

  // Retry confirm cancel = 0, confirm = 1 + clears task cancelled
  requests.length = 0
  findButton('重试')!.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '队列点重试弹出付费确认')
  findButton('取消', document.querySelector('[role="alertdialog"]')!)!.click()
  await waitFor(() => !document.querySelector('[role="alertdialog"]'), '关闭队列重试确认')
  assert(requests.filter(r => r.url.includes('/retry')).length === 0, '队列取消重试确认发起 0 次请求')

  findButton('重试')!.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '再次打开队列重试确认')
  findButton('确认重新生成', document.querySelector('[role="alertdialog"]')!)!.click()
  await waitFor(() => !document.querySelector('[role="alertdialog"]'), '队列确认重试完成并关闭弹窗')
  assert(requests.filter(r => r.url.includes('/retry')).length === 1, '队列确认重试发起 1 次请求')
  assert(useTaskStore.getState().tasks.find(t => t.id === 'task-queue-fail')?.cancelled === false, '队列重试后清除本地任务 cancelled')

  // Cancel confirm cancel = 0, confirm = 1
  findButton('取消')!.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '队列点取消弹出计费确认')
  assert(document.querySelector('[role="alertdialog"]')?.textContent?.includes('已发出的请求可能继续计费'), '队列取消含计费提示')
  findButton('继续生成', document.querySelector('[role="alertdialog"]')!)!.click()
  await waitFor(() => !document.querySelector('[role="alertdialog"]'), '关闭队列取消确认')
  assert(requests.filter(r => r.url.includes('/cancel')).length === 0, '队列放弃取消发起 0 次请求')

  findButton('取消')!.click()
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), '再次打开队列取消确认')
  findButton('确认取消', document.querySelector('[role="alertdialog"]')!)!.click()
  await waitFor(() => !document.querySelector('[role="alertdialog"]'), '队列确认取消完成并关闭弹窗')
  assert(requests.filter(r => r.url.includes('/cancel')).length === 1, '队列确认取消发起 1 次请求')
  results.push('5. 蒸馏队列面板重试付费确认与取消计费确认 + cancelled 清除 PASS')

  assert(errors.length === 0, `运行期间出现异常:\n${errors.join('\n')}`)
  root.unmount()

  document.body.replaceChildren(
    Object.assign(document.createElement('pre'), {
      id: 'state-machine-result',
      textContent: JSON.stringify({ ok: true, results }),
    }),
  )
}

runSuite().catch(error => {
  document.body.replaceChildren(
    Object.assign(document.createElement('pre'), {
      id: 'state-machine-result',
      textContent: JSON.stringify({ ok: false, error: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error) }),
    }),
  )
})
