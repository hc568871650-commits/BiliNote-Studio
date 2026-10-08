type SendMode = 'enter' | 'mod-enter'
interface SendEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  nativeEvent: { isComposing: boolean; keyCode?: number }
}

export function shouldSendMessage(event: SendEvent, mode: SendMode): boolean {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    || event.shiftKey || event.altKey || event.metaKey) return false
  return mode === 'mod-enter' ? event.ctrlKey : !event.ctrlKey
}

export const sendShortcutLabel = (mode: SendMode) => mode === 'mod-enter'
  ? 'Ctrl+Enter 发送 · Enter 换行' : 'Enter 发送'
