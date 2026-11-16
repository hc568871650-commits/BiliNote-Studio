import { get, set, keys } from 'idb-keyval'
import { createTaskStorage } from '@/utils/taskStorage'
import { createReadingSessionStorage } from '@/utils/readingSessionStorage'
import { createRecordStorage } from '@/utils/recordStorage'
import { recordStorageDriver } from '@/utils/recordStorageDriver'
import type { ReadingSession } from '@/store/readingAssistantStore'

async function runStorageChecks() {
  const checks: string[] = []
  const check = (name: string, value: unknown) => { if (!value) throw new Error(name); checks.push(name) }
  const taskName = 'storage-check-tasks'
  const tasks = Array.from({ length: 100 }, (_, index) => ({ id: String(index), status: 'SUCCESS', markdown: '长笔记'.repeat(10000) }))
  const legacy = JSON.stringify({ state: { tasks, currentTaskId: '0' }, version: 0 })
  await set(taskName, legacy)
  const storage = createTaskStorage<{ tasks: typeof tasks; currentTaskId: string | null }>()
  const restored = (await storage.getItem(taskName))!
  check('旧笔记格式可读取', restored.state.tasks.length === 100 && restored.state.tasks[99].markdown === tasks[99].markdown)
  await storage.setItem(taskName, restored)
  check('迁移保留原始备份', await get(taskName) === legacy)
  const writes: { key: string; bytes: number }[] = []
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function(value, key) {
    writes.push({ key: String(key), bytes: JSON.stringify(value)?.length || 0 })
    return originalPut.call(this, value, key)
  }
  try {
    for (let index = 0; index < 40; index++) await storage.setItem(taskName, { state: { ...restored.state, currentTaskId: String(index + 1) }, version: 0 })
    check('40次切换只写40个选中项', writes.length === 40 && writes.every(write => write.key.includes('currentTaskId') && write.bytes < 10))
    const switched = await createTaskStorage<{ tasks: typeof tasks; currentTaskId: string | null }>().getItem(taskName)
    check('重建存储适配器后选中项与正文完整', switched?.state.currentTaskId === '40' && switched.state.tasks[99].markdown === tasks[99].markdown)
    const sessions: Record<string, ReadingSession> = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`note:${i}`, {
      messages: [{ id: `user-${i}`, role: 'user', content: '问题', attachments: [{ id: `image-${i}`, type: 'image', name: '样图', data_url: 'data:image/png;base64,' + 'x'.repeat(250000) }] }, { id: `answer-${i}`, role: 'assistant', content: '历史回答'.repeat(1000) }], input: '旧草稿', attachments: [],
    }]))
    const name = 'storage-check-reading'
    const oldReading = JSON.stringify({ state: { sessions }, version: 0 })
    await set(name, oldReading)
    const reading = createReadingSessionStorage()
    const read = (await reading.getItem(name))!
    await reading.setItem(name, read)
    writes.length = 0
    for (let index = 0; index < 30; index++) await reading.setItem(name, { state: { sessions: { ...read.state.sessions, 'note:0': { ...read.state.sessions['note:0'], input: `新草稿${index}` } } }, version: 0 })
    check('30次输入只写当前会话草稿，无历史或图片重写', writes.length === 30 && writes.every(write => write.key.includes('input') && write.bytes < 30))
    const saved = (await createReadingSessionStorage().getItem(name))!
    check('草稿、历史图片及其他会话完整恢复', saved.state.sessions['note:0'].input === '新草稿29' && saved.state.sessions['note:0'].messages[0].attachments![0].data_url === sessions['note:0'].messages[0].attachments![0].data_url && saved.state.sessions['note:19'].input === '旧草稿')
    writes.length = 0
    const updated = { ...saved.state.sessions, 'note:0': { ...saved.state.sessions['note:0'], messages: [saved.state.sessions['note:0'].messages[0], { ...saved.state.sessions['note:0'].messages[1], content: '追加回复' }] } }
    // Use the original references after hydration so this checks only the changed message.
    const hydratedReading = createReadingSessionStorage()
    const hydrated = (await hydratedReading.getItem(name))!
    const streamState = hydrated.state
    streamState.sessions = { ...streamState.sessions, 'note:0': { ...streamState.sessions['note:0'], messages: [streamState.sessions['note:0'].messages[0], { ...streamState.sessions['note:0'].messages[1], content: '追加回复' }] } }
    await hydratedReading.setItem(name, { state: streamState, version: 0 })
    check('流式快照只写变动消息', writes.length === 1 && writes[0].key.includes('message') && writes[0].bytes < 200)
    await hydratedReading.setItem(name, { state: { sessions: { ...streamState.sessions, 'temporary:0': updated['note:0'] } }, version: 0 })
    check('临时会话不持久化', !(await hydratedReading.getItem(name))!.state.sessions['temporary:0'])
    await hydratedReading.setItem(name, { state: { sessions: { 'note:0': { messages: [], input: '', attachments: [] } } }, version: 0 })
    const cleared = (await createReadingSessionStorage().getItem(name))!.state.sessions
    check('清空删除旧消息及其他会话分片', Object.keys(cleared).length === 1 && cleared['note:0'].messages.length === 0 && (await keys()).filter(key => String(key).includes(name)).length === 5)
    await hydratedReading.removeItem(name)
    check('清除存储后旧备份不会复活', await createReadingSessionStorage().getItem(name) === null && await get(name) === oldReading)
  } finally { IDBObjectStore.prototype.put = originalPut }

  const atomic = createRecordStorage<Record<string, unknown>>(state => ({ ...state }), fields => fields)
  await atomic.setItem('atomic-check', { state: { first: '旧值', second: '旧值' }, version: 0 })
  let rejected = false
  try { await atomic.setItem('atomic-check', { state: { first: '不应提交', second: () => {} }, version: 0 }) } catch { rejected = true }
  const failed = await recordStorageDriver.read('atomic-check')
  check('写入中途失败整批回滚', rejected && failed.fields.first === '旧值' && failed.fields.second === '旧值')
  const legacyFailure = JSON.stringify({ state: { first: '迁移前的数据', second: '仍需保留' }, version: 0 })
  await set('migration-failure', legacyFailure)
  try { await atomic.setItem('migration-failure', { state: { first: '部分迁移', second: () => {} }, version: 0 }) } catch { /* Expected clone failure. */ }
  const oldAfterFailure = await createRecordStorage<Record<string, unknown>>(state => ({ ...state }), fields => fields).getItem('migration-failure')
  check('首次迁移失败仍完整读取旧格式', oldAfterFailure?.state.first === '迁移前的数据' && oldAfterFailure.state.second === '仍需保留' && await get('migration-failure') === legacyFailure)
  await atomic.setItem('atomic-check', { state: { first: '重试成功', second: '完整' }, version: 0 })
  check('失败后下一次写入可以重试', (await atomic.getItem('atomic-check'))!.state.first === '重试成功')
  const queued = Array.from({ length: 25 }, (_, i) => atomic.setItem('atomic-check', { state: { first: i, second: i }, version: 0 }))
  await Promise.all(queued); await atomic.flush()
  const last = (await atomic.getItem('atomic-check'))!.state
  check('快速连续写入顺序与最终快照一致', last.first === 24 && last.second === 24)
  return { checks, taskSwitchWrites: 40, draftWrites: 30 }
}
Object.assign(window, { runStorageChecks })
