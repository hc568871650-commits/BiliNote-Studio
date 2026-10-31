import assert from 'node:assert/strict'
import { beginReadingTurn, updateReadingTurn, interruptPendingReadingTurns, readingRecoveryState, restoreReadingTurn } from '@/utils/readingRecovery'
import { activeReadingMessages, wireHistory } from '@/utils/readingContext'
import type { ReadingSession, ReadingMessage } from '@/store/readingAssistantStore'

const attachments: ReadingSession['attachments'] = [
  { id: 'q', type: 'quote', name: '引用', text: '第一段\n\n第二段', blockCount: 2, taskId: 'note-a', versionId: 'v1' },
  { id: 'i', type: 'image', name: 'image.png', data_url: 'data:image/png;base64,aW1hZ2U=', taskId: 'note-a', imageSource: { path: '/images/a.png', title: '测试' } },
]
const question: ReadingMessage = { id: 'u1', role: 'user', content: '  原始问题\n', attachments }
const original: ReadingSession = { input: question.content, attachments, messages: [{ id: 'old-u', role: 'user', content: '之前的问题' }, { id: 'old-a', role: 'assistant', content: '之前的回答' }] }
let checks = 0
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log(`PASS ${name}`) }
let pending = beginReadingTurn(original, question, 'a1')
check('提交清空原草稿并保存完整问题/引用/图片', pending.input === '' && !pending.attachments.length && pending.messages[2].content === question.content && pending.messages[2].attachments === attachments)
check('进行中问题和正文不会进入后续模型历史', activeReadingMessages(pending).length === 2)
pending = updateReadingTurn(pending, 'u1', { content: '已经收到的部分正文', work_log: ['搜索过程'] })!
const failed = updateReadingTurn(pending, 'u1', { content: '已经收到的部分正文' }, 'failed')!
check('失败正文仍为正文且过程独立', failed.messages[3].content === '已经收到的部分正文' && failed.messages[3].work_log?.[0] === '搜索过程')
check('失败原问题和部分回复均不重复发送为历史', JSON.stringify(wireHistory(activeReadingMessages(failed))) === JSON.stringify(wireHistory(original.messages)))
check('失败可手动恢复', readingRecoveryState(failed, 'a1') === 'ready')
const restored = restoreReadingTurn(failed, 'a1')
check('恢复精确保留原始空白和附件来源', restored.input === question.content && JSON.stringify(restored.attachments) === JSON.stringify(attachments))
check('恢复不新增消息或自动发送', restored.messages === failed.messages)
check('重复恢复不会重复添加附件', restoreReadingTurn(restored, 'a1') === restored && readingRecoveryState(restored, 'a1') === 'restored')
for (const draft of [{ input: '新的草稿', attachments: [] }, { input: '', attachments: [attachments[1]] }, { input: ' ', attachments: [] }]) {
  const changed = { ...failed, ...draft }
  check('任何新文字/附件/空白草稿均受保护', readingRecoveryState(changed, 'a1') === 'draft-conflict' && restoreReadingTurn(changed, 'a1') === changed)
}
const persisted = interruptPendingReadingTurns(JSON.parse(JSON.stringify(pending)))
check('刷新进行中轮次改为可恢复的中断轮次', persisted.messages[2].delivery_status === 'interrupted' && readingRecoveryState(persisted, 'a1') === 'ready')
check('刷新保存部分正文、引用和图片', persisted.messages[3].content === pending.messages[3].content && JSON.stringify(persisted.messages[2].attachments) === JSON.stringify(attachments))
const reloaded = interruptPendingReadingTurns(JSON.parse(JSON.stringify(failed)))
check('刷新失败轮次仍可恢复', reloaded.messages[2].delivery_status === 'failed' && readingRecoveryState(reloaded, 'a1') === 'ready')
check('另一笔记不能恢复本笔记轮次', readingRecoveryState(original, 'a1') === 'unavailable' && restoreReadingTurn(original, 'a1') === original)
check('晚到结果不能复活已清空的对话', updateReadingTurn({ input: '新草稿', attachments: [], messages: [] }, 'u1', { content: '晚到回复' }, 'complete') === undefined)
check('晚到结果不能改写已失败轮次', updateReadingTurn(failed, 'u1', { content: '晚到回复' }, 'complete') === undefined)
const newer = beginReadingTurn({ ...pending, input: '下一问题', attachments: [] }, { id: 'u2', role: 'user', content: '下一问题' }, 'a2')
const oldCancelled = updateReadingTurn(newer, 'u1', { content: '原先正文' }, 'cancelled')!
check('旧轮取消不影响已开始的新轮', oldCancelled.messages[4].delivery_status === 'pending' && oldCancelled.messages[5].content === '')
check('旧轮恢复不借用新轮附件', restoreReadingTurn({ ...oldCancelled, input: '新的草稿' }, 'a1').input === '新的草稿')
const success = updateReadingTurn(pending, 'u1', { content: '完整答案' }, 'complete')!
check('成功轮恢复到正常模型历史', activeReadingMessages(success).length === 4 && success.messages[3].content === '完整答案')
check('成功轮不显示重提入口', readingRecoveryState(success, 'a1') === 'unavailable')
const duringCompact = beginReadingTurn({ ...original, input: '压缩期间新草稿', attachments: [] }, question, 'a1')
check('发送前压缩期间的新草稿不会被清空', duringCompact.input === '压缩期间新草稿' && !duringCompact.attachments.length)
const legacy = interruptPendingReadingTurns({ ...original, messages: [...original.messages, question, { id: 'legacy', role: 'assistant', content: '回复已中断', incomplete: true, work_log: ['旧部分正文'] }] })
check('旧版部分失败记录可恢复且不重复进入历史', readingRecoveryState({ ...legacy, input: '', attachments: [] }, 'legacy') === 'ready' && activeReadingMessages(legacy).length === 2 && legacy.messages[3].work_log?.[0] === '旧部分正文')
console.log(`reading recovery: ${checks} checks passed`)
