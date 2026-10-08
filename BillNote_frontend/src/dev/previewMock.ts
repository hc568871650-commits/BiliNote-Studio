import type { AxiosAdapter } from 'axios'
import type { Task } from '@/store/taskStore'
import type { NoteLibraryEntry } from '@/services/noteLibrary'
import type { ChatMessage } from '@/services/chat'
import { estimateLocalContext } from '@/utils/aiSettings'
import type { OrganizerOperation, OrganizerPlan, OrganizerScope, OrganizerRetentionPreview } from '@/services/organizer'
import type { GroqConnection } from '@/services/transcriber'

export const PREVIEW_STORAGE_KEY = 'bilinote-ui-preview-synthetic-v3'
export const PREVIEW_DEFAULTS_KEY = 'bilinote-preview-purpose-initialized-v1'
export const PREVIEW_SETTINGS_KEY = 'bilinote-preview-settings-v1'
export const PREVIEW_ORGANIZER_KEY = 'bilinote-organizer-preview-sessions-v1'
export const PREVIEW_RETENTION_KEY = 'bilinote-organizer-preview-retention-v1'
const sampleModel = '通用示例模型'
interface PreviewProvider { id: string; name: string; logo: string; api_key: string; base_url: string; type: string; enabled: number }
interface PreviewModel { id: number; provider_id: string; model_name: string }
interface PreviewLibrary { tasks: Task[]; folders: { id: string; name: string }[]; assignments: Record<string, string>; entries: Record<string, NoteLibraryEntry> }
interface PreviewState extends PreviewLibrary { providers: PreviewProvider[]; models: PreviewModel[]; sample_version?: number }
interface PreviewBody {
  protocol?: string;
  history?: ChatMessage[]; summary?: string; keep_recent?: 0 | 4;
  operation?: 'create' | 'set_limit'; limit?: number; confirmation_token?: string;
  request_id?: string; expected_revision?: number;
  instruction?: string; scope?: OrganizerScope; plan_id?: string; task_id?: string; task_ids?: string[];
  folder_id?: string; name?: string; changes?: Partial<NoteLibraryEntry>; provider_id?: string; model_name?: string;
  id?: string; base_url?: string; api_key?: string; type?: string; logo?: string; enabled?: number | boolean; url?: string; cookie?: string;
  question?: string; context_mode?: string; attachments?: { type: string; name: string; text?: string; data_url?: string }[];
  tasks?: Task[]; video_url?: string; platform?: string; quality?: string; style?: string;
  transcriber_type?: string; groq_model?: string; groq_connection?: GroqConnection; whisper_model_size?: string; mlx_whisper_model_size?: string; model_size?: string; target?: string
}
interface PreviewSettings { groq_model: string; transcriber_type: string; whisper_model_size: string; mlx_whisper_model_size: string; custom: Record<string, string>; downloaded: string[] }
// Network configuration is inert and session-only in the UI sandbox.
let previewProxy = { enabled: false, url: '', effective: '' }
let previewGroqConnection: GroqConnection = { base_url: 'https://api.groq.com/openai/v1', api_key: '', enabled: true }
const previewCookies = new Set<string>()
export type PreviewChatScenario = 'normal' | 'slow' | 'upstream-error' | 'timeout'
let previewChatScenario: PreviewChatScenario = 'normal'
export const setPreviewChatScenario = (scenario: PreviewChatScenario) => { previewChatScenario = scenario }
const previewBuiltins = { tiny: 'preview-synthetic/tiny', base: 'preview-synthetic/base', small: 'preview-synthetic/small' }
const previewTypes = [
  { value: 'fast-whisper', label: 'Faster Whisper（本地模拟）' },
  { value: 'bcut', label: '必剪（在线模拟）' },
  { value: 'kuaishou', label: '快手（在线模拟）' },
  { value: 'groq', label: 'Groq（在线模拟）' },
  { value: 'mlx-whisper', label: 'MLX Whisper（当前模拟环境不可用）' },
]
const isPreviewModelName = (name: string) => /^[\w.-]{1,80}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name)
let settings: PreviewSettings = { groq_model: 'whisper-large-v3-turbo', transcriber_type: 'fast-whisper', whisper_model_size: 'base', mlx_whisper_model_size: 'tiny', custom: {}, downloaded: ['base'] }
try {
  const saved = JSON.parse(localStorage.getItem(PREVIEW_SETTINGS_KEY) || 'null') as PreviewSettings | null
  if (saved && previewTypes.some(type => type.value === saved.transcriber_type) && typeof saved.whisper_model_size === 'string' && saved.custom && typeof saved.custom === 'object' && !Array.isArray(saved.custom) && Array.isArray(saved.downloaded)) {
    // Copy only the explicitly allowed settings fields, never credentials or arbitrary request data.
    const custom = Object.fromEntries(Object.entries(saved.custom).filter(([name, target]) => isPreviewModelName(name) && !Object.prototype.hasOwnProperty.call(previewBuiltins, name) && typeof target === 'string'))
    const names = [...Object.keys(previewBuiltins), ...Object.keys(custom)]
    settings = { groq_model: saved.groq_model || 'whisper-large-v3-turbo', transcriber_type: saved.transcriber_type, whisper_model_size: names.includes(saved.whisper_model_size) ? saved.whisper_model_size : 'base', mlx_whisper_model_size: names.includes(saved.mlx_whisper_model_size) ? saved.mlx_whisper_model_size : 'tiny', custom, downloaded: saved.downloaded.filter(name => names.includes(name)) }
  }
} catch { /* Invalid preview settings fall back to synthetic defaults. */ }
const persistSettings = () => { try { localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify(settings)) } catch { /* In-memory settings remain usable. */ } }
const previewModelNames = () => [...Object.keys(previewBuiltins), ...Object.keys(settings.custom)]
const previewTranscriberConfig = () => ({ groq_model: settings.groq_model, groq_connection: { ...previewGroqConnection, api_key: previewGroqConnection.api_key ? '********' : '' }, transcriber_type: settings.transcriber_type, whisper_model_size: settings.whisper_model_size, mlx_whisper_model_size: settings.mlx_whisper_model_size, available_types: previewTypes, whisper_model_sizes: previewModelNames(), whisper_builtin_models: previewBuiltins, whisper_custom_models: settings.custom, mlx_whisper_available: false, simulated: true })
interface PreviewJournal { plan: OrganizerPlan; fingerprint: string; before?: PreviewLibrary; after?: string; status: 'planned' | 'executed' | 'undone'; session_id?: string }
const journals = new Map<string, PreviewJournal>()
const clone = <T,>(value: T): T => structuredClone(value)
const blankEntry = (): NoteLibraryEntry => ({ favorite: false, pinned: false, learning_status: 'unread', tags: [], remark: '' })
interface PreviewSample { title: string; topic: string; overview: string; steps: string[]; check: string; practice: string }
const samples: PreviewSample[] = [
  { title: '学习方法：用主动回忆巩固知识', topic: '学习方法', overview: '读完一小节后合上资料，用自己的话回答关键问题，再对照原文补足遗漏。', steps: ['把章节目标写成三个问题。', '不看资料尝试回答，标出不确定处。', '回到原文核对，并安排间隔复习。'], check: '能解释核心概念，并用一个例子说明它。', practice: '选择今天学到的一个概念，写出问题、回答和待复习点。' },
  { title: '办公效率：表格整理与数据核对', topic: '办公效率', overview: '先统一列名与数据格式，再处理重复项和缺失值，最后用汇总结果核对总量。', steps: ['保留原始表格副本，明确每列含义。', '统一日期、数字和文本格式，标记异常值。', '按业务维度汇总，并与原始总量核对。'], check: '列名清晰、格式一致，汇总数量与原始记录对应。', practice: '整理一张小型清单，记录清理前后的行数与差异。' },
  { title: '编程入门：变量、条件与循环', topic: '编程入门', overview: '变量保存数据，条件决定分支，循环重复操作。先用小例子理解，再逐步组合。', steps: ['用变量保存一个数字或一段文字。', '写一个条件判断，并覆盖两种分支。', '用循环处理列表，观察每次输出。'], check: '输入正常值、边界值和空列表时，结果符合预期。', practice: '写一个统计列表中满足条件项目数量的小程序。' },
  { title: '生活技能：一周备餐与食材管理', topic: '生活技能', overview: '按用餐人数安排菜单，先查看已有食材，再列采购清单；保存和食用时遵循食材标签与卫生要求。', steps: ['盘点现有食材和可用烹饪时间。', '规划几道能共享食材的菜品。', '按份量列清单，标记购买日期与存放位置。'], check: '菜单、人数和采购份量一致，食材保存要求已核对。', practice: '为两顿家常饭做一份菜单和采购清单。' },
  { title: '沟通表达：让会议记录更清晰', topic: '沟通表达', overview: '区分讨论背景、已确认决定和待办事项，让参与者能直接找到下一步行动。', steps: ['先写会议目标与参与者。', '记录结论及未解决问题，避免把猜测写成决定。', '为每项待办注明负责人和截止时间。'], check: '每项行动有明确负责人，结论能追溯到讨论内容。', practice: '把一段讨论整理为背景、决定、行动三部分。' },
  { title: '信息检索：比较来源与记录依据', topic: '信息检索', overview: '把问题拆成关键词，优先查原始资料，再比较发布日期、适用范围和不同来源的结论。', steps: ['明确问题与所需证据，列出关键词。', '查找原始文档，记录出处和日期。', '比较来源差异，区分事实、推断与待核实项。'], check: '关键结论有出处，资料范围与当前问题相符。', practice: '为一个日常问题整理两条来源与一段有依据的回答。' },
  { title: '导入失败的示例', topic: '导入检查', overview: '本条合成任务展示失败状态。实际导入时应先核对输入格式和提示信息。', steps: ['核对输入是否完整。', '记录错误提示。', '修正后再尝试导入。'], check: '失败原因和下一步可清楚说明。', practice: '用示例数据观察失败状态的界面。' },
  { title: '已归档：个人时间安排练习', topic: '学习方法', overview: '把目标拆成短小行动，为关键事项留出时间，并根据实际完成情况调整安排。', steps: ['列出本周最重要的事项。', '为每项安排可执行的时间段。', '复盘耗时与进展，调整下周计划。'], check: '安排包含具体行动和可用时间，能据实复盘。', practice: '写一份包含学习、工作和休息的单日计划。' },
  { title: '办公效率：邮件分类与待办清单', topic: '办公效率', overview: '按行动需求分类邮件，将需要跟进的事项放入清晰的待办清单。', steps: ['区分通知和行动请求。', '为待办记录截止日期。', '完成后复核并归档。'], check: '待办有负责人和日期。', practice: '用合成邮件整理一份待办清单。' },
]
const sampleForTitle = (title: string): PreviewSample => samples.find(sample => sample.title === title) || {
  title, topic: '通用学习', overview: '先明确资料主题与学习目标，再提取核心观点，使用小练习检查理解。',
  steps: ['记录资料主题和目标。', '整理关键观点与对应依据。', '用一个小练习检查理解，并记录疑问。'],
  check: '目标、要点和依据清楚，待核实问题已记录。', practice: '选择资料中的一个要点，用自己的话解释并举例。',
}
const sampleContent = (sample: PreviewSample) => `# ${sample.title}

> **模拟示例笔记**：用于本地界面验证，不来自真实视频，不代表模型生成结果。

## 01 · 核心思路

${sample.overview}

## 02 · 建立工作顺序

${sample.steps.map((step, index) => `${index + 1}. ${index === 0 ? `**${step}**` : step}`).join('\n')}

- 行内标记示例：\`Shift + A\`、\`Plane\`、\`1.000\`。

## 03 · 检查清单

| 阶段 | 关注点 | 完成标准 |
| --- | --- | --- |
| 理解 | ${sample.topic}的关键要点 | 能用自己的话说明 |
| 实践 | 按步骤完成小练习 | ${sample.check} |
| 复盘 | 结果与疑问 | 留下可追溯记录 |

## 04 · 复习与实践

${sample.practice}

## 05 · 记录与回顾

记录本次练习的结果、遇到的问题和下一步。下次复习时先回答问题，再回看资料。`
const syntheticTask = (id: string, title: string, modelName = sampleModel): Task => {
  const sample = sampleForTitle(title)
  return {
  id, status: 'SUCCESS', createdAt: new Date().toISOString(), archived_at: null,
  markdown: [{ ver_id: 'preview-v1', content: sampleContent(sample), style: 'tutorial', model_name: modelName, created_at: new Date().toISOString() }],
  transcript: { full_text: `模拟原文：${sample.overview}${sample.steps.join('')}`, language: 'zh', raw: null, segments: [{ start: 0, end: 15, text: sample.overview }, { start: 15, end: 30, text: sample.steps.join('') }] },
  audioMeta: { title, cover_url: '', duration: 720, file_path: '', platform: 'local', raw_info: null, video_id: 'sample' },
  formData: { video_url: '/sample.mp4', platform: 'local', quality: 'medium', model_name: modelName, provider_id: 'preview-1', style: 'tutorial', link: false, screenshot: false },
  }
}
const initialState = (): PreviewState => ({
  sample_version: 4,
  tasks: new URLSearchParams(location.search).get('empty') === '1' ? [] : samples.map((sample, index) => ({ ...syntheticTask(`ui-general-${index + 1}`, sample.title), ...(index === 6 ? { status: 'FAILED', markdown: '' } : {}), archived_at: index === 7 ? '2026-10-01T00:00:00Z' : null })),
  folders: [{ id: 'default', name: '默认文件夹' }, { id: 'office', name: '办公效率' }, { id: 'learning', name: '学习方法' }],
  assignments: { 'ui-general-1': 'learning', 'ui-general-2': 'office', 'ui-general-9': 'office' },
  entries: { 'ui-general-1': { ...blankEntry(), favorite: true, pinned: true, learning_status: 'learning', tags: ['主动回忆'] }, 'ui-general-2': { ...blankEntry(), favorite: true } },
  providers: [1, 2, 3].map(index => ({ id: `preview-${index}`, name: `示例服务商 ${index}（模拟）`, logo: '', api_key: '****模拟密钥****', base_url: `https://provider-${index}.example.invalid/v1`, type: 'custom', enabled: 1 })),
  models: [1, 2, 3].map(index => ({ id: index, provider_id: `preview-${index}`, model_name: sampleModel })),
})
let state = initialState()
try {
  const saved = JSON.parse(localStorage.getItem(PREVIEW_STORAGE_KEY) || 'null') as PreviewState | null
  if (saved && Array.isArray(saved.tasks) && saved.tasks.every(task => task.id.startsWith('ui-')) && Array.isArray(saved.folders) && saved.assignments && saved.entries && Array.isArray(saved.providers) && Array.isArray(saved.models)) state = saved
  else if (!saved) {
    // Keep the old synthetic library intact; migrate only user-configured model metadata.
    // New task IDs also isolate the new examples from old reading/chat sessions.
    const previous = JSON.parse(localStorage.getItem('bilinote-ui-preview-synthetic-v2') || 'null') as PreviewState | null
    if (previous && Array.isArray(previous.providers) && Array.isArray(previous.models)) {
      state.providers = previous.providers
      state.models = previous.models
    }
  }
} catch { /* Corrupt preview state falls back to synthetic examples. */ }
// Add the new fixture once, without replacing any existing notes, folders or settings.
if (state.sample_version !== 4) {
  if (state.tasks.length && !state.tasks.some(task => task.id === 'ui-general-9')) {
    state.tasks.push(syntheticTask('ui-general-9', samples[8].title))
    state.assignments['ui-general-9'] = 'office'
    if (!state.entries['ui-general-2']) state.entries['ui-general-2'] = { ...blankEntry(), favorite: true }
  }
  state.sample_version = 4
  try { localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(state)) } catch { /* Migration remains usable in this tab. */ }
}
const persist = () => { try { localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(state)) } catch { /* This tab remains usable without persistence. */ } }
// Named models exercise the controls; requests still terminate in this mock adapter.
for (const [id, model_name] of [[540, 'gpt-5.4'], [380, 'gemini-3.8-flash']] as const) {
  if (!state.models.some(model => model.provider_id === 'preview-2' && model.model_name === model_name)) state.models.push({ id, provider_id: 'preview-2', model_name })
}
const librarySnapshot = (): PreviewLibrary => clone({ tasks: state.tasks, folders: state.folders, assignments: state.assignments, entries: state.entries })
const fingerprint = () => JSON.stringify(librarySnapshot())
export const getPreviewTasks = () => clone(state.tasks)
export const previewDefaultModels = { generation: { provider_id: 'preview-1', model_name: sampleModel }, reading: { provider_id: 'preview-2', model_name: sampleModel }, organizer: { provider_id: 'preview-3', model_name: sampleModel } }
export async function resetPreviewData(clearPersistedSessions: () => Promise<void>) {
  // Clear only named business-store IndexedDB records through their store API.
  // Other IndexedDB records and unrelated local/session storage remain intact.
  await clearPersistedSessions()
  for (const storage of [localStorage, sessionStorage]) {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith('bilinote-')))
    keys.forEach(key => storage.removeItem(key))
  }
  journals.clear()
  organizerSessions.clear()
  location.hash = '/'
  location.reload()
}
const cleanName = (text: string) => text.replace(/[“”"'「」]/g, '').replace(/^[：:\s]+|[。！\s]+$/g, '').trim()
const newFolderName = (instruction: string) => {
  const match = instruction.match(/(?:新建|创建)(?:一个)?(?:逻辑)?文件夹(?:叫做|名为|叫|为|[：:])?\s*([“"'「][^”"'」]+[”"'」]|[^，。；\n]+)/u)
  return match ? cleanName(match[1]) : ''
}
const scopedTasks = (scope: OrganizerScope) => {
  if (scope.kind === 'selected') return state.tasks.filter(task => scope.task_ids?.includes(task.id))
  if (scope.kind === 'folder') return state.tasks.filter(task => (state.assignments[task.id] || 'default') === scope.folder_id)
  return state.tasks
}
const findNotes = (instruction: string, scope: Task[]) => {
  const quoted = [...instruction.matchAll(/[“"「]([^”"」]+)[”"」]/g)].map(match => match[1])
  const keywords = ['学习', '主动回忆', '办公', '表格', '数据', '编程', '变量', '条件', '循环', '生活', '备餐', '食材', '沟通', '会议', '信息', '检索', '来源', '时间', '失败'].filter(word => instruction.includes(word))
  const titleMatches = scope.filter(task => quoted.some(word => task.audioMeta.title.includes(word)) || keywords.some(word => task.audioMeta.title.toLocaleLowerCase().includes(word.toLocaleLowerCase())))
  let matches = titleMatches.length ? titleMatches : (keywords.length || (quoted.length && /查询|查找|找出|列出|哪些/u.test(instruction))) ? [] : scope
  if (/未归档|尚未归档|未归档/u.test(instruction)) matches = matches.filter(task => !task.archived_at)
  else if (/已归档|归档区/u.test(instruction)) matches = matches.filter(task => task.archived_at)
  return matches
}
const buildPlan = (body: PreviewBody): OrganizerPlan => {
  const instruction = body.instruction?.trim() || ''
  if (!instruction) throw new Error('请输入整理指令。')
  const scope = body.scope || { kind: 'all' }
  if (scope.kind === 'selected' && !scope.task_ids?.length) throw new Error('请先勾选笔记。')
  const catalog = scopedTasks(scope)
  const operations: OrganizerOperation[] = []
  const matches = scope.kind === 'selected' && !/查询|查找|找出|列出|哪些/u.test(instruction) ? catalog : findNotes(instruction, catalog)
  let explanation = '【模拟整理计划】请核对下面的笔记与目标；确认后仅修改本预览的合成数据。'
  if (/删除|正文|本地文件|磁盘|脚本/u.test(instruction)) explanation = '【模拟回答】整理助手只管理逻辑文件夹、标签和归档状态，不支持真正删除、修改正文或操作本地文件。'
  else if (/可以.*做|帮助|怎么用|功能|你是谁/u.test(instruction)) explanation = '【模拟回答】你可以让我查询笔记、按主题分类、创建或重命名逻辑文件夹、移动笔记、设置标签、归档或恢复。选择范围后描述需求；写入操作必须先审阅计划并确认。'
  else {
    const createName = newFolderName(instruction)
    const oldFolder = state.folders.find(folder => folder.id !== 'default' && instruction.includes(folder.name))
    const rename = instruction.match(/(?:重命名|改名|改成|改为)(?:为)?\s*([“"'「][^”"'」]+[”"'」]|[^，。；\n]+)/u)
    const move = instruction.match(/(?:移(?:动)?(?:到|入)|放(?:到|入)|目标文件夹[：:]?)\s*([“"'「][^”"'」]+[”"'」]|[^，。；\n]+)/u)
    if (rename && oldFolder) operations.push({ type: 'rename_folder', folder_id: oldFolder.id, name: cleanName(rename[1]) })
    else if (/按主题|分类|分门别类/u.test(instruction)) {
      const groups = new Map<string, string[]>()
      catalog.filter(task => !task.archived_at && task.status === 'SUCCESS').forEach(task => {
        const title = task.audioMeta.title
        const group = sampleForTitle(title).topic
        groups.set(group, [...(groups.get(group) || []), task.id])
      })
      let index = 0
      groups.forEach((ids, name) => {
        const existing = state.folders.find(folder => folder.name === name)
        const id = existing?.id || `preview-ref-${index++}-${crypto.randomUUID()}`
        if (!existing) operations.push({ type: 'create_folder', ref: id, name })
        if (ids.some(noteId => (state.assignments[noteId] || 'default') !== id)) operations.push({ type: 'move_notes', task_ids: ids, folder_id: id })
      })
    } else {
      let targetId: string | undefined
      if (createName) {
        const existing = state.folders.find(folder => folder.name === createName)
        targetId = existing?.id || `preview-ref-new-${crypto.randomUUID()}`
        if (!existing) operations.push({ type: 'create_folder', ref: targetId, name: createName })
      }
      if (move) {
        const name = cleanName(move[1])
        const existing = state.folders.find(folder => folder.name === name || folder.id === name)
        targetId = existing?.id || targetId
        if (!targetId) { targetId = `preview-ref-target-${crypto.randomUUID()}`; operations.push({ type: 'create_folder', ref: targetId, name }) }
        if (matches.length) operations.push({ type: 'move_notes', task_ids: matches.map(task => task.id), folder_id: targetId })
      }
      const tagMatch = instruction.match(/(?:标签(?:设置)?(?:为|成|[：:])|设置标签(?:为|成)?|打上|(?:添加|加)标签(?:为|[：:])?)\s*([^。；\n]+)/u)
      if (/清空标签/u.test(instruction) && matches.length) operations.push({ type: 'set_tags', task_ids: matches.map(task => task.id), tags: [] })
      else if (tagMatch && matches.length) {
        const tags = tagMatch[1].replace(/[“”"'「」]/g, '').split(/[,，、\s]+/).map(tag => tag.replace(/标签$/u, '').trim()).filter(Boolean).slice(0, 20)
        operations.push({ type: 'set_tags', task_ids: matches.map(task => task.id), tags })
      }
      else if (/标签/u.test(instruction) && /设置|添加|打上|标记|加/u.test(instruction)) {
        matches.forEach(task => {
          const title = task.audioMeta.title
          const tags = [sampleForTitle(title).topic]
          operations.push({ type: 'set_tags', task_ids: [task.id], tags })
        })
      }
      if (/恢复|取消归档/u.test(instruction)) { const ids = matches.filter(task => task.archived_at).map(task => task.id); if (ids.length) operations.push({ type: 'restore', task_ids: ids }) }
      else if (/归档/u.test(instruction) && !/查询|找出|哪些|查找|列出/u.test(instruction)) { const ids = matches.filter(task => !task.archived_at).map(task => task.id); if (ids.length) operations.push({ type: 'archive', task_ids: ids }) }
    }
    if (!operations.length) explanation = `【模拟查询】当前范围 ${catalog.length} 篇，匹配 ${matches.length} 篇。${matches.length ? '匹配结果列在下方。' : '没有匹配笔记。'}未执行写入操作。`
  }
  const plan: OrganizerPlan = { plan_id: crypto.randomUUID().replace(/-/g, ''), status: 'planned', explanation, operations, scope_count: catalog.length, metadata_only: true, notes: catalog.map(task => ({ id: task.id, title: task.audioMeta.title })), folders: clone(state.folders), query_note_ids: !operations.length && !/删除|正文|本地文件|磁盘|脚本|可以.*做|帮助|怎么用|功能|你是谁/u.test(instruction) ? matches.map(task => task.id) : [] }
  journals.set(plan.plan_id, { plan, fingerprint: fingerprint(), status: 'planned' })
  return plan
}
const checkModel = (body: PreviewBody) => {
  if (!state.providers.some(provider => provider.id === body.provider_id && provider.enabled) || !state.models.some(model => model.provider_id === body.provider_id && model.model_name === body.model_name)) throw new Error('模拟模型配置不可用，请选择已启用的示例服务商与模型。')
}
const applyOperation = (operation: OrganizerOperation) => {
  if (operation.type === 'create_folder') state.folders.push({ id: operation.ref!, name: operation.name! })
  if (operation.type === 'rename_folder') state.folders = state.folders.map(folder => folder.id === operation.folder_id ? { ...folder, name: operation.name! } : folder)
  if (operation.type === 'move_notes') operation.task_ids?.forEach(id => { state.assignments[id] = operation.folder_id! })
  if (operation.type === 'set_tags') operation.task_ids?.forEach(id => { state.entries[id] = { ...(state.entries[id] || blankEntry()), tags: operation.tags || [] } })
  if (operation.type === 'archive' || operation.type === 'restore') state.tasks = state.tasks.map(task => operation.task_ids?.includes(task.id) ? { ...task, archived_at: operation.type === 'archive' ? new Date().toISOString() : null } : task)
}
interface PreviewSession {
  session_id: string; revision: number; status: string;
  query_scope: OrganizerScope;
  scope: OrganizerScope & { authorized: boolean; exclude_favorites: boolean; target_count: number; folder_name?: string };
  history: { id: string; role: string; content: string; created_at: number }[];
  messages: { id: string; role: string; text: string }[];
  plan: OrganizerPlan | null; result: unknown; error: string | null;
  events: { sequence: number; type: string; message: string; created_at: number }[];
  target_summary: { count: number; note_ids: string[]; folder_name: string | null; exclude_favorites: boolean; authorized: boolean };
  updated_at: number; created_at?: number; pending_plan_id: string | null;
}
interface PreviewSessionRecord { snapshot: PreviewSession; action: string; receipts: Record<string, { signature: string; snapshot: PreviewSession }>; journal?: PreviewJournal }
const organizerSessions = new Map<string, PreviewSessionRecord>()
try {
  const saved = JSON.parse(localStorage.getItem(PREVIEW_ORGANIZER_KEY) || '[]') as [string, PreviewSessionRecord][]
  if (Array.isArray(saved)) saved.forEach(([id, record]) => {
    if (id === record?.snapshot?.session_id && Array.isArray(record.snapshot.history) && Number.isInteger(record.snapshot.revision)) {
      record.snapshot.query_scope ||= { kind: 'all' }
      const seconds = (value: unknown) => typeof value === 'number' ? value : Date.parse(String(value)) / 1000
      record.snapshot.updated_at = seconds(record.snapshot.updated_at)
      record.snapshot.history.forEach(item => { item.created_at = seconds(item.created_at) })
      record.snapshot.events.forEach(item => { item.created_at = seconds(item.created_at) })
      organizerSessions.set(id, record)
    }
  })
} catch { /* Corrupt synthetic sessions are ignored. */ }
const persistOrganizer = () => { try { localStorage.setItem(PREVIEW_ORGANIZER_KEY, JSON.stringify([...organizerSessions])) } catch { /* Session remains available in this tab. */ } }
let retentionState: { limit: number; receipts: Record<string, { signature: string; result: unknown }> } = { limit: 10, receipts: {} }
try { const saved = JSON.parse(localStorage.getItem(PREVIEW_RETENTION_KEY) || 'null'); if (Number.isInteger(saved?.limit) && saved.limit >= 1 && saved.limit <= 100) retentionState = { limit: saved.limit, receipts: saved.receipts || {} } } catch { /* fixture defaults */ }
const persistRetention = () => { try { localStorage.setItem(PREVIEW_RETENTION_KEY, JSON.stringify(retentionState)) } catch { /* tab-only fixture */ } }
const retentionInfo = () => ({ limit: retentionState.limit, min_limit: 1, max_limit: 100, count: organizerSessions.size, over_limit: organizerSessions.size > retentionState.limit })
const previewConsentTokens = new Map<string, string>()
const retentionPreview = (operation: 'create' | 'set_limit', limit = retentionState.limit): OrganizerRetentionPreview => {
  if (!['create', 'set_limit'].includes(operation)) throw new Error('未知保留设置操作')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('保留数量须为 1 到 100 的整数')
  if (operation === 'create' && limit !== retentionState.limit) throw new Error('新建会话必须使用当前保留数量')
  const sessions = [...organizerSessions.values()].map(item => item.snapshot).sort((a, b) => a.updated_at - b.updated_at || a.session_id.localeCompare(b.session_id))
  const eligible = sessions.filter(item => !['planning', 'executing', 'undoing', 'interrupted'].includes(item.status))
  const required = Math.max(0, sessions.length + (operation === 'create' ? 1 : 0) - limit)
  const blocked = eligible.length < required
  // Deterministic consent binding for synthetic fixtures; never used as a real server security token.
  const signature = JSON.stringify({ operation, limit, current_limit: retentionState.limit, sessions })
  if (!previewConsentTokens.has(signature)) previewConsentTokens.set(signature, crypto.randomUUID())
  return { operation, limit, current_limit: retentionState.limit, count: sessions.length, required_count: required,
    evictions: eligible.slice(0, required).map(item => ({ session_id: item.session_id, title: item.history.find(message => message.role === 'user')?.content.slice(0, 80) || '新会话', status: item.status, updated_at: item.updated_at, created_at: item.created_at || item.updated_at, message_count: item.history.length, revision: item.revision, has_pending_plan: item.status === 'awaiting_approval', loses_undo: (item.result as { status?: string } | null)?.status === 'executed' })),
    protected_count: sessions.length - eligible.length, blocked, confirmation_token: required && !blocked ? previewConsentTokens.get(signature)! : null,
    warning: blocked ? '存在正在运行或需要恢复的会话，无法完成覆盖；请先停止或恢复任务，再重新预检。' : required ? '将覆盖以下旧会话及其聊天记录。待审批计划将作废；该会话的撤销入口将消失。笔记和已执行的整理结果不变，操作审计仍保留。' : '' }
}
const requireRetention = (preview: OrganizerRetentionPreview, token?: string) => {
  const kind = preview.blocked ? 'retention_blocked' : token !== undefined && token !== preview.confirmation_token ? 'retention_stale' : preview.required_count && token === undefined ? 'retention_required' : null
  if (kind) throw { code: 409, msg: kind === 'retention_stale' ? '会话列表已变化，请重新预检。' : preview.warning, data: { kind, ...preview } }
}
const evictSessions = (preview: OrganizerRetentionPreview) => { preview.evictions.forEach(item => organizerSessions.delete(item.session_id)); persistOrganizer() }
const retentionReceipt = (body: PreviewBody, signature: string) => {
  const receipt = body.request_id ? retentionState.receipts[body.request_id] : undefined
  if (receipt && receipt.signature !== signature) throw new Error('request_id 已用于不同请求。')
  return receipt
}
const saveRetentionReceipt = (body: PreviewBody, signature: string, result: unknown) => { if (body.request_id) retentionState.receipts[body.request_id] = { signature, result: clone(result) }; persistRetention() }
const retentionEndpoint = (url: string, method: string, body: PreviewBody) => {
  if (url.endsWith('/preview') && method === 'post') return retentionPreview(body.operation!, body.limit)
  if (method === 'get') return retentionInfo()
  if (method !== 'patch') throw new Error('模拟保留设置操作不存在。')
  const signature = JSON.stringify({ operation: 'set_limit', limit: body.limit, confirmation_token: body.confirmation_token })
  const receipt = retentionReceipt(body, signature); if (receipt) return clone(receipt.result)
  if (body.limit === undefined) throw new Error('保留数量须为 1 到 100 的整数')
  const preview = retentionPreview('set_limit', body.limit); requireRetention(preview, body.confirmation_token)
  evictSessions(preview); retentionState.limit = body.limit
  const result = retentionInfo(); saveRetentionReceipt(body, signature, result); return result
}
const sessionHistory = (session: PreviewSession, role: string, content: string) => {
  const message = { id: crypto.randomUUID(), role, content, created_at: Date.now() / 1000 }
  session.history.push(message)
  session.messages = session.history.map(item => ({ id: item.id, role: item.role, text: item.content }))
}
const sessionEndpoint = (url: string, method: string, body: PreviewBody): unknown => {
  if (url === '/organizer/sessions') {
    if (method === 'get') return { sessions: [...organizerSessions.values()].map(record => clone(record.snapshot)).sort((a, b) => b.updated_at - a.updated_at), retention: retentionInfo() }
    if (method !== 'post') throw new Error('模拟会话操作不存在。')
    const signature = JSON.stringify({ operation: 'create', scope: body.scope, provider_id: body.provider_id, model_name: body.model_name, confirmation_token: body.confirmation_token })
    const receipt = retentionReceipt(body, signature); if (receipt) return clone(receipt.result)
    const preview = retentionPreview('create'); requireRetention(preview, body.confirmation_token)
    const scope = body.scope || { kind: 'all' as const }
    const now = Date.now() / 1000
    const snapshot: PreviewSession = {
      session_id: crypto.randomUUID(), revision: 0, status: 'idle', query_scope: clone(scope),
      scope: { ...scope, authorized: scope.kind !== 'all', exclude_favorites: false, target_count: 0 },
      history: [], messages: [], plan: null, result: null, error: null, events: [],
      target_summary: { count: 0, note_ids: [], folder_name: null, exclude_favorites: false, authorized: scope.kind !== 'all' },
      updated_at: now, created_at: now, pending_plan_id: null,
    }
    evictSessions(preview); organizerSessions.set(snapshot.session_id, { snapshot, action: '', receipts: {} }); persistOrganizer(); saveRetentionReceipt(body, signature, snapshot); return clone(snapshot)
  }
  const [, , , id, action] = url.split('/')
  const record = organizerSessions.get(decodeURIComponent(id || ''))
  if (!record) throw { code: 404, msg: '整理会话不存在或已被清理。', data: null }
  const session = record.snapshot
  if (method === 'get' && !action) return clone(session)
  if (!['message', 'approve', 'cancel', 'undo', 'recover'].includes(action)) throw new Error('模拟会话操作不存在。')
  if (!body.request_id) throw new Error('必须提供 request_id。')
  const signature = JSON.stringify({ action, expected_revision: body.expected_revision, instruction: body.instruction, scope: body.scope, plan_id: body.plan_id, provider_id: body.provider_id, model_name: body.model_name })
  const receipt = record.receipts[body.request_id]
  if (receipt) {
    if (receipt.signature !== signature) throw new Error('request_id 已用于不同请求。')
    return clone(receipt.snapshot)
  }
  if (body.expected_revision !== session.revision) throw new Error('会话版本已变化，请刷新后重试。')
  if (action === 'message') {
    checkModel(body)
    const instruction = body.instruction?.trim() || ''
    if (!instruction) throw new Error('请输入整理指令。')
    if (body.scope) session.query_scope = clone(body.scope)
    session.query_scope ||= { kind: 'all' }
    // Deterministic UI fixture, not a language model. Never infer whole-library write authority.
    session.plan = null; session.pending_plan_id = null; session.result = null; session.error = null; record.journal = undefined
    sessionHistory(session, 'user', instruction)
    const folder = state.folders.find(item => instruction.includes(item.name))
    const unknownFolder = !folder && /文件夹/u.test(instruction) && !/新建|创建|按主题|分类/u.test(instruction)
    if (folder) session.scope = { ...session.scope, kind: 'folder', folder_id: folder.id, task_ids: undefined, authorized: true }
    else if (unknownFolder) session.scope = { kind: 'all', authorized: false, exclude_favorites: session.scope.exclude_favorites, target_count: 0 }
    else if (/全库|所有笔记|全部笔记/u.test(instruction)) session.scope = { ...session.scope, kind: 'all', folder_id: undefined, task_ids: undefined, authorized: true }
    else if (body.scope?.kind === 'selected' || body.scope?.kind === 'folder') session.scope = { ...session.scope, ...body.scope, authorized: true }
    if (session.scope.task_ids === undefined) delete session.scope.task_ids
    if (session.scope.folder_id === undefined) delete session.scope.folder_id
    if (/排除.*收藏|不包括.*收藏/u.test(instruction)) session.scope.exclude_favorites = true
    if (/包含.*收藏|包括.*收藏/u.test(instruction) && !/不包括/u.test(instruction)) session.scope.exclude_favorites = false
    const actionText = /恢复|取消归档/u.test(instruction) ? '恢复' : /归档/u.test(instruction) ? '归档' : /排除.*收藏|不包括.*收藏|包含.*收藏|包括.*收藏/u.test(instruction) ? record.action : instruction
    if (!/删除|正文|本地文件|磁盘|脚本/u.test(instruction)) record.action = actionText
    const upperBound = session.query_scope.kind !== 'all' ? new Set(scopedTasks(session.query_scope).map(task => task.id)) : null
    const targets = session.scope.authorized ? scopedTasks(session.scope).filter(task => (!upperBound || upperBound.has(task.id)) && (!session.scope.exclude_favorites || !state.entries[task.id]?.favorite)) : []
    session.scope.target_count = targets.length
    session.scope.folder_name = state.folders.find(item => item.id === session.scope.folder_id)?.name || ''
    session.target_summary = { count: targets.length, note_ids: targets.map(task => task.id), folder_name: state.folders.find(item => item.id === session.scope.folder_id)?.name || null, exclude_favorites: session.scope.exclude_favorites, authorized: session.scope.authorized }
    let answer: string
    if (/不要.*归档|先解释|先说明|不执行/u.test(instruction)) { session.status = 'completed'; answer = '【模拟解释】归档只修改元数据，不删除笔记；当前仅解释，没有写入计划。' }
    else if (/删除|正文|本地文件|磁盘|脚本/u.test(instruction)) { session.status = 'refused'; answer = '【模拟拒绝】不支持删除笔记、改正文或访问文件。已保留明确的目标范围，可以改为归档。' }
    else if (!session.scope.authorized) { session.status = 'clarification'; answer = '【模拟澄清】请指定文件夹、选择笔记，或明确说明所有笔记；当前不会默认操作全库。' }
    else if (!targets.length) { session.status = 'completed'; answer = '【模拟空集】筛选后没有目标笔记，请调整范围；不会回退为全库。' }
    else {
      const plan = buildPlan({ ...body, instruction: actionText, scope: { kind: 'selected', task_ids: targets.map(task => task.id) } })
      session.plan = plan; record.journal = journals.get(plan.plan_id)
      if (record.journal) record.journal.session_id = session.session_id
      session.status = plan.operations.length ? 'awaiting_approval' : 'completed'
      session.pending_plan_id = plan.operations.length ? plan.plan_id : null
      answer = plan.explanation
    }
    sessionHistory(session, 'assistant', answer)
  } else if (action === 'approve') {
    const journal = record.journal
    if (session.status !== 'awaiting_approval' || !journal || body.plan_id !== session.pending_plan_id) throw new Error('确认对应的计划已失效，请审阅当前计划。')
    if (journal.fingerprint !== fingerprint()) throw new Error('示例笔记库已变更，请重新生成计划。')
    journal.before = librarySnapshot(); journal.plan.operations.forEach(applyOperation); journal.after = fingerprint(); journal.status = 'executed'
    session.result = { plan_id: journal.plan.plan_id, status: 'executed', operations: journal.plan.operations, undo_available: true, explanation: '【模拟执行】仅更新合成笔记元数据。' }
    session.status = 'completed'; session.pending_plan_id = null
    sessionHistory(session, 'assistant', '【模拟执行完成】已执行确认计划，可撤销。')
    persist()
  } else if (action === 'undo') {
    const journal = record.journal
    if (!journal || journal.status !== 'executed' || body.plan_id !== journal.plan.plan_id) throw new Error('没有对应的可撤销计划。')
    if (journal.after !== fingerprint()) throw new Error('示例库已发生后续修改，无法安全撤销。')
    Object.assign(state, clone(journal.before!)); journal.status = 'undone'
    session.result = { plan_id: journal.plan.plan_id, status: 'undone', undo_available: false, explanation: '【模拟撤销】已恢复执行前的合成笔记库。' }
    session.status = 'completed'; sessionHistory(session, 'assistant', '【模拟撤销完成】已恢复执行前的合成笔记库。'); persist()
  } else if (action === 'cancel') {
    if (body.plan_id && body.plan_id !== session.pending_plan_id) throw new Error('取消对应的计划已失效。')
    session.status = 'cancelled'; session.plan = null; session.pending_plan_id = null; record.journal = undefined
    sessionHistory(session, 'assistant', '【模拟取消】未执行待确认计划。')
  } else {
    if (!['interrupted', 'planning', 'executing', 'undoing', 'failed'].includes(session.status)) throw new Error('当前会话无需恢复。')
    session.status = 'idle'; session.error = null; session.plan = null; session.pending_plan_id = null
  }
  session.revision += 1; session.updated_at = Date.now() / 1000
  session.events.push({ sequence: session.events.length + 1, type: action, message: '模拟本地状态转换，未调用真实模型。', created_at: session.updated_at })
  record.receipts[body.request_id] = { signature, snapshot: clone(session) }
  persistOrganizer(); return clone(session)
}
// Every URL is handled here or returns a synthetic error. Never fall back to a network adapter.
export const previewAdapter: AxiosAdapter = async config => {
  const url = (config.url || '').split('?')[0]
  const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data || {}) as PreviewBody
  const method = config.method || 'get'
  let data: unknown = null
  let error: string | undefined
  let errorCode = 1
  let errorData: unknown = null
  try {
    if (url === '/organizer/retention' || url === '/organizer/retention/preview') data = retentionEndpoint(url, method, body)
    else if (url === '/organizer/sessions' || url.startsWith('/organizer/sessions/')) data = sessionEndpoint(url, method, body)
    else if (url === '/notes') data = state.tasks
    else if (url === '/notes/import') data = state.tasks // Persisted business-store snapshots cannot overwrite synthetic server data.
    else if (url.startsWith('/notes/')) {
      const [, , rawId, action] = url.split('/'); const id = decodeURIComponent(rawId)
      if (method === 'delete') state.tasks = state.tasks.filter(task => task.id !== id)
      if (action === 'archive' || action === 'restore') state.tasks = state.tasks.map(task => task.id === id ? { ...task, archived_at: action === 'archive' ? new Date().toISOString() : null } : task)
      data = state.tasks.find(task => task.id === id) || null
    } else if (url.startsWith('/note_folders')) {
      const id = decodeURIComponent(url.split('/')[2] || '')
      if (url.endsWith('/move')) body.task_ids?.forEach(taskId => { state.assignments[taskId] = body.folder_id || 'default' })
      else if (method === 'post') state.folders.push({ id: crypto.randomUUID(), name: body.name || '新文件夹' })
      else if (method === 'patch') state.folders = state.folders.map(folder => folder.id === id ? { ...folder, name: body.name || folder.name } : folder)
      else if (method === 'delete') { state.folders = state.folders.filter(folder => folder.id !== id); state.assignments = Object.fromEntries(Object.entries(state.assignments).filter(([, value]) => value !== id)) }
      data = { folders: state.folders, assignments: state.assignments }
    } else if (url.startsWith('/note_library')) {
      if (url.endsWith('/update')) body.task_ids?.forEach(id => { state.entries[id] = { ...(state.entries[id] || blankEntry()), ...body.changes } })
      data = { entries: state.entries }
    } else if (url === '/organizer/plan') { checkModel(body); data = buildPlan(body) }
    else if (url === '/organizer/execute' || url === '/organizer/undo') {
      const journal = journals.get(body.plan_id || '')
      if (!journal) throw new Error('模拟计划已失效，请重新生成计划；刷新后不恢复未确认计划。')
      if (journal.session_id) throw new Error('会话计划必须通过会话审批接口执行或撤销。')
      if (url.endsWith('/execute')) {
        if (journal.status === 'undone') throw new Error('已撤销的计划不能再次执行，请重新生成。')
        if (journal.status === 'planned') {
          if (!journal.plan.operations.length) throw new Error('查询回答没有待执行操作。')
          if (journal.fingerprint !== fingerprint()) throw new Error('示例笔记库已变更，请重新生成计划。')
          journal.before = librarySnapshot(); journal.plan.operations.forEach(applyOperation); journal.after = fingerprint(); journal.status = 'executed'
        }
        data = { plan_id: journal.plan.plan_id, status: 'executed', operations: journal.plan.operations, explanation: '【模拟执行完成】仅更新当前预览的示例笔记库，真实笔记未被操作。', undo_available: true }
      } else {
        if (journal.status === 'planned') throw new Error('尚未执行的计划无需撤销。')
        if (journal.status === 'executed') {
          if (journal.after !== fingerprint()) throw new Error('示例库已发生后续修改，无法安全撤销这次操作。')
          Object.assign(state, clone(journal.before!)); journal.status = 'undone'
        }
        data = { plan_id: journal.plan.plan_id, status: 'undone', explanation: '【模拟撤销完成】已恢复本次操作前的示例库。', undo_available: false }
      }
    } else if (url === '/get_all_providers') data = state.providers
    else if (url.startsWith('/get_provider_by_id/')) data = state.providers.find(provider => provider.id === decodeURIComponent(url.split('/')[2]))
    else if (url === '/add_provider') {
      const id = `preview-custom-${crypto.randomUUID()}`
      state.providers.push({ id, name: body.name || '示例服务商（模拟）', logo: body.logo || '', base_url: body.base_url || '', api_key: '****模拟密钥****', type: body.type || 'custom', enabled: Number(body.enabled ?? 1) }); data = id
    } else if (url === '/update_provider') {
      state.providers = state.providers.map(provider => provider.id === body.id ? { ...provider, name: body.name || provider.name, logo: body.logo ?? provider.logo, base_url: body.base_url ?? provider.base_url, enabled: Number(body.enabled ?? provider.enabled) } : provider)
      data = { id: body.id, enabled: state.providers.find(provider => provider.id === body.id)?.enabled }
    } else if (url === '/connect_test') data = { simulated: true, message: '模拟连接成功，未发起真实网络请求。' }
    else if (url === '/model_list') data = state.models.filter(model => state.providers.some(provider => provider.id === model.provider_id && provider.enabled))
    else if (url.startsWith('/model_list/')) data = { models: [{ id: sampleModel }, { id: '通用示例视觉模型' }, { id: '通用示例推理模型' }] }
    else if (url.startsWith('/model_enable/')) data = state.models.filter(model => model.provider_id === decodeURIComponent(url.split('/')[2]))
    else if (url === '/models') {
      const exists = state.models.find(model => model.provider_id === body.provider_id && model.model_name === body.model_name)
      if (exists) data = exists
      else { const model = { id: Math.max(0, ...state.models.map(item => item.id)) + 1, provider_id: body.provider_id || '', model_name: body.model_name || sampleModel }; state.models.push(model); data = model }
    } else if (url.startsWith('/models/delete/')) { state.models = state.models.filter(model => model.id !== Number(url.split('/')[3])); data = null }
    else if (url === '/chat/index') data = { simulated: true }
    else if (url === '/chat/status') data = { indexed: true, status: 'indexed' }
    else if (url === '/chat/compact') {
      checkModel(body)
      const history = body.history || []
      const count = Math.max(0, history.length - (body.keep_recent ?? 4))
      const before = estimateLocalContext([body.summary, history]) + 1024
      const compacted = count > 0 && estimateLocalContext(history.slice(0, count)) + 1024 >= 4000
      const summary = compacted ? `【模拟压缩摘要，未调用模型】${body.summary || ''}\n${history.slice(0, count).map(m => m.content.slice(0, 100)).join('\n')}` : body.summary || ''
      const consumed = compacted ? count : 0
      const after = estimateLocalContext([summary, history.slice(consumed)]) + 1024
      data = { summary, consumed_messages: consumed, compacted, before_tokens: before, after_tokens: after,
        context: { input_tokens: after, estimated: true, limit: 272000, compacted, compacted_messages: consumed } }
    }
    else if (url === '/chat/ask') {
      checkModel(body)
      const scenario = previewChatScenario
      await new Promise<void>((resolve, reject) => {
        if (config.signal?.aborted) { reject(new Error('已停止模拟等待')); return }
        const cancel = () => { clearTimeout(timer); config.signal?.removeEventListener?.('abort', cancel); reject(new Error('已停止模拟等待')) }
        const timer = setTimeout(() => { config.signal?.removeEventListener?.('abort', cancel); resolve() }, scenario === 'slow' ? 35000 : 3000)
        config.signal?.addEventListener?.('abort', cancel)
      })
      if (scenario === 'upstream-error' || scenario === 'timeout') throw {
        code: 500,
        msg: scenario === 'upstream-error' ? '【模拟】模型服务返回 HTTP 502，请展开详情核对。' : '【模拟】等待超时，未收到上游最终结果。',
        data: { error_details: { http_status: scenario === 'upstream-error' ? 502 : null,
          upstream_code: scenario === 'upstream-error' ? 'upstream_error' : null,
          request_id: scenario === 'upstream-error' ? 'preview-request-502' : null,
          occurred_at: new Date().toISOString(), protocol: body.protocol || 'openai-chat', kind: scenario === 'timeout' ? 'client_timeout' : 'upstream_http',
          detail: scenario === 'upstream-error' ? '模拟错误：Upstream service unavailable。此记录不来自真实服务商。' : '模拟客户端超时：没有收到上游 HTTP 错误响应，不能推断状态码。此演示未等待真实 120 秒。' } },
      }
      const task = state.tasks.find(item => item.id === body.task_id)
      if (!task) throw new Error('模拟问答仅支持当前示例笔记。')
      const textAttachment = body.attachments?.find(attachment => attachment.text)?.text
      const image = body.attachments?.find(attachment => attachment.type === 'image' && attachment.data_url?.startsWith('data:image/'))
      const sample = sampleForTitle(task.audioMeta.title)
      const source = textAttachment?.slice(0, 400) || sample.overview
      const guidance = textAttachment ? `参考选段：${source}\n\n可先提取要点，再记录需要核实的问题。` : /步骤|怎么|如何/u.test(body.question || '') ? sample.steps.map((step, index) => `${index + 1}. ${step}`).join('\n') : sample.overview
      data = { answer: `**模拟回答 · 未调用真实模型**\n\n关于「${body.question || '这篇笔记'}」：${textAttachment ? '你提供的选段或附件中包含以下参考内容' : `可以先从《${task.audioMeta.title}》中的工作顺序开始`}。[1]\n\n${guidance}${image ? '\n\n已收到图片附件。本回答只展示图片附件的交互流程，未进行真实视觉识别。' : ''}`, sources: [{ text: source, source_type: body.context_mode === 'selection' ? 'markdown' : 'transcript', section_title: textAttachment ? '提供的选段 / 附件' : '示例原文', start_time: 0, end_time: 15 }] }
      Object.assign(data as object, { context: { input_tokens: estimateLocalContext([body.history, body.summary, body.question, body.attachments]) + 1024, estimated: true, limit: 272000 } })
      if (body.question === '[模拟空回复]') data = { answer: '', sources: [] }
    } else if (url === '/generate_note') {
      checkModel(body)
      const id = body.task_id || `ui-generated-${crypto.randomUUID()}`
      const title = `模拟生成笔记 ${state.tasks.filter(task => task.id.startsWith('ui-generated')).length + 1}`
      const task = syntheticTask(id, title, body.model_name)
      task.formData = { ...task.formData, video_url: body.video_url || '/sample.mp4', platform: body.platform || 'local', provider_id: body.provider_id!, quality: body.quality || 'medium', style: body.style || 'tutorial' }
      state.tasks = [...state.tasks.filter(item => item.id !== id), task]
      data = { task_id: id, status: 'PENDING', simulated: true }
    } else if (url.startsWith('/task_status/')) {
      const task = state.tasks.find(item => item.id === decodeURIComponent(url.split('/')[2]))
      if (!task) throw new Error('找不到模拟任务。')
      data = { status: task.status, result: { markdown: task.markdown, transcript: task.transcript, audio_meta: task.audioMeta } }
    } else if (url === '/proxy_config') {
      if (method === 'post') previewProxy = { enabled: Boolean(body.enabled), url: body.url || '', effective: body.enabled ? body.url || '' : '' }
      data = { ...previewProxy, simulated: true }
    } else if (url.startsWith('/get_downloader_cookie/')) {
      const platform = decodeURIComponent(url.split('/').pop() || '')
      data = { cookie: previewCookies.has(platform) ? 'preview_cookie=synthetic_only' : '', simulated: true }
    } else if (url === '/update_downloader_cookie') {
      if (!body.platform || !body.cookie) throw new Error('请输入平台与模拟 Cookie')
      previewCookies.add(body.platform)
      data = { saved: true, simulated: true }
    } else if (url === '/transcriber_config') {
      if (method === 'post') {
        if (!previewTypes.some(type => type.value === body.transcriber_type) || body.transcriber_type === 'mlx-whisper') throw new Error('请选择当前模拟环境可用的转写引擎。')
        if (body.whisper_model_size && !previewModelNames().includes(body.whisper_model_size)) throw new Error('模拟模型不存在。')
        settings.transcriber_type = body.transcriber_type!
        if (body.groq_model?.trim()) settings.groq_model = body.groq_model.trim()
        if (body.whisper_model_size) settings.whisper_model_size = body.whisper_model_size
        if (body.mlx_whisper_model_size) settings.mlx_whisper_model_size = body.mlx_whisper_model_size
        if (body.groq_connection) previewGroqConnection = { ...body.groq_connection, api_key: body.groq_connection.api_key === '********' ? previewGroqConnection.api_key : body.groq_connection.api_key }
        persistSettings()
      }
      data = previewTranscriberConfig()
    } else if (url === '/whisper_models') {
      if (method === 'post') {
        const name = body.name?.trim() || ''
        if (!isPreviewModelName(name) || !body.target?.trim()) throw new Error('请输入有效模拟模型名称与目标。')
        if (previewModelNames().includes(name)) throw new Error('模拟模型名称已存在。')
        // Target text is inert metadata; it is never resolved, opened, or downloaded.
        settings.custom[name] = body.target.trim().slice(0, 500)
        persistSettings()
      }
      data = { builtin: previewBuiltins, custom: settings.custom, simulated: true }
    } else if (url.startsWith('/whisper_models/') && method === 'delete') {
      const name = decodeURIComponent(url.split('/')[2])
      if (!Object.prototype.hasOwnProperty.call(settings.custom, name)) throw new Error('只能移除自定义模拟模型。')
      delete settings.custom[name]
      settings.downloaded = settings.downloaded.filter(item => item !== name)
      if (settings.whisper_model_size === name) settings.whisper_model_size = 'tiny'
      persistSettings()
      data = { custom: settings.custom, simulated: true }
    } else if (url === '/transcriber_download' && method === 'post') {
      if ((body.transcriber_type && body.transcriber_type !== 'fast-whisper') || !previewModelNames().includes(body.model_size || '')) throw new Error('当前模拟下载只支持已登记的 Faster Whisper 模型。')
      if (!settings.downloaded.includes(body.model_size!)) settings.downloaded.push(body.model_size!)
      persistSettings()
      data = { simulated: true, message: '仅将合成模型标记为已下载，未联网或写入模型文件。' }
    } else if (url === '/transcriber_models_status') data = { whisper: previewModelNames().map(name => ({ model_size: name, downloaded: settings.downloaded.includes(name), downloading: false, failed: false })), mlx_whisper: [], mlx_available: false, simulated: true }
    else if (url === '/deploy_status') data = { backend: { status: '模拟运行中（未探测真实服务）', port: 0 }, cuda: { available: false, torch_installed: false, version: null, gpu_name: null }, whisper: { model_size: `${settings.whisper_model_size}（模拟）`, transcriber_type: settings.transcriber_type, downloaded: settings.downloaded.includes(settings.whisper_model_size) }, ffmpeg: { available: true }, simulated: true }
    else if (url === '/sys_health') data = { backend: 'ok', ffmpeg: 'ok', db: 'ok', whisper_model: { size: settings.whisper_model_size, type: settings.transcriber_type, downloaded: settings.downloaded.includes(settings.whisper_model_size), checked: false }, simulated: true }
    else throw new Error('该功能未提供模拟接口；本预览不会连接真实后端。')
    if (method !== 'get' || url.startsWith('/models/delete/')) persist()
  } catch (caught) { const detail = caught as { code?: number; msg?: string; data?: unknown }; error = caught instanceof Error ? caught.message : detail.msg || '模拟接口处理失败。'; errorCode = detail.code || 1; errorData = detail.data || null }
  return { data: { code: error ? errorCode : 0, msg: error || '模拟响应', data: error ? errorData : clone(data) }, status: 200, statusText: 'OK', headers: {}, config }
}
