// Run from BillNote_frontend: node scripts/check-preview-mock.mjs
// Uses synthetic in-memory browser storage; never starts a server or calls a model.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

class MemoryStorage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}
globalThis.localStorage = new MemoryStorage()
globalThis.sessionStorage = new MemoryStorage()
let reloads = 0
globalThis.location = { search: '', hash: '#/organizer', reload() { reloads += 1 } }
// Catch any accidental network fallback, including future adapter refactors.
globalThis.fetch = () => { throw new Error('Tests prohibit network access') }
globalThis.XMLHttpRequest = class { constructor() { throw new Error('Tests prohibit network access') } }
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/dev/previewMock.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) }, logLevel: 'warning' })
const source = bundled.outputFiles[0].text
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const oldKey = 'bilinote-ui-preview-synthetic-v2'
const oldSnapshot = JSON.stringify({ tasks: [{ id: 'ui-sample-1' }], providers: [1, 2, 3].map(index => ({ id: `preview-${index}`, name: `保留服务商 ${index}`, enabled: 1 })), models: [1, 2, 3].map(index => ({ id: index, provider_id: `preview-${index}`, model_name: '通用示例模型' })) })
localStorage.setItem(oldKey, oldSnapshot)
localStorage.setItem('bilinote-preview-purpose-initialized-v1', 'preserved-defaults')
localStorage.setItem('bilinote-preview-settings-v1', JSON.stringify({ transcriber_type: 'bcut', whisper_model_size: 'base', custom: {}, downloaded: ['base'] }))
const mock = await import(moduleUrl)
const request = async (url, data, method = 'post', adapter = mock.previewAdapter) => {
  const result = await adapter({ url, method, data: JSON.stringify(data || {}) })
  assert.equal(result.data.code, 0, result.data.msg)
  return result.data.data
}
const plan = (instruction, scope = { kind: 'all' }) => request('/organizer/plan', { instruction, scope, provider_id: 'preview-3', model_name: '通用示例模型' })
const providers = await request('/get_all_providers', {}, 'get')
assert.equal(providers.length, 3)
assert.equal(providers[0].name, '保留服务商 1')
assert.equal(localStorage.getItem(oldKey), oldSnapshot)
assert.equal(localStorage.getItem(mock.PREVIEW_DEFAULTS_KEY), 'preserved-defaults')
assert.equal((await request('/transcriber_config', {}, 'get')).transcriber_type, 'bcut')
const tasks = await request('/notes', {}, 'get')
assert.deepEqual(tasks.map(task => task.id), Array.from({ length: 9 }, (_, index) => `ui-general-${index + 1}`))
assert(tasks[1].markdown[0].content.includes('汇总数量'))
assert(tasks[2].transcript.full_text.includes('循环'))
assert(tasks[3].markdown[0].content.includes('采购清单'))
assert.equal(new Set(tasks.filter(task => task.status === 'SUCCESS').map(task => task.transcript.full_text)).size, 8)
const models = await request('/model_list', {}, 'get')
assert.equal(new Set(models.map(model => model.provider_id)).size, 3)
assert.equal(new Set(models.map(model => model.model_name)).size, 3)
const query = await plan('找出未归档的编程笔记')
assert.equal(query.operations.length, 0)
assert.deepEqual(query.query_note_ids, ['ui-general-3'])
const create = await plan('新建文件夹「测试文件夹」')
assert.equal(create.operations[0].type, 'create_folder')
await request('/organizer/execute', { plan_id: create.plan_id })
assert((await request('/note_folders', {}, 'get')).folders.some(folder => folder.name === '测试文件夹'))
await request('/organizer/undo', { plan_id: create.plan_id })
const rename = await plan('把「办公效率」重命名为「办公资料」')
assert.equal(rename.operations[0].name, '办公资料')
await request('/organizer/execute', { plan_id: rename.plan_id })
assert((await request('/note_folders', {}, 'get')).folders.some(folder => folder.name === '办公资料'))
await request('/organizer/undo', { plan_id: rename.plan_id })
const classify = await plan('按主题分类')
assert(classify.operations.some(operation => operation.type === 'move_notes'))
await request('/organizer/execute', { plan_id: classify.plan_id })
const classifiedFolders = (await request('/note_folders', {}, 'get')).folders
assert(['学习方法', '办公效率', '编程入门', '生活技能', '沟通表达', '信息检索'].every(name => classifiedFolders.some(folder => folder.name === name)))
const folderCount = (await request('/note_folders', {}, 'get')).folders.length
await request('/organizer/execute', { plan_id: classify.plan_id })
assert.equal((await request('/note_folders', {}, 'get')).folders.length, folderCount)
await request('/organizer/undo', { plan_id: classify.plan_id })
const topicTags = await plan('给选中笔记设置主题标签', { kind: 'selected', task_ids: ['ui-general-3', 'ui-general-4'] })
assert.deepEqual(topicTags.operations.map(operation => operation.tags), [['编程入门'], ['生活技能']])
const archive = await plan('归档选中笔记', { kind: 'selected', task_ids: ['ui-general-1'] })
await request('/organizer/execute', { plan_id: archive.plan_id })
assert((await request('/notes', {}, 'get'))[0].archived_at)
const restore = await plan('恢复选中笔记', { kind: 'selected', task_ids: ['ui-general-1'] })
await request('/organizer/execute', { plan_id: restore.plan_id })
assert.equal((await request('/notes', {}, 'get'))[0].archived_at, null)
const tags = await plan('设置标签「复习、练习」', { kind: 'selected', task_ids: ['ui-general-1'] })
await request('/organizer/execute', { plan_id: tags.plan_id })
assert.deepEqual((await request('/note_library', {}, 'get')).entries['ui-general-1'].tags, ['复习', '练习'])
assert(localStorage.getItem(mock.PREVIEW_STORAGE_KEY))
const stale = await plan('归档选中笔记', { kind: 'selected', task_ids: ['ui-general-4'] })
await request('/note_library/update', { task_ids: ['ui-general-4'], changes: { remark: '后续修改' } })
assert.equal((await mock.previewAdapter({ url: '/organizer/execute', method: 'post', data: { plan_id: stale.plan_id } })).data.code, 1)
assert.equal((await mock.previewAdapter({ url: '/organizer/undo', method: 'post', data: { plan_id: tags.plan_id } })).data.code, 1)
const reply = await request('/chat/ask', { task_id: 'ui-general-1', question: '怎么练习？', provider_id: 'preview-2', model_name: '通用示例模型', attachments: [{ type: 'image', name: '示例图片', data_url: 'data:image/png;base64,aGVsbG8=' }] })
assert(reply.answer.includes('模拟回答'))
assert(reply.answer.includes('未进行真实视觉识别'))
assert(reply.sources.length)
assert(reply.answer.includes('间隔复习'))
const programmingReply = await request('/chat/ask', { task_id: 'ui-general-3', question: '如何练习？', provider_id: 'preview-2', model_name: '通用示例模型' })
assert(programmingReply.answer.includes('用循环处理列表'))
assert.notEqual(programmingReply.sources[0].text, reply.sources[0].text)
const generated = await request('/generate_note', { provider_id: 'preview-1', model_name: '通用示例模型', video_url: 'https://example.invalid/video' })
assert.equal((await request(`/task_status/${generated.task_id}`, {}, 'get')).status, 'SUCCESS')
const reloaded = await import(`${moduleUrl}#reload`)
assert(reloaded.getPreviewTasks().some(task => task.id === generated.task_id))
assert.deepEqual((await request('/note_library', {}, 'get', reloaded.previewAdapter)).entries['ui-general-1'].tags, ['复习', '练习'])
const providerId = await request('/add_provider', { name: '自定义模拟服务商', api_key: 'DO-NOT-PERSIST-THIS-SECRET', base_url: 'https://example.invalid' })
await request('/models', { provider_id: providerId, model_name: '通用示例模型' })
assert.equal((await request(`/model_enable/${providerId}`, {}, 'get')).length, 1)
await request('/update_provider', { id: providerId, name: '已编辑服务商', enabled: 0 })
assert.equal((await request(`/get_provider_by_id/${providerId}`, {}, 'get')).enabled, 0)
assert.equal((await request('/model_list', {}, 'get')).some(model => model.provider_id === providerId), false)
assert.equal(localStorage.getItem(mock.PREVIEW_STORAGE_KEY).includes('DO-NOT-PERSIST-THIS-SECRET'), false)
assert((await request('/connect_test', { id: providerId })).simulated)
assert.equal((await mock.previewAdapter({ url: '/unimplemented', method: 'get' })).data.code, 1)

