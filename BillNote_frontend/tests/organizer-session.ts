import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import type { OrganizerSession } from '@/services/organizer'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, configurable: true })
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
async function run() {
  const { useOrganizerStore: store } = await import('@/store/organizerStore')
  const { default: request } = await import('@/utils/request')
  const current: OrganizerSession = { session_id: 'session-a', revision: 0, status: 'idle', scope: { kind: 'all', authorized: false, exclude_favorites: false, target_count: 0 }, history: [], plan: null, result: null, error: null, events: [], updated_at: 1 }
  const calls: { path: string; body: Record<string, unknown> }[] = []
  let deferred: ((value: OrganizerSession) => void) | undefined
  let delayCompaction = false
  let deferredCompact: ((value: OrganizerSession) => void) | undefined
  const originalGet = request.get, originalPost = request.post
  request.get = (async (path: string) => structuredClone(path === '/organizer/sessions' ? { sessions: [current] } : current)) as typeof request.get
  request.post = (async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body })
    if (path === '/organizer/sessions') return structuredClone(current)
    assert.equal(body.expected_revision, current.revision, 'Each mutation binds current server revision')
    assert.equal(typeof body.request_id, 'string')
    if (path.endsWith('/message')) {
      if (body.instruction === '确认执行') {
        current.history.push({ id: 'confirmation-user', role: 'user', content: '确认执行', created_at: 2 })
        current.history.push({ id: 'confirmation-hint', role: 'assistant', content: '请点击计划按钮', created_at: 2 })
        return structuredClone(current)
      }
      current.revision++
      current.history.push({ id: `u-${current.revision}`, role: 'user', content: String(body.instruction), created_at: 1 })
      current.scope = { kind: 'folder', folder_id: 'office', folder_name: '办公效率', target_count: 2, authorized: true, exclude_favorites: false }
      current.status = 'awaiting_approval'
      current.plan = { plan_id: `p-${current.revision}`, status: 'planned', explanation: '只归档办公效率', operations: [{ type: 'archive', task_ids: ['office-1', 'office-2'] }], scope_count: 2, metadata_only: true }
      current.history.push({ id: `a-${current.revision}`, role: 'assistant', content: current.plan.explanation, created_at: 1, phase: 'awaiting_approval' as never })
      if (body.instruction === '延迟响应') { current.status = 'planning'; return await new Promise<OrganizerSession>(resolve => { deferred = resolve }) }
    } else if (path.endsWith('/compact')) {
      if (delayCompaction) return await new Promise<OrganizerSession>(resolve => { deferredCompact = resolve })
      current.memory = { summary: '历史摘要', through_id: current.history[0]?.id || null, compacted_messages: 2 }
    } else if (path.endsWith('/cancel-compaction')) {
      // Compaction cancellation leaves approval and revision untouched.
    } else if (path.endsWith('/approve')) {
      assert.equal(body.plan_id, current.plan?.plan_id)
      current.status = 'completed'; current.result = { plan_id: current.plan!.plan_id, status: 'executed', undo_available: true }; current.revision++
    } else if (path.endsWith('/cancel')) { current.status = 'cancelled'; current.plan = null; current.revision++ }
    else if (path.endsWith('/recover')) { current.status = 'idle'; current.revision++ }
    return structuredClone(current)
  }) as typeof request.post
  try {
    storage.set('bilinote-organizer-active-session-v1', current.session_id)
    await store.getState().initialize()
    assert.equal(store.getState().session?.session_id, 'session-a', 'Refresh restores by ID from server')
    const body = { instruction: '归档办公效率', provider_id: 'organizer-provider', model_name: 'model', scope: { kind: 'all' as const } }
    await store.getState().send(body, '可查询整个库')
    const oldMessage = store.getState().messages.at(-1)!
    assert.equal(oldMessage.phase, 'pending')
    await store.getState().send({ ...body, instruction: '确认执行', reasoning_effort: 'high', context_limit: 272000 }, '')
    assert.equal(store.getState().messages.find(message => message.phase === 'pending')?.id, oldMessage.id, 'Text confirmation preserves the original proposal card')
    assert.equal(store.getState().messages.at(-1)?.plan, undefined, 'Approval authority is not attached to the conversational hint')
    assert.equal(calls.at(-1)?.body.reasoning_effort, 'high')
    assert.equal(calls.at(-1)?.body.context_limit, 272000)
    const beforeCompact = structuredClone(current)
    await store.getState().send({ ...body, instruction: '/compact' }, '')
    assert.ok(calls.at(-1)?.path.endsWith('/compact'), 'Compaction uses dedicated endpoint')
    assert.equal(calls.at(-1)?.body.instruction, undefined, 'Command is not submitted as model conversation')
    assert.deepEqual(store.getState().session?.history, beforeCompact.history)
    assert.deepEqual(store.getState().session?.plan, beforeCompact.plan)
    assert.equal(store.getState().session?.revision, beforeCompact.revision)
    assert.match(store.getState().compactNotice || '', /压缩完成/)
    await store.getState().send({ ...body, instruction: '压缩上下文' }, '')
    assert.match(store.getState().compactNotice || '', /无需压缩/)
    delayCompaction = true
    const pendingCompact = store.getState().send({ ...body, instruction: '/compact' }, '')
    for (let i = 0; i < 6; i++) await Promise.resolve()
    assert.equal(store.getState().busy, 'compacting')
    const beforeStop = structuredClone(current)
    await store.getState().cancel()
    assert.ok(calls.at(-1)?.path.endsWith('/cancel-compaction'))
    assert.equal(store.getState().session?.revision, beforeStop.revision)
    assert.deepEqual(store.getState().session?.plan, beforeStop.plan)
    const lateCompact = structuredClone(current)
    lateCompact.memory = { summary: '不应提交的晚到摘要', through_id: null, compacted_messages: 99 }
    deferredCompact!(lateCompact)
    await pendingCompact
    assert.deepEqual(store.getState().session?.memory, beforeStop.memory)
    assert.match(store.getState().compactNotice || '', /已停止/)
    delayCompaction = false
    assert.equal(store.getState().scope, 'all', 'Resolved folder target never narrows the UI query ceiling')
    store.getState().setDraft('那排除收藏')
    await store.getState().send({ ...body, instruction: '那排除收藏' }, '办公效率')
    assert.equal(calls.filter(call => call.path.endsWith('/message')).length, 3, 'Pending plan allows follow-up messages')
    assert.equal(await store.getState().execute(oldMessage.id), false, 'Old message cannot confirm a replacement plan')
    const latest = store.getState().messages.at(-1)!
    assert.equal(await store.getState().execute(latest.id), true, 'Only current server-bound plan executes')
    assert.deepEqual([...storage.keys()].sort(), ['bilinote-organizer-active-session-v1', 'bilinote-organizer-active-session-v1-composer'], 'Storage saves only active session ID and composer preferences')
    assert.equal(storage.values().next().value, 'session-a', 'Storage never saves messages or plans')
    const sending = store.getState().send({ ...body, instruction: '延迟响应' }, '')
    for (let i = 0; i < 6; i++) await Promise.resolve()
    assert.equal(typeof deferred, 'function')
    const stale = structuredClone(current); stale.status = 'awaiting_approval'
    await store.getState().cancel()
    deferred!(stale); await sending
    assert.equal(store.getState().session?.status, 'cancelled', 'Late model response cannot revive cancelled plan')
    assert.equal(store.getState().busy, null)
    current.history.push({ id: 'server-only', role: 'assistant', content: '服务器保存的回答', created_at: 1 })
    store.setState({ messages: [{ id: 'client-fake', role: 'assistant', text: '客户端伪造' }] })
    await store.getState().restore(current.session_id)
    assert.equal(store.getState().messages.at(-1)?.text, '服务器保存的回答', 'Restoration replaces client history with authoritative snapshot')
    current.query_scope = { kind: 'selected', task_ids: ['query-note'] }
    await store.getState().restore(current.session_id)
    assert.equal(store.getState().scope, 'all', 'New queries use the full library without a hidden legacy query scope')
    assert.deepEqual(store.getState().session?.scope, current.scope, 'Restoration preserves the actual write target')
    assert.deepEqual(store.getState().session?.plan, current.plan, 'Restoration preserves the existing plan')
    assert.deepEqual(store.getState().selectedIds, [])
    current.status = 'interrupted'
    await store.getState().refresh()
    await store.getState().recover()
    assert.equal(calls.at(-1)?.path.endsWith('/recover'), true, 'Recovery requires explicit server action')
    assert.equal(store.getState().session?.status, 'idle')
    current.status = 'awaiting_approval'; current.updated_at = 20; current.events = [{ sequence: 4, type: 'ready', message: '', created_at: 20 }]
    await store.getState().refresh()
    const stalePoll = structuredClone(current); stalePoll.status = 'planning'; stalePoll.updated_at = 10; stalePoll.events = stalePoll.events.slice(0, 0)
    request.get = (async () => stalePoll) as typeof request.get
    await store.getState().refresh()
    assert.equal(store.getState().session?.status, 'awaiting_approval', 'Same-revision late poll cannot regress terminal state')
    stalePoll.updated_at = 20; stalePoll.events = structuredClone(current.events)
    await store.getState().refresh()
    assert.equal(store.getState().session?.status, 'awaiting_approval', 'Equal-clock poll cannot revive processing after completion')
    request.get = (async (path: string) => structuredClone(path === '/organizer/sessions' ? { sessions: [current] } : current)) as typeof request.get
    const safePlan = { plan_id: 'safe-plan', status: 'planned' as const, explanation: '安全计划', operations: [{ type: 'archive' as const, task_ids: ['office-1'] }], scope_count: 1, metadata_only: true }
    current.revision++; current.plan = safePlan; current.result = null
    await store.getState().restore(current.session_id)
    const safeMessageId = store.getState().messages.at(-1)!.id
    current.plan = { ...safePlan, metadata_only: false }; current.revision++
    await store.getState().refresh()
    assert.match(store.getState().error || '', /安全确认/)
    const beforeUnsafe = calls.length
    assert.equal(await store.getState().execute(safeMessageId), false)
    assert.equal(calls.length, beforeUnsafe, 'Unsafe metadata plan never posts confirmation')
    current.plan = { ...safePlan, operations: [{ type: 'delete' } as never] }; current.revision++
    await store.getState().refresh()
    assert.equal(await store.getState().execute(safeMessageId), false, 'Unknown operation snapshot cannot execute')
    current.plan = safePlan; current.revision++; current.status = 'idle'
    await store.getState().refresh()
    const workingPost = request.post
    request.post = (async () => { throw new Error('测试请求失败') }) as typeof request.post
    await store.getState().send({ ...body, instruction: '失败后保留草稿' }, '')
    assert.equal(store.getState().draft, '失败后保留草稿')
    assert.match(store.getState().error || '', /测试请求失败/)
    assert.equal(store.getState().messages.some(item => item.phase === 'executed'), false, 'Failed request cannot claim execution')
    request.post = (async (path: string) => {
      current.revision++
      if (path.endsWith('/approve')) current.status = 'awaiting_approval'
      if (path.endsWith('/undo')) current.result = { plan_id: safePlan.plan_id, status: 'executed', undo_available: true }
      return structuredClone(current)
    }) as typeof request.post
    current.status = 'awaiting_approval'; current.result = null; current.revision++
    await store.getState().refresh()
    assert.equal(await store.getState().execute(store.getState().messages.at(-1)!.id), false, 'Unconfirmed execution status does not return success')
    current.status = 'completed'; current.result = { plan_id: safePlan.plan_id, status: 'executed', undo_available: true }; current.revision++
    await store.getState().refresh()
    assert.equal(await store.getState().undo(store.getState().messages.at(-1)!.id), false, 'Unconfirmed undo status does not return success')
    assert.match(store.getState().error || '', /未确认撤销成功/)
    request.post = workingPost
    let runtime = 'process-one'
    request.get = (async (path: string) => structuredClone(path === '/organizer/sessions' ? { sessions: [current], runtime_id: runtime } : current)) as typeof request.get
    await store.getState().initialize()
    assert.equal(store.getState().session, null, 'Unknown previous backend opens a new conversation')
    await store.getState().restore(current.session_id)
    await store.getState().initialize()
    assert.equal(store.getState().session?.session_id, current.session_id, 'Same backend restores active conversation')
    runtime = 'process-two'
    await store.getState().initialize()
    assert.equal(store.getState().session, null, 'Restarted backend opens fresh conversation')
    assert.equal(store.getState().messages.length, 0)
    assert.equal(store.getState().sessions.length, 1, 'Restart keeps explicitly accessible history')
    store.getState().setModel({ provider_id: 'preview-2', model_name: 'gemini-3.8-flash' })
    store.getState().setControls({ reasoning_effort: 'medium', context_limit: 272000 })
    const savedPreferences = [...storage.entries()].find(([key]) => key.endsWith('-composer'))
    assert.ok(savedPreferences)
    const preferences = JSON.parse(savedPreferences![1]).state
    assert.deepEqual(Object.keys(preferences).sort(), ['controls', 'model', 'modelOverridden'])
    assert.equal(preferences.model.model_name, 'gemini-3.8-flash')
    assert.equal(preferences.controls.reasoning_effort, 'medium')
    console.log('Organizer sessions: revisions, follow-up, cancellation race, query scope, explicit recovery, stale poll, server restoration, composer preferences passed')
  } finally { request.get = originalGet; request.post = originalPost }
}
void run().catch(error => { console.error(error); process.exitCode = 1 })
