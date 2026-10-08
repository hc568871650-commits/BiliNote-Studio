// Unset builds retain the existing full feature set.
export const isQuickEdition = import.meta.env.VITE_BILINOTE_EDITION === 'quick'
export const hasLocalWhisper = !isQuickEdition && import.meta.env.VITE_BILINOTE_LOCAL_WHISPER !== '0'
export const editionName = import.meta.env.VITE_BILINOTE_DISTRIBUTION === 'installer' ? '预览版' : isQuickEdition ? '快捷版' : '完整版'
export const quickTranscriberTypes = ['groq', 'bcut', 'kuaishou']
