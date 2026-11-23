export type NoteStyle = 'knowledge' | 'tutorial'
export type EmphasisType = 'plain' | 'hl' | 'ul' | 'wave' | 'code'
export type AnnotationKind = 'why' | 'case' | 'pit'
export type TableKind = 'comparison' | 'params' | 'troubleshooting'
export type ColumnWrapMode = 'nowrap' | 'wrap'

export interface TimeRange {
  start: number
  end: number
  label: string
}

export interface InlineSpan {
  text: string
  emphasis?: EmphasisType
  annotation_id?: string | null
}

export interface StructuredTakeaway {
  spans: InlineSpan[]
}

export interface StructuredAnnotation {
  id: string
  kind: AnnotationKind
  short_hint: string
  full_detail: string
  timestamp?: number | null
  timestamp_label?: string
}

export interface QuizOption {
  key: string
  text: string
}

export interface StructuredQuiz {
  short_prompt: string
  full_question: string
  options: QuizOption[]
  correct_key: string
  explanation: string
}

export interface StructuredChecklistItem {
  id: string
  spans: InlineSpan[]
  checked?: boolean
}

export type StructuredBlock =
  | { type: 'paragraph'; spans: InlineSpan[] }
  | {
      type: 'table'
      table_kind?: TableKind
      columns: string[]
      column_modes?: ColumnWrapMode[]
      rows: InlineSpan[][][]
    }
  | { type: 'flow_chain'; steps: InlineSpan[][] }
  | { type: 'list'; ordered: boolean; items: InlineSpan[][] }
  | { type: 'checklist'; title?: string; items: StructuredChecklistItem[] }
  | { type: 'code_block'; language?: string; code: string }
  | { type: 'screenshot'; timestamp: number; label?: string; caption?: string; image_url: string }

export interface StructuredSection {
  id: string
  title: string
  level: 2 | 3
  time_ranges: TimeRange[]
  core_takeaways: StructuredTakeaway[]
  blocks: StructuredBlock[]
  annotations: StructuredAnnotation[]
  quiz: StructuredQuiz | null
}

export interface StructuredNoteDocument {
  schema_version: 1
  note_style: NoteStyle
  title: string
  source_url?: string
  platform?: string
  video_id?: string
  sections: StructuredSection[]
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export function parseTimeSearchQuery(query: string): number | null {
  const trimmed = query.trim()
  const match = trimmed.match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/)
  if (!match) return null
  const hours = match[1] !== undefined ? Number(match[1]) : 0
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  if (seconds >= 60 || (match[1] !== undefined && minutes >= 60)) return null
  return hours * 3600 + minutes * 60 + seconds
}

export function buildOriginTimeUrl(
  platform?: string,
  videoId?: string,
  videoUrl?: string,
  seconds?: number,
): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null
  const sec = Math.floor(seconds)
  if (platform === 'bilibili' && videoId) {
    const part = videoId.match(/^(.+)_p([1-9]\d*)$/)
    const baseId = part ? part[1] : videoId
    const qs = new URLSearchParams(part ? { p: part[2], t: String(sec) } : { t: String(sec) })
    return `https://www.bilibili.com/video/${encodeURIComponent(baseId)}?${qs.toString()}`
  }
  if (platform === 'youtube' && videoId) {
    const qs = new URLSearchParams({ v: videoId, t: `${sec}s` })
    return `https://www.youtube.com/watch?${qs.toString()}`
  }
  if (platform === 'x') {
    if (videoUrl && /^https?:\/\//i.test(videoUrl)) return videoUrl
    if (videoId) return `https://x.com/i/status/${encodeURIComponent(videoId)}`
  }
  if (platform === 'xiaoyuzhou') {
    if (videoUrl && /^https?:\/\//i.test(videoUrl)) return videoUrl
    if (videoId) return `https://www.xiaoyuzhoufm.com/episode/${encodeURIComponent(videoId)}`
  }
  if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
    return videoUrl
  }
  return null
}

const NUMERIC_UNIT_PATTERN = /(\b\d+(?:\.\d+)?\s*(?:ms|s|Hz|kHz|GB|MB|KB|px|pt|mm|cm|m|min|h|%)\b|CPU核数\s*[×x*]\s*\d+(?:\s*\+\s*\d+)?|\d+\s*(?:毫秒|秒|分钟|小时|核|倍|条|次|个))/gi

export interface UnitToken {
  text: string
  nowrap: boolean
}

export function splitNumericUnits(text: string): UnitToken[] {
  if (!text) return []
  const tokens: UnitToken[] = []
  let lastIndex = 0
  for (const match of text.matchAll(NUMERIC_UNIT_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), nowrap: false })
    }
    tokens.push({ text: match[0], nowrap: true })
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), nowrap: false })
  }
  return tokens
}

function isValidStructuredDoc(value: unknown): value is StructuredNoteDocument {
  if (!value || typeof value !== 'object') return false
  const obj = value as Partial<StructuredNoteDocument>
  return Array.isArray(obj.sections) && obj.sections.length > 0 && typeof obj.title === 'string'
}

