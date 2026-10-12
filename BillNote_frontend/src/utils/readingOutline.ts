export interface ReadingOutlineHeading {
  id: string
  text: string
  level: number
  time?: number
}

export interface ReadingOutlineGroup {
  id: string
  title: ReadingOutlineHeading
  /** Includes the title; every heading appears exactly once across groups. */
  items: ReadingOutlineHeading[]
}

export interface ReadingOutline {
  full: ReadingOutlineHeading[]
  groups: ReadingOutlineGroup[]
  /** True when consecutive chapters are combined to keep the overview compact. */
  grouped: boolean
}

const titleKey = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ')
const isSourceSegment = (text: string) => /^来源分段\s*\d+\s*$/.test(titleKey(text))

/** Build navigation only. Never rewrite body IDs, sort by timestamp, or infer new titles. */
export function buildReadingOutline(headings: readonly ReadingOutlineHeading[]): ReadingOutline {
  const visible = headings.filter(heading => heading.text.trim() && !isSourceSegment(heading.text))
  const h1Counts = new Map<string, number>()
  for (const heading of visible) {
    if (heading.level === 1) {
      const key = titleKey(heading.text)
      h1Counts.set(key, (h1Counts.get(key) ?? 0) + 1)
    }
  }
  // Repeated course titles are generation wrappers. Retain all-heading-only
  // documents and ordinary same-name chapters rather than broadly deduplicating.
  const hasBodyHeadings = visible.some(heading => heading.level > 1)
  const full = visible.filter(heading => !(hasBodyHeadings && heading.level === 1 && (h1Counts.get(titleKey(heading.text)) ?? 0) > 1))
  if (!full.length) return { full, groups: [], grouped: false }

  // A lone opening H1 is the document title, not a chapter enclosing everything.
  const openingTitle = full[0].level === 1 && full.filter(heading => heading.level === 1).length === 1 && full.length > 1
  const body = openingTitle ? full.slice(1) : full
  const shallowest = Math.min(...body.map(heading => heading.level))
  const chapters: ReadingOutlineGroup[] = []
  for (const heading of body) {
    if (!chapters.length || heading.level === shallowest) {
      chapters.push({ id: heading.id, title: heading, items: [heading] })
    } else {
      chapters[chapters.length - 1].items.push(heading)
    }
  }

  // Flat generated notes have dozens of peer headings. Use balanced consecutive
  // windows; labels remain actual source headings, with no semantic invention.
  const grouped = chapters.length >= 24
  let groups = chapters
  if (grouped) {
    const targetCount = Math.min(openingTitle ? 11 : 12, Math.max(8, Math.ceil(chapters.length / 10)))
    const windowSize = Math.ceil(chapters.length / targetCount)
    groups = []
    for (let index = 0; index < chapters.length; index += windowSize) {
      const window = chapters.slice(index, index + windowSize)
      groups.push({ id: window[0].id, title: window[0].title, items: window.flatMap(chapter => chapter.items) })
    }
  }
  if (openingTitle) groups.unshift({ id: full[0].id, title: full[0], items: [full[0]] })
  return { full, groups, grouped }
}
