export type NoteStyle = 'tutorial' | 'knowledge'

const legacyStyles: Record<string, NoteStyle> = {
  minimal: 'tutorial', detailed: 'tutorial', task_oriented: 'tutorial',
  academic: 'knowledge', xiaohongshu: 'knowledge', life_journal: 'knowledge',
  business: 'knowledge', meeting_minutes: 'knowledge',
}
const legacyLabels: Record<string, string> = {
  minimal: '精简', detailed: '详细', academic: '学术', xiaohongshu: '小红书',
  life_journal: '生活向', task_oriented: '任务导向', business: '商业风格', meeting_minutes: '会议纪要',
}

export function normalizeNoteStyle(style?: string): NoteStyle {
  return style === 'tutorial' || style === 'knowledge' ? style : legacyStyles[style || ''] || 'tutorial'
}

// 历史版本仍显示原风格；仅重新生成时迁移为新风格。
export function noteStyleLabel(style?: string): string {
  return style === 'tutorial' ? '教程笔记' : style === 'knowledge' ? '知识笔记' : legacyLabels[style || ''] || style || '教程笔记'
}

export function normalizeNoteFormats(formats?: readonly string[]): string[] {
  return formats?.includes('screenshot') ? ['link', 'screenshot'] : ['link']
}
