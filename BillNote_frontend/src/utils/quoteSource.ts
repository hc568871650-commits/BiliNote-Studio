import type { ReadingAttachment } from '../store/readingAssistantStore'

export interface QuotePart {
  blockId?: string
  text: string
  partial?: boolean
  sourceText?: string
}

/** Offsets refer to the single stored text, preserving Markdown verbatim. */
export function quoteParts(attachment: ReadingAttachment): QuotePart[] {
  const text = attachment.text || ''
  const parts: QuotePart[] = []
  let previousEnd = 0
  for (const range of Array.isArray(attachment.blocks) ? attachment.blocks : []) {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < previousEnd || range.end <= range.start || range.end > text.length) continue
    previousEnd = range.end
    const partText = text.slice(range.start, range.end)
    if (partText.trim()) parts.push({ blockId: range.blockId, text: partText })
  }
  return parts.length ? parts : text.trim() ? [{ blockId: attachment.blockId, text,
    ...(attachment.sourceText ? { sourceText: attachment.sourceText } : {}),
    ...(!attachment.blocks?.length && (attachment.blockCount || 1) === 1 ? { partial: true } : {}),
  }] : []
}

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim()

function visibleBlockText(element: HTMLElement): string {
  // Selection controls are not part of the note. Retain literal '+' in its body.
  const content = element.cloneNode(true) as HTMLElement
  content.querySelectorAll('[data-block-pick]').forEach(control => control.remove())
  return normalize(content.textContent || '')
}

function blockText(element: HTMLElement): string {
  return element.dataset.noteText?.trim() ? normalize(element.dataset.noteText) : visibleBlockText(element)
}

/** The caller supplies the already-selected note/version root. Never search globally. */
export function resolveQuoteTargets(root: HTMLElement, parts: QuotePart[]): HTMLElement[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-note-block]'))
  const candidates = blocks.map(element => ({ element, text: blockText(element) }))
  const targets: HTMLElement[] = []
  for (const part of parts) {
    const text = normalize(part.partial && part.sourceText ? part.sourceText : part.text)
    if (!text) continue
    const idMatches = part.blockId ? candidates.filter(candidate => candidate.element.dataset.noteBlock === part.blockId) : []
    const exactId = idMatches.filter(candidate => candidate.text === text)
    let target = exactId.length === 1 ? exactId[0].element : undefined
    if (!target && part.partial) {
      const containsText = (candidate: typeof candidates[number]) => candidate.text.includes(text)
        || visibleBlockText(candidate.element).includes(text)
      const partialIds = idMatches.filter(containsText)
      if (partialIds.length === 1) target = partialIds[0].element
      if (!target) {
        const partialText = candidates.filter(containsText)
        if (partialText.length === 1) target = partialText[0].element
      }
    }
    if (!target && !part.partial) {
      const exactText = candidates.filter(candidate => candidate.text === text)
      if (exactText.length === 1) target = exactText[0].element
    }
    // Legacy merged quotes retained only their first block ID. Recover that
    // starting point only when its content is a complete prefix of the quote.
    if (!target && !part.partial && parts.length === 1 && idMatches.length === 1) {
      const first = idMatches[0]
      if (first.text && text.startsWith(`${first.text} `)) target = first.element
    }
    if (target && !targets.includes(target)) targets.push(target)
  }
  return targets
}