const currentSnapshot = localStorage.getItem(mock.PREVIEW_STORAGE_KEY)
const oldV3 = JSON.parse(currentSnapshot)
delete oldV3.sample_version
oldV3.tasks = oldV3.tasks.filter(task => task.id !== 'ui-general-9')
delete oldV3.assignments['ui-general-9']
oldV3.entries['ui-general-3'] = { favorite: false, pinned: false, learning_status: 'unread', tags: ['保留标签'], remark: '保留内容' }
localStorage.setItem(mock.PREVIEW_STORAGE_KEY, JSON.stringify(oldV3))
const migrated = await import(`${moduleUrl}#v3-migration`)
assert.equal(migrated.getPreviewTasks().length, oldV3.tasks.length + 1)
assert.deepEqual(migrated.getPreviewTasks().filter(task => task.id !== 'ui-general-9'), oldV3.tasks)
assert.deepEqual((await request('/note_library', {}, 'get', migrated.previewAdapter)).entries['ui-general-3'], oldV3.entries['ui-general-3'])
assert.deepEqual(await request('/get_all_providers', {}, 'get', migrated.previewAdapter), oldV3.providers)
assert.equal((await request('/transcriber_config', {}, 'get', migrated.previewAdapter)).transcriber_type, 'bcut')
localStorage.setItem(mock.PREVIEW_STORAGE_KEY, currentSnapshot)

