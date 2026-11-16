import { get, set } from 'idb-keyval'
import { createTaskStorage } from '@/utils/taskStorage'
import { createReadingSessionStorage } from '@/utils/readingSessionStorage'

Object.assign(window, { compatibilityFixture: {
  async seed() {
    await set('task-storage', JSON.stringify({ state: { tasks: [{ id: 'old', markdown: '旧正文' }], currentTaskId: 'old' }, version: 0 }))
    await set('bilinote-reading-assistant-v1', JSON.stringify({ state: { sessions: {} }, version: 0 }))
    await createTaskStorage().setItem('task-storage', { state: { tasks: [{ id: 'new', markdown: '更新后正文' }], currentTaskId: 'new' }, version: 0 })
    await createReadingSessionStorage().setItem('bilinote-reading-assistant-v1', { state: { sessions: { 'note:new': {
      messages: [{ id: 'm1', role: 'assistant', content: '更新后新增的回复', attachments: [{ id: 'i1', type: 'image', name: '图片', data_url: 'data:image/png;base64,AAAA' }] }],
      input: '更新后新增的草稿', attachments: [{ id: 'q1', type: 'quote', name: '引用', text: '新引用', taskId: 'new' }],
    } } }, version: 0 })
  },
  async legacy() { return { tasks: JSON.parse(await get('task-storage')), reading: JSON.parse(await get('bilinote-reading-assistant-v1')) } },
  async upgrade() {
    const tasks = createTaskStorage(), reading = createReadingSessionStorage()
    const taskValue = await tasks.getItem('task-storage'), readingValue = await reading.getItem('bilinote-reading-assistant-v1')
    await tasks.setItem('task-storage', taskValue!); await reading.setItem('bilinote-reading-assistant-v1', readingValue!)
  },
  async clear() { await createTaskStorage().removeItem('task-storage'); await createReadingSessionStorage().removeItem('bilinote-reading-assistant-v1') },
} })
