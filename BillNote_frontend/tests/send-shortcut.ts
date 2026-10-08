import assert from 'node:assert/strict'
import { shouldSendMessage, sendShortcutLabel } from '../src/utils/sendShortcut'

const enter = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  nativeEvent: { isComposing: false, keyCode: 13 } }
assert.equal(shouldSendMessage(enter, 'enter'), true)
assert.equal(shouldSendMessage(enter, 'mod-enter'), false)
assert.equal(shouldSendMessage({ ...enter, ctrlKey: true }, 'mod-enter'), true)
assert.equal(shouldSendMessage({ ...enter, ctrlKey: true }, 'enter'), false)
for (const extra of [{ shiftKey: true }, { metaKey: true }, { altKey: true },
  { nativeEvent: { isComposing: true } }, { nativeEvent: { isComposing: false, keyCode: 229 } }]) {
  assert.equal(shouldSendMessage({ ...enter, ...extra }, 'enter'), false)
  assert.equal(shouldSendMessage({ ...enter, ctrlKey: true, ...extra }, 'mod-enter'), false)
}
assert.equal(sendShortcutLabel('mod-enter'), 'Ctrl+Enter 发送 · Enter 换行')
console.log('PASS: Enter/Ctrl+Enter, modifier isolation and IME confirmation')