// Stateful organizer fixture: snapshots, narrow scope, revision checks and refresh recovery.
const sessionBase = '/organizer/sessions'
let session = await request(sessionBase, { scope: { kind: 'all' } })
const sessionUrl = `${sessionBase}/${session.session_id}`
const modelConfig = { provider_id: 'preview-3', model_name: '通用示例模型' }
const message = async instruction => {
  session = await request(`${sessionUrl}/message`, { ...modelConfig, instruction, scope: { kind: 'all' }, expected_revision: session.revision, request_id: crypto.randomUUID() })
  assert.equal(session.history.length, session.messages.length)
  return session
}
const beforeSession = JSON.stringify(await request('/notes', {}, 'get'))
await message('那归档')
assert.equal(session.status, 'clarification')
assert.equal(session.scope.authorized, false)
await message('删除办公效率下面笔记')
assert.equal(session.status, 'refused')
assert.equal(session.scope.folder_id, 'office')
await message('那归档')
assert.equal(session.status, 'awaiting_approval')
assert.deepEqual(session.plan.operations[0].task_ids, ['ui-general-2', 'ui-general-9'])
assert.equal(JSON.stringify(await request('/notes', {}, 'get')), beforeSession, 'draft never writes library')
const oldPlanId = session.plan.plan_id
assert.equal((await mock.previewAdapter({ url: '/organizer/execute', method: 'post', data: { plan_id: oldPlanId } })).data.code, 1, 'legacy execution cannot bypass session approval')
await message('排除已收藏的')
assert.deepEqual(session.plan.operations[0].task_ids, ['ui-general-9'])
assert.equal(session.target_summary.exclude_favorites, true)
const oldApproval = await mock.previewAdapter({ url: `${sessionUrl}/approve`, method: 'post', data: { expected_revision: session.revision, request_id: 'old-plan', plan_id: oldPlanId } })
assert.equal(oldApproval.data.code, 1)
const fresh = await import(`${moduleUrl}#session-refresh`)
assert.deepEqual(await request(sessionUrl, {}, 'get', fresh.previewAdapter), session)
const approveBody = { expected_revision: session.revision, request_id: 'approve-once', plan_id: session.plan.plan_id, api_key: 'SESSION-SECRET-NEVER-PERSIST' }
session = await request(`${sessionUrl}/approve`, approveBody, 'post', fresh.previewAdapter)
assert.equal(session.result.status, 'executed')
assert.deepEqual(await request(`${sessionUrl}/approve`, approveBody, 'post', fresh.previewAdapter), session, 'duplicate request returns exact receipt')
const afterArchive = await request('/notes', {}, 'get', fresh.previewAdapter)
assert(afterArchive.find(task => task.id === 'ui-general-9').archived_at)
assert.equal(afterArchive.find(task => task.id === 'ui-general-2').archived_at, null)
assert.equal(afterArchive.find(task => task.id === 'ui-general-3').archived_at, null)
assert.equal(localStorage.getItem(mock.PREVIEW_ORGANIZER_KEY).includes('SESSION-SECRET-NEVER-PERSIST'), false)
const afterRefresh = await import(`${moduleUrl}#undo-refresh`)
session = await request(`${sessionUrl}/undo`, { expected_revision: session.revision, request_id: 'undo-once', plan_id: session.plan.plan_id }, 'post', afterRefresh.previewAdapter)
assert.equal(session.result.status, 'undone')
assert.equal(JSON.stringify(await request('/notes', {}, 'get', afterRefresh.previewAdapter)), beforeSession)
assert((await request(sessionBase, {}, 'get', afterRefresh.previewAdapter)).sessions.some(item => item.session_id === session.session_id))
let emptySession = await request(sessionBase, { scope: { kind: 'selected', task_ids: ['ui-general-2'] } }, 'post', afterRefresh.previewAdapter)
const emptyUrl = `${sessionBase}/${emptySession.session_id}`
emptySession = await request(`${emptyUrl}/message`, { ...modelConfig, instruction: '归档选中笔记，排除已收藏的', expected_revision: 0, request_id: 'empty-filter' }, 'post', afterRefresh.previewAdapter)
assert.equal(emptySession.status, 'completed')
assert.equal(emptySession.target_summary.count, 0)
assert.equal(emptySession.plan, null)
assert.equal((await afterRefresh.previewAdapter({ url: `${emptyUrl}/message`, method: 'post', data: { ...modelConfig, instruction: '归档', expected_revision: 0, request_id: 'stale-revision' } })).data.code, 1)
assert.equal((await afterRefresh.previewAdapter({ url: `${emptyUrl}/message`, method: 'post', data: { ...modelConfig, instruction: '不同内容', expected_revision: 0, request_id: 'empty-filter' } })).data.code, 1, 'request id reuse with different payload is rejected')
assert.equal((await afterRefresh.previewAdapter({ url: `${emptyUrl}/approve`, method: 'post', data: { expected_revision: emptySession.revision, request_id: 'empty-confirm' } })).data.code, 1)
session = await request(`${sessionUrl}/message`, { ...modelConfig, instruction: '那归档', expected_revision: session.revision, request_id: 'cancel-draft' }, 'post', afterRefresh.previewAdapter)
const cancelledId = session.plan.plan_id
session = await request(`${sessionUrl}/cancel`, { expected_revision: session.revision, request_id: 'cancel', plan_id: cancelledId }, 'post', afterRefresh.previewAdapter)
assert.equal(session.status, 'cancelled')
assert.equal((await afterRefresh.previewAdapter({ url: `${sessionUrl}/approve`, method: 'post', data: { expected_revision: session.revision, request_id: 'cancelled-confirm', plan_id: cancelledId } })).data.code, 1)
let regression = await request(sessionBase, { scope: { kind: 'all' } }, 'post', afterRefresh.previewAdapter)
const regressionUrl = `${sessionBase}/${regression.session_id}`
const regressionMessage = async (instruction, scope = { kind: 'all' }) => {
  regression = await request(`${regressionUrl}/message`, { ...modelConfig, instruction, scope, expected_revision: regression.revision, request_id: crypto.randomUUID() }, 'post', afterRefresh.previewAdapter)
  return regression
}
await regressionMessage('归档办公效率下面笔记')
assert.equal(regression.scope.folder_id, 'office')
assert.deepEqual(regression.query_scope, { kind: 'all' })
await regressionMessage('排除已收藏的')
assert.deepEqual(regression.plan.operations[0].task_ids, ['ui-general-9'])
await regressionMessage('包含已收藏的')
assert.deepEqual(regression.plan.operations[0].task_ids, ['ui-general-2', 'ui-general-9'])
await regressionMessage('不要归档先解释')
assert.equal(regression.plan, null)
assert.equal(regression.pending_plan_id, null)
await regressionMessage('归档不存在的文件夹下面笔记')
assert.equal(regression.status, 'clarification')
assert.equal(regression.scope.authorized, false)
await regressionMessage('那归档')
assert.equal(regression.plan, null)
assert.equal(regression.scope.authorized, false)
await regressionMessage('归档选中笔记', { kind: 'selected', task_ids: ['ui-general-9'] })
assert.deepEqual(regression.query_scope, { kind: 'selected', task_ids: ['ui-general-9'] })
const finalReload = await import(`${moduleUrl}#query-scope-refresh`)
assert.deepEqual((await request(regressionUrl, {}, 'get', finalReload.previewAdapter)).query_scope, regression.query_scope)
await regressionMessage('归档所有笔记', { kind: 'selected', task_ids: ['ui-general-9'] })
assert.deepEqual(regression.plan.operations[0].task_ids, ['ui-general-9'], 'explicit all cannot exceed selected query upper bound')