export function resolveStructuredNote(
  version: { structured?: unknown } | null | undefined,
  rawContent: string,
): StructuredNoteDocument | null {
  if (version && isValidStructuredDoc(version.structured)) {
    return version.structured
  }
  const trimmed = (rawContent || '').trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (isValidStructuredDoc(parsed)) {
        return parsed
      }
    } catch {
      // Plain markdown starting with '{' safely falls back to MarkdownContent.
    }
  }
  return null
}

export function spansPlainText(spans: readonly InlineSpan[] | undefined): string {
  if (!Array.isArray(spans)) return ''
  return spans.map(span => span.text || '').join('')
}

export function sectionPlainSummary(section: StructuredSection): string {
  const parts: string[] = []
  for (const tk of section.core_takeaways || []) {
    const txt = spansPlainText(tk.spans).trim()
    if (txt) parts.push(txt)
  }
  for (const block of section.blocks || []) {
    if (block.type === 'paragraph') {
      const txt = spansPlainText(block.spans).trim()
      if (txt) parts.push(txt)
    } else if (block.type === 'flow_chain') {
      const txt = block.steps.map(step => spansPlainText(step).trim()).filter(Boolean).join(' → ')
      if (txt) parts.push(txt)
    } else if (block.type === 'list') {
      const txt = block.items.map(item => spansPlainText(item).trim()).filter(Boolean).join('；')
      if (txt) parts.push(txt)
    } else if (block.type === 'checklist') {
      const txt = (block.items || []).map(item => spansPlainText(item.spans).trim()).filter(Boolean).join('；')
      if (txt) parts.push(block.title ? `${block.title}：${txt}` : txt)
    }
  }
  return parts.join('\n').slice(0, 1200)
}

const MINDMAP_KIND_LABELS: Record<AnnotationKind, string> = {
  why: '原理',
  case: '案例',
  pit: '避坑',
}

export function structuredNoteToMindmapMarkdown(doc: StructuredNoteDocument): string {
  const lines: string[] = [`# ${(doc.title || '笔记导图').trim()}`]
  for (const sec of doc.sections || []) {
    const headingPrefix = sec.level === 3 ? '###' : '##'
    const timeSuffix = sec.time_ranges?.length
      ? ` (${sec.time_ranges.map(r => r.label || formatSeconds(r.start)).join(', ')})`
      : ''
    lines.push('', `${headingPrefix} ${(sec.title || '未命名章节').trim()}${timeSuffix}`)

    for (const takeaway of sec.core_takeaways || []) {
      const text = spansPlainText(takeaway.spans).replace(/\s+/g, ' ').trim()
      if (text) lines.push(`- **${text}**`)
    }

    for (const block of sec.blocks || []) {
      if (block.type === 'paragraph') {
        const text = spansPlainText(block.spans).replace(/\s+/g, ' ').trim()
        if (text) lines.push(`- ${text}`)
      } else if (block.type === 'flow_chain') {
        const chain = block.steps
          .map(step => spansPlainText(step).replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' → ')
        if (chain) lines.push(`- 因果链：${chain}`)
      } else if (block.type === 'list') {
        for (const item of block.items || []) {
          const text = spansPlainText(item).replace(/\s+/g, ' ').trim()
          if (text) lines.push(`- ${text}`)
        }
      } else if (block.type === 'checklist') {
        for (const item of block.items || []) {
          const text = spansPlainText(item.spans).replace(/\s+/g, ' ').trim()
          if (text) lines.push(`- [自查] ${text}`)
        }
      } else if (block.type === 'table') {
        const cols = (block.columns || []).slice(0, 4)
        for (const row of block.rows || []) {
          const cells = row.slice(0, cols.length).map(cell => spansPlainText(cell).replace(/\s+/g, ' ').trim())
          if (!cells.some(Boolean)) continue
          const lead = cells[0] || cols[0] || '要点'
          const rest = cells
            .slice(1)
            .map((val, idx) => (val ? `${cols[idx + 1] ? `${cols[idx + 1]}：` : ''}${val}` : ''))
            .filter(Boolean)
            .join(' · ')
          lines.push(rest ? `- \`${lead}\` — ${rest}` : `- \`${lead}\``)
        }
      } else if (block.type === 'code_block' && block.code?.trim()) {
        const firstLine = block.code.trim().split(/\r?\n/)[0]?.trim().slice(0, 72)
        if (firstLine) lines.push(`- 代码示例：\`${firstLine}\``)
      }
    }

    const pitAnnotations = (sec.annotations || []).filter(anno => anno.kind === 'pit')
    const otherAnnotations = (sec.annotations || []).filter(anno => anno.kind !== 'pit')

    for (const anno of otherAnnotations) {
      const hint = (anno.short_hint || '').replace(/\s+/g, ' ').trim()
      if (hint) lines.push(`- [${MINDMAP_KIND_LABELS[anno.kind] || '要点'}] ${hint}`)
    }
    if (pitAnnotations.length > 0) {
      lines.push('- 高频避坑')
      for (const pit of pitAnnotations) {
        const hint = (pit.short_hint || pit.full_detail || '').replace(/\s+/g, ' ').trim()
        if (hint) lines.push(`  - [避坑] ${hint}`)
      }
    }
  }
  return lines.join('\n')
}