const indexedRecords = new Map([['task-storage', 'task snapshot'], ['bilinote-reading-assistant-v1', 'chat snapshot'], ['unrelated-record', 'keep']])
localStorage.setItem('bilinote-purpose-models-v1', 'defaults')
localStorage.setItem('bilinote-reader-settings-v1', 'reader')
localStorage.setItem('bilinote-selected-folder', 'office')
localStorage.setItem('unrelated-key', 'keep')
sessionStorage.setItem('bilinote-preview-draft', 'draft')
sessionStorage.setItem('unrelated-session', 'keep')
let clearedStores = false
await mock.resetPreviewData(async () => {
  indexedRecords.delete('task-storage')
  indexedRecords.delete('bilinote-reading-assistant-v1')
  clearedStores = true
})
assert(clearedStores)
assert.equal(indexedRecords.size, 1)
assert.equal(indexedRecords.get('unrelated-record'), 'keep')
assert.equal(localStorage.length, 1)
assert.equal(localStorage.getItem('unrelated-key'), 'keep')
assert.equal(sessionStorage.length, 1)
assert.equal(sessionStorage.getItem('unrelated-session'), 'keep')
assert.equal(location.hash, '/')
assert.equal(reloads, 1)
console.log('PASS: legacy mock + stateful sessions/refusal-retains-target/narrow archive/favorite exclusion/empty rejection/revision/idempotency/refresh/old approval rejection/cancel/undo/no secrets/no network/reset boundaries')
