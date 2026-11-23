import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pencil, RefreshCw, Trash2 } from 'lucide-react'
import NoteImage from '@/components/NoteImage'
import type { UserAnnotationRecord } from '@/services/note'
import {
  buildOriginTimeUrl,
  sectionPlainSummary,
  spansPlainText,
  splitNumericUnits,
  type AnnotationKind,
  type ColumnWrapMode,
  type InlineSpan,
  type StructuredAnnotation,
  type StructuredBlock,
  type StructuredNoteDocument,
  type StructuredSection,
} from '@/types/structuredNote'
import { AnnotationGlyph, HairlineCloseIcon, UserNoteGlyph } from './AnnotationIcons'
import MorphingQuizCapsule, { type QuizAnswerPayload, type QuizAskPayload } from './MorphingQuizCapsule'
import './structured-note.css'

const KIND_LABELS: Record<AnnotationKind, string> = {
  why: '底层原理',
  case: '原片实测案例',
  pit: '高频避坑细节',
}

interface AnnotationEntry {
  sectionId: string
  sectionTitle: string
  item: StructuredAnnotation
}

type PopoverEntry =
  | { mode: 'ai'; data: AnnotationEntry }
  | { mode: 'user'; data: UserAnnotationRecord }

export interface StructuredFocusAnchor {
  sectionId?: string
  quizId?: string
  annotationId?: string
  nonce: number
}

interface Props {
  doc: StructuredNoteDocument
  baseURL: string
  resourceBase?: string
  videoUrl?: string
  platform?: string
  videoId?: string
  checklistScopeKey?: string
  initialQuizAnswers?: Record<string, string>
  userAnnotations?: UserAnnotationRecord[]
  focusAnchor?: StructuredFocusAnchor | null
  onJumpTime?: (seconds: number, originUrl: string | null) => void
  onAskAssistant: (payload: QuizAskPayload) => void
  onAnswerQuiz?: (payload: QuizAnswerPayload) => void
  onRefineSection?: (sectionId: string) => void
  onEditUserAnnotation?: (annotationId: string, payload: { title: string; detail: string }) => Promise<void> | void
  onDeleteUserAnnotation?: (annotationId: string) => Promise<void> | void
}

function resolveImageSrc(src: string, baseURL: string, resourceBase?: string): string {
  if (!src) return ''
  if (resourceBase && !/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(src)) {
    try {
      return new URL(src, new URL(baseURL + resourceBase, window.location.origin)).toString()
    } catch {
      return src
    }
  }
  if (src.startsWith('/')) return baseURL + src
  return src
}

function renderUnitAwareText(text: string, allowUnitNoWrap: boolean) {
  if (!allowUnitNoWrap) return text
  const tokens = splitNumericUnits(text)
  if (tokens.length <= 1 && (!tokens[0] || !tokens[0].nowrap)) return text
  return tokens.map((token, idx) =>
    token.nowrap ? (
      <span key={idx} className="unit-nowrap">
        {token.text}
      </span>
    ) : (
      <Fragment key={idx}>{token.text}</Fragment>
    ),
  )
}

function readChecklistStorage(scopeKey?: string): Record<string, boolean> {
  if (!scopeKey || typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(`bilinote-checklist:${scopeKey}`)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>
  } catch {
    // Ignore storage read failures in restricted contexts.
  }
  return {}
}

function ReadingBlockPickIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="reading-block-pick-icon"
    >
      <path className="pick-plus" d="M8 3.5v9M3.5 8h9" />
      <path className="pick-check" d="M3.5 8.4 6.5 11.4 12.5 5" />
    </svg>
  )
}

export default function StructuredNoteReader({
  doc,
  baseURL,
  resourceBase,
  videoUrl,
  platform,
  videoId,
  checklistScopeKey,
  initialQuizAnswers,
  userAnnotations = [],
  focusAnchor,
  onJumpTime,
  onAskAssistant,
  onAnswerQuiz,
  onRefineSection,
  onEditUserAnnotation,
  onDeleteUserAnnotation,
}: Props) {
  const effectivePlatform = doc.platform || platform
  const effectiveVideoId = doc.video_id || videoId
  const effectiveSourceUrl = doc.source_url || videoUrl
  const instanceId = useId()

  const [activeAnnoKey, setActiveAnnoKey] = useState<string | null>(null)
  const [editingUserAnnoId, setEditingUserAnnoId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDetail, setEditDetail] = useState('')
  const [savingUserAnno, setSavingUserAnno] = useState(false)
  const [expandedQuizId, setExpandedQuizId] = useState<string | null>(null)
  const [hoverTip, setHoverTip] = useState<{ key: string; hint: string; left: number; top: number } | null>(null)
  const [hoverVisible, setHoverVisible] = useState(false)
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number }>({ left: 18, top: 64 })
  const [checkedMap, setCheckedMap] = useState<Record<string, boolean>>(() => readChecklistStorage(checklistScopeKey))

  const stageRef = useRef<HTMLDivElement>(null)
  const hoverBubbleRef = useRef<HTMLDivElement>(null)
  const hoverTargetRef = useRef<HTMLElement | null>(null)
  const pointerPressingAnnoRef = useRef(false)
  const lastActiveEntryRef = useRef<PopoverEntry | null>(null)

  useEffect(() => {
    setCheckedMap(readChecklistStorage(checklistScopeKey))
  }, [checklistScopeKey])

  const toggleChecklistItem = useCallback(
    (itemKey: string, currentChecked: boolean) => {
      setCheckedMap(prev => {
        const next = { ...prev, [itemKey]: !currentChecked }
        if (checklistScopeKey && typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(`bilinote-checklist:${checklistScopeKey}`, JSON.stringify(next))
          } catch {
            // Keep in-memory state when storage quota is unavailable.
          }
        }
        return next
      })
    },
    [checklistScopeKey],
  )

  const annotationMap = useMemo(() => {
    const map = new Map<string, PopoverEntry>()
    doc.sections.forEach((sec, sIdx) => {
      const secId = sec.id || `sec-${sIdx + 1}`
      ;(sec.annotations || []).forEach(item => {
        map.set(`${secId}:${item.id}`, { mode: 'ai', data: { sectionId: secId, sectionTitle: sec.title, item } })
      })
    })
    userAnnotations.forEach(item => {
      map.set(`user:${item.id}`, { mode: 'user', data: item })
    })
    return map
  }, [doc.sections, userAnnotations])

  const userAnnotationsByPlacement = useMemo(() => {
    const byBlock = new Map<string, UserAnnotationRecord[]>()
    const bySection = new Map<string, UserAnnotationRecord[]>()
    const orphan: UserAnnotationRecord[] = []
    const validSectionIds = new Set(doc.sections.map((sec, idx) => sec.id || `sec-${idx + 1}`))

    // 预计算当前文档所有 blockId，便于版本重生成导致 blockId 失配时平滑回退到 sectionId
    const validBlockIds = new Set<string>()
    let counter = 0
    doc.sections.forEach(sec => {
      validBlockIds.add(`note-block-s-${counter++}`)
      ;(sec.core_takeaways || []).forEach(() => {
        validBlockIds.add(`note-block-s-${counter++}`)
      })
      ;(sec.blocks || []).forEach(blk => {
        const bid = `note-block-s-${counter++}`
        if (blk.type === 'checklist' && !(blk.items || []).length) return
        if (blk.type === 'screenshot' && !blk.image_url) return
        validBlockIds.add(bid)
      })
    })

    for (const item of userAnnotations) {
      if (item.block_id && validBlockIds.has(item.block_id)) {
        const list = byBlock.get(item.block_id) || []
        list.push(item)
        byBlock.set(item.block_id, list)
      } else if (item.section_id && validSectionIds.has(item.section_id)) {
        const list = bySection.get(item.section_id) || []
        list.push(item)
        bySection.set(item.section_id, list)
      } else {
        orphan.push(item)
      }
    }
    return { byBlock, bySection, orphan }
  }, [doc.sections, userAnnotations])

  const activeEntry = activeAnnoKey ? annotationMap.get(activeAnnoKey) || null : null
  if (activeEntry) {
    lastActiveEntryRef.current = activeEntry
  }
  const displayPopoverEntry = activeEntry ?? lastActiveEntryRef.current

  useEffect(() => {
    hoverTargetRef.current = null
    lastActiveEntryRef.current = null
    setActiveAnnoKey(null)
    setEditingUserAnnoId(null)
    setExpandedQuizId(null)
    setHoverVisible(false)
    setHoverTip(null)
  }, [doc])

  const positionPopoverNear = useCallback((dotEl: HTMLElement) => {
    const stage = stageRef.current
    if (!stage) return
    const stageRect = stage.getBoundingClientRect()
    const dRect = dotEl.getBoundingClientRect()
    const fontPx = parseFloat(getComputedStyle(stage).fontSize) || 15
    const popWidth = Math.min(Math.round(fontPx * 24.5), Math.max(220, stageRect.width - 28))
    const rawLeft = dRect.left - stageRect.left + dRect.width / 2 - popWidth * 0.42
    const clampedLeft = Math.max(14, Math.min(rawLeft, stageRect.width - popWidth - 14))
    const topPos = dRect.bottom - stageRect.top + 10
    setPopoverPos({ left: clampedLeft, top: topPos })
  }, [])

  const updateHoverPosition = useCallback(() => {
    const stage = stageRef.current
    const bubble = hoverBubbleRef.current
    const dotEl = hoverTargetRef.current
    if (!stage || !bubble || !dotEl) return
    const stageRect = stage.getBoundingClientRect()
    const dRect = dotEl.getBoundingClientRect()
    const bubbleW = bubble.offsetWidth || 160
    const bubbleH = bubble.offsetHeight || 28
    const centerLeft = dRect.left - stageRect.left + dRect.width / 2 - bubbleW / 2
    const left = Math.max(12, Math.min(centerLeft, stageRect.width - bubbleW - 12))
    const aboveTop = dRect.top - stageRect.top - bubbleH - 8
    const top = aboveTop >= 8 ? aboveTop : dRect.bottom - stageRect.top + 8
    setHoverTip(prev =>
      prev && (Math.abs(prev.left - left) > 0.5 || Math.abs(prev.top - top) > 0.5)
        ? { ...prev, left, top }
        : prev,
    )
  }, [])

  useLayoutEffect(() => {
    if (!hoverVisible || !hoverTip) return
    updateHoverPosition()
  }, [hoverVisible, hoverTip?.key, hoverTip?.hint, updateHoverPosition])

  useEffect(() => {
    if (!activeAnnoKey && !expandedQuizId) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveAnnoKey(null)
        setExpandedQuizId(null)
      }
    }
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target) return
      if (activeAnnoKey && !target.closest('.apple-popover, .anno-dot')) {
        setActiveAnnoKey(null)
      }
      if (expandedQuizId && !target.closest('.morph-quiz')) {
        setExpandedQuizId(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
    }
  }, [activeAnnoKey, expandedQuizId])

  useEffect(() => {
    if (!activeAnnoKey && !hoverVisible) return
    const stage = stageRef.current
    if (!stage) return
    const syncOverlayPositions = () => {
      if (activeAnnoKey) {
        const dotEl = Array.from(stage.querySelectorAll<HTMLElement>('[data-anno-id]')).find(
          el => el.dataset.annoId === activeAnnoKey,
        )
        if (dotEl) positionPopoverNear(dotEl)
      }
      if (hoverVisible && hoverTargetRef.current) {
        updateHoverPosition()
      }
    }
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncOverlayPositions) : null
    resizeObserver?.observe(stage)
    const mutationObserver =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(syncOverlayPositions) : null
    if (mutationObserver) {
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      })
      const readerBody = stage.closest('.reader-body')
      if (readerBody) {
        mutationObserver.observe(readerBody, { attributes: true, attributeFilter: ['style'] })
      }
    }
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [activeAnnoKey, hoverVisible, positionPopoverNear, updateHoverPosition])

  const showHoverTip = (dotEl: HTMLElement, hint: string, key: string) => {
    if (activeAnnoKey === key || pointerPressingAnnoRef.current) return
    const stage = stageRef.current
    if (!stage) return
    hoverTargetRef.current = dotEl
    const stageRect = stage.getBoundingClientRect()
    const dRect = dotEl.getBoundingClientRect()
    const bubbleW = hoverBubbleRef.current?.offsetWidth || 160
    const bubbleH = hoverBubbleRef.current?.offsetHeight || 28
    const centerLeft = dRect.left - stageRect.left + dRect.width / 2 - bubbleW / 2
    const left = Math.max(12, Math.min(centerLeft, stageRect.width - bubbleW - 12))
    const aboveTop = dRect.top - stageRect.top - bubbleH - 8
    const top = aboveTop >= 8 ? aboveTop : dRect.bottom - stageRect.top + 8
    setHoverTip({ key, hint, left, top })
    setHoverVisible(true)
  }

  const clearHoverTip = () => {
    hoverTargetRef.current = null
    // Keep last tip text & coordinates mounted during fade-out so the bubble never shrinks or jumps.
    setHoverVisible(false)
  }

  const selectAnno = (key: string, dotEl?: HTMLElement | null) => {
    pointerPressingAnnoRef.current = false
    setExpandedQuizId(null)
    setEditingUserAnnoId(null)
    clearHoverTip()
    if (activeAnnoKey === key) {
      setActiveAnnoKey(null)
      return
    }
    setActiveAnnoKey(key)
    if (dotEl) {
      positionPopoverNear(dotEl)
    }
  }

  const triggerTimeJump = (seconds: number) => {
    const url = buildOriginTimeUrl(effectivePlatform, effectiveVideoId, effectiveSourceUrl, seconds)
    if (onJumpTime) {
      onJumpTime(seconds, url)
    } else if (url) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  // 响应复习本/全文搜索的跨路由精准锚点定位，自动滚动并触发 1.6s 动态强调色柔光脉冲
  useEffect(() => {
    if (!focusAnchor) return
    const stage = stageRef.current
    if (!stage) return

    const timer = window.setTimeout(() => {
      let targetEl: HTMLElement | null = null
      const annoKey = focusAnchor.sectionId && focusAnchor.annotationId
        ? `${focusAnchor.sectionId}:${focusAnchor.annotationId}`
        : null

      if (annoKey) {
        targetEl = stage.querySelector<HTMLElement>(`[data-anno-id="${CSS.escape(annoKey)}"]`)
      } else if (focusAnchor.annotationId) {
        targetEl = stage.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(focusAnchor.annotationId)}"]`)
      } else if (focusAnchor.quizId) {
        targetEl = stage.querySelector<HTMLElement>(`[data-quiz-id="${CSS.escape(focusAnchor.quizId)}"]`)
      } else if (focusAnchor.sectionId) {
        targetEl = stage.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(focusAnchor.sectionId)}"]`)
      }

      if (!targetEl) return
      const reduced = document.documentElement.dataset.reducedMotion === 'true'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches
      targetEl.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })

      const highlightNode = targetEl.closest<HTMLElement>('.reading-block, .note-quiz-anchor, .note-section') || targetEl
      highlightNode.classList.remove('anchor-pulse-highlight')
      void highlightNode.offsetWidth
      highlightNode.classList.add('anchor-pulse-highlight')
      window.setTimeout(() => highlightNode.classList.remove('anchor-pulse-highlight'), 1650)

      if (focusAnchor.annotationId) {
        const key = targetEl.dataset.annoId || annoKey
        if (key && annotationMap.has(key)) {
          setExpandedQuizId(null)
          setActiveAnnoKey(key)
          window.requestAnimationFrame(() => positionPopoverNear(targetEl!))
        }
      } else if (focusAnchor.quizId) {
        setActiveAnnoKey(null)
        setExpandedQuizId(focusAnchor.quizId)
      }
    }, 80)

    return () => window.clearTimeout(timer)
  }, [focusAnchor, annotationMap, positionPopoverNear])

  const renderAnnoButton = (anno: StructuredAnnotation, sectionId: string, keyPrefix: string) => {
    const annoKey = `${sectionId}:${anno.id}`
    const isOpen = activeAnnoKey === annoKey
    return (
      <button
        key={keyPrefix}
        type="button"
        className={`anno-dot${isOpen ? ' is-open' : ''}`}
        data-anno-id={annoKey}
        data-annotation-id={anno.id}
        aria-label={`查看${KIND_LABELS[anno.kind]}`}
        aria-expanded={isOpen}
        onMouseDown={() => {
          pointerPressingAnnoRef.current = true
          clearHoverTip()
        }}
        onMouseUp={() => {
          pointerPressingAnnoRef.current = false
        }}
        onMouseEnter={e => showHoverTip(e.currentTarget, anno.short_hint, annoKey)}
        onMouseLeave={() => {
          pointerPressingAnnoRef.current = false
          clearHoverTip()
        }}
        onFocus={e => showHoverTip(e.currentTarget, anno.short_hint, annoKey)}
        onBlur={clearHoverTip}
        onClick={e => {
          e.stopPropagation()
          selectAnno(annoKey, e.currentTarget)
        }}
      >
        <AnnotationGlyph kind={anno.kind} />
      </button>
    )
  }

  const renderUserAnnoButton = (anno: UserAnnotationRecord, keyPrefix: string) => {
    const annoKey = `user:${anno.id}`
    const isOpen = activeAnnoKey === annoKey
    const labelPrefix = anno.source === 'assistant' ? '助手沉淀批注' : '个人批注'
    return (
      <button
        key={keyPrefix}
        type="button"
        className={`anno-dot is-user${anno.source === 'assistant' ? ' is-assistant' : ''}${isOpen ? ' is-open' : ''}`}
        data-anno-id={annoKey}
        data-annotation-id={anno.id}
        aria-label={`查看${labelPrefix}：${anno.title}`}
        aria-expanded={isOpen}
        onMouseDown={() => {
          pointerPressingAnnoRef.current = true
          clearHoverTip()
        }}
        onMouseUp={() => {
          pointerPressingAnnoRef.current = false
        }}
        onMouseEnter={e => showHoverTip(e.currentTarget, `${labelPrefix} · ${anno.title}`, annoKey)}
        onMouseLeave={() => {
          pointerPressingAnnoRef.current = false
          clearHoverTip()
        }}
        onFocus={e => showHoverTip(e.currentTarget, `${labelPrefix} · ${anno.title}`, annoKey)}
        onBlur={clearHoverTip}
        onClick={e => {
          e.stopPropagation()
          selectAnno(annoKey, e.currentTarget)
        }}
      >
        <UserNoteGlyph source={anno.source} />
      </button>
    )
  }

  const renderSpans = (
    spans: readonly InlineSpan[] | undefined,
    sectionId: string,
    annoById: Map<string, StructuredAnnotation>,
    allowUnitNoWrap = false,
    omitAnnotations = false,
  ) => {
    if (!Array.isArray(spans)) return null
    return spans.map((span, idx) => {
      const emp = span.emphasis || 'plain'
      let body: React.ReactNode = renderUnitAwareText(span.text || '', allowUnitNoWrap && emp !== 'code')
      if (emp === 'hl') {
        body = <span className="emp-hl">{body}</span>
      } else if (emp === 'ul') {
        body = <span className="emp-ul">{body}</span>
      } else if (emp === 'wave') {
        body = <span className="emp-wave">{body}</span>
      } else if (emp === 'code') {
        body = <code className="code-pill">{span.text}</code>
      }

      const anno = !omitAnnotations && span.annotation_id ? annoById.get(span.annotation_id) : undefined

      return (
        <Fragment key={idx}>
          {body}
          {anno && renderAnnoButton(anno, sectionId, `${sectionId}-a-${idx}`)}
        </Fragment>
      )
    })
  }

  let blockCounter = 0

  const renderBlock = (
    block: StructuredBlock,
    section: StructuredSection,
    sectionId: string,
    annoById: Map<string, StructuredAnnotation>,
  ) => {
    const blockId = `note-block-s-${blockCounter++}`
    let noteText = ''
    let node: React.ReactNode = null

    if (block.type === 'paragraph') {
      noteText = spansPlainText(block.spans)
      node = <p className="note-p">{renderSpans(block.spans, sectionId, annoById, true)}</p>
    } else if (block.type === 'table') {
      const cols = block.columns.slice(0, 4)
      const modes: ColumnWrapMode[] = block.column_modes?.slice(0, cols.length) || cols.map((_, idx) => (idx === 0 ? 'nowrap' : 'wrap'))
      noteText = [cols.join(' | '), ...block.rows.map(row => row.slice(0, cols.length).map(cell => spansPlainText(cell)).join(' | '))].join('\n')
      node = (
        <div className="note-table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                {cols.map((col, cIdx) => (
                  <th key={cIdx}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {cols.map((_, cIdx) => {
                    const cellSpans = row[cIdx] || []
                    const cellMode = modes[cIdx] || 'wrap'
                    return (
                      <td key={cIdx} className={cellMode === 'nowrap' ? 'nowrap-cell' : 'wrap-cell'}>
                        {renderSpans(cellSpans, sectionId, annoById, true)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    } else if (block.type === 'flow_chain') {
      noteText = block.steps.map(step => spansPlainText(step)).join(' → ')
      node = (
        <div className="flow-chain">
          {block.steps.map((step, sIdx) => (
            <Fragment key={sIdx}>
              {sIdx > 0 && <span className="chain-arrow" aria-hidden="true">→</span>}
              <span>{renderSpans(step, sectionId, annoById, true)}</span>
            </Fragment>
          ))}
        </div>
      )
    } else if (block.type === 'list') {
      const Tag = block.ordered ? 'ol' : 'ul'
      noteText = block.items.map((item, idx) => `${block.ordered ? `${idx + 1}.` : '-'} ${spansPlainText(item)}`).join('\n')
      node = (
        <Tag className="note-list" style={{ listStyleType: block.ordered ? 'decimal' : 'disc' }}>
          {block.items.map((item, idx) => (
            <li key={idx}>{renderSpans(item, sectionId, annoById, true)}</li>
          ))}
        </Tag>
      )
    } else if (block.type === 'checklist') {
      const items = block.items || []
      if (!items.length) return null
      const title = (block.title || '').trim() || '环境准备自查'
      const resolvedStates = items.map((item, idx) => {
        const key = `${sectionId}:${blockId}:${item.id || idx}`
        const isChecked = Object.prototype.hasOwnProperty.call(checkedMap, key)
          ? checkedMap[key]
          : Boolean(item.checked)
        return { item, key, isChecked }
      })
      const doneCount = resolvedStates.filter(entry => entry.isChecked).length
      const allDone = doneCount === items.length
      noteText = [
        title,
        ...resolvedStates.map(({ item, isChecked }) => `- [${isChecked ? 'x' : ' '}] ${spansPlainText(item.spans)}`),
      ].join('\n')
      node = (
        <div className={`note-checklist${allDone ? ' is-all-done' : ''}`} role="group" aria-label={title}>
          <div className="note-checklist-head">
            <span className="note-checklist-title">{title}</span>
            <span className={`note-checklist-count${allDone ? ' is-done' : ''}`} aria-live="polite">
              {doneCount}/{items.length}
            </span>
          </div>
          <ul className="note-checklist-list">
            {resolvedStates.map(({ item, key, isChecked }, idx) => {
              const inputId = `${instanceId}-${blockId}-${idx}`
              const trailingAnnos = (item.spans || [])
                .map(span => (span.annotation_id ? annoById.get(span.annotation_id) : undefined))
                .filter((anno): anno is StructuredAnnotation => Boolean(anno))
              return (
                <li key={key} className={`note-checklist-row${isChecked ? ' is-checked' : ''}`}>
                  <input
                    id={inputId}
                    type="checkbox"
                    className="note-checklist-input"
                    checked={isChecked}
                    onClick={e => e.stopPropagation()}
                    onChange={() => toggleChecklistItem(key, isChecked)}
                  />
                  <div className="note-checklist-content">
                    <label
                      htmlFor={inputId}
                      className="note-checklist-label"
                      onClick={e => e.stopPropagation()}
                    >
                      {renderSpans(item.spans, sectionId, annoById, true, true)}
                    </label>
                    {trailingAnnos.map((anno, aIdx) => renderAnnoButton(anno, sectionId, `${key}-a-${aIdx}`))}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )
    } else if (block.type === 'code_block') {
      noteText = `\`\`\`${block.language || ''}\n${block.code}\n\`\`\``
      node = (
        <pre className="note-code-block">
          <code>{block.code}</code>
        </pre>
      )
    } else if (block.type === 'screenshot') {
      if (!block.image_url) return null
      const resolvedSrc = resolveImageSrc(block.image_url, baseURL, resourceBase)
      const caption = block.caption || `视频截图 ${block.label || ''}`.trim()
      noteText = `![${caption}](${block.image_url})`
      node = (
        <figure className="note-screenshot-figure">
          <NoteImage src={resolvedSrc} alt={caption} />
          {caption && <figcaption className="note-screenshot-caption">{caption}</figcaption>}
        </figure>
      )
    }

    if (!node) return null

    const blockUserAnnos = userAnnotationsByPlacement.byBlock.get(blockId) || []
    if (blockUserAnnos.length > 0 && block.type === 'paragraph') {
      node = (
        <p className="note-p">
          {renderSpans(block.spans, sectionId, annoById, true)}
          <span className="user-anno-tray">
            {blockUserAnnos.map(item => renderUserAnnoButton(item, `ua-${item.id}`))}
          </span>
        </p>
      )
    }

    return (
      <div
        key={blockId}
        id={blockId}
        className="reading-block"
        data-note-block={blockId}
        data-note-text={noteText}
      >
        <button
          type="button"
          className="reading-block-pick"
          data-block-pick={blockId}
          aria-label="选择段落"
          title="选择段落，可加入 AI 问答"
        >
          <ReadingBlockPickIcon />
        </button>
        {node}
        {blockUserAnnos.length > 0 && block.type !== 'paragraph' && (
          <div className="section-user-annos">
            <span className="section-user-annos-label">批注</span>
            {blockUserAnnos.map(item => renderUserAnnoButton(item, `ua-${item.id}`))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="structured-note-shell">
      <div
        className="stage-wrap"
        ref={stageRef}
        onClick={() => {
          if (activeAnnoKey) setActiveAnnoKey(null)
          setExpandedQuizId(null)
        }}
      >
        <div className="main-column">
          {doc.sections.map((section, sIdx) => {
            const sectionId = section.id || `sec-${sIdx + 1}`
            const headingId = `note-chapter-${sIdx + 1}`
            const annoById = new Map((section.annotations || []).map(a => [a.id, a]))
            const times = (section.time_ranges || []).map(r => r.start).filter(Number.isFinite)
            const annoTimes = (section.annotations || [])
              .map(a => a.timestamp)
              .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
            const summary = sectionPlainSummary(section)
            const HeadingTag = section.level === 3 ? 'h3' : 'h2'
            const headingBlockId = `note-block-s-${blockCounter++}`

            return (
              <section key={sectionId} className="note-section" data-section-id={sectionId}>
                <div
                  id={headingBlockId}
                  className="reading-block"
                  data-note-block={headingBlockId}
                  data-note-text={`${section.level === 3 ? '###' : '##'} ${section.title}`}
                >
                  <button
                    type="button"
                    className="reading-block-pick"
                    data-block-pick={headingBlockId}
                    aria-label={`选择章节 ${section.title}`}
                    title="选择章节，可加入 AI 问答"
                  >
                    <ReadingBlockPickIcon />
                  </button>
                  <div className="note-sec-head">
                    <HeadingTag
                      id={headingId}
                      className="note-title"
                      data-level={section.level || 2}
                      data-note-heading="true"
                      data-note-label={section.title}
                      data-note-time={times[0] !== undefined ? String(times[0]) : undefined}
                      data-note-times={times.length ? times.join(',') : undefined}
                      data-note-ranges={section.time_ranges?.length ? JSON.stringify(section.time_ranges) : undefined}
                      data-note-anno-times={annoTimes.length ? annoTimes.join(',') : undefined}
                    >
                      {section.title}
                    </HeadingTag>

                    {(section.time_ranges?.length > 0 || onRefineSection) && (
                      <div className="sec-head-actions">
                        {section.time_ranges?.length > 0 && (
                          <div className="ts-pill-group" aria-label="原片时间点">
                            {section.time_ranges.map((tr, tIdx) => (
                              <Fragment key={`${tr.start}-${tIdx}`}>
                                {tIdx > 0 && <span className="ts-pill-sep">·</span>}
                                <button
                                  type="button"
                                  className="ts-pill-btn"
                                  title={`定位到原片 ${tr.label}`}
                                  onClick={e => {
                                    e.stopPropagation()
                                    triggerTimeJump(tr.start)
                                  }}
                                >
                                  {tr.label}
                                </button>
                              </Fragment>
                            ))}
                          </div>
                        )}
                        {onRefineSection && (
                          <button
                            type="button"
                            className="sec-refine-btn"
                            aria-label={`重新蒸馏章节 ${section.title}`}
                            title="重新蒸馏本节"
                            onClick={e => {
                              e.stopPropagation()
                              onRefineSection(sectionId)
                            }}
                          >
                            <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {(section.core_takeaways || []).map((tk, tkIdx) => {
                  const tkBlockId = `note-block-s-${blockCounter++}`
                  const tkText = spansPlainText(tk.spans)
                  const tkUserAnnos = userAnnotationsByPlacement.byBlock.get(tkBlockId) || []
                  return (
                    <div
                      key={`${sectionId}-tk-${tkIdx}`}
                      id={tkBlockId}
                      className="reading-block"
                      data-note-block={tkBlockId}
                      data-note-text={tkText}
                    >
                      <button
                        type="button"
                        className="reading-block-pick"
                        data-block-pick={tkBlockId}
                        aria-label="选择核心结论"
                        title="选择段落，可加入 AI 问答"
                      >
                        <ReadingBlockPickIcon />
                      </button>
                      <p className="note-p is-takeaway">
                        {renderSpans(tk.spans, sectionId, annoById, true)}
                        {tkUserAnnos.length > 0 && (
                          <span className="user-anno-tray">
                            {tkUserAnnos.map(item => renderUserAnnoButton(item, `ua-${item.id}`))}
                          </span>
                        )}
                      </p>
                    </div>
                  )
                })}

                {(section.blocks || []).map(block => renderBlock(block, section, sectionId, annoById))}

                {((userAnnotationsByPlacement.byBlock.get(headingBlockId) || []).length > 0
                  || (userAnnotationsByPlacement.bySection.get(sectionId) || []).length > 0) && (
                  <div className="section-user-annos" aria-label="本节个人批注">
                    <span className="section-user-annos-label">本节批注</span>
                    {[
                      ...(userAnnotationsByPlacement.byBlock.get(headingBlockId) || []),
                      ...(userAnnotationsByPlacement.bySection.get(sectionId) || []),
                    ].map(item => renderUserAnnoButton(item, `ua-sec-${item.id}`))}
                  </div>
                )}

                {section.quiz && (
                  <div className="note-quiz-anchor" data-quiz-id={sectionId}>
                    <MorphingQuizCapsule
                      quiz={section.quiz}
                      sectionId={sectionId}
                      sectionTitle={section.title}
                      sectionSummary={summary}
                      expanded={expandedQuizId === sectionId}
                      initialPickedKey={initialQuizAnswers?.[sectionId] ?? null}
                      onExpandedChange={next => {
                        if (next) {
                          setActiveAnnoKey(null)
                          setExpandedQuizId(sectionId)
                        } else {
                          setExpandedQuizId(current => (current === sectionId ? null : current))
                        }
                      }}
                      onAskAssistant={onAskAssistant}
                      onAnswer={onAnswerQuiz}
                    />
                  </div>
                )}
              </section>
            )
          })}
          {userAnnotationsByPlacement.orphan.length > 0 && (
            <div className="section-user-annos" aria-label="其他个人批注">
              <span className="section-user-annos-label">个人批注</span>
              {userAnnotationsByPlacement.orphan.map(item => renderUserAnnoButton(item, `ua-orphan-${item.id}`))}
            </div>
          )}
        </div>

        <div
          ref={hoverBubbleRef}
          className={`hover-bubble glass-surface${hoverVisible && hoverTip ? ' is-visible' : ''}`}
          aria-hidden={!hoverVisible}
          style={{
            left: hoverTip ? `${hoverTip.left}px` : undefined,
            top: hoverTip ? `${hoverTip.top}px` : undefined,
          }}
        >
          <span className="bubble-dot" />
          <span>{hoverTip?.hint || ''}</span>
        </div>

        <div
          className={`apple-popover glass-surface${activeEntry ? ' is-open' : ''}`}
          aria-hidden={!activeEntry}
          style={{ left: `${popoverPos.left}px`, top: `${popoverPos.top}px` }}
          onClick={e => e.stopPropagation()}
        >
          {displayPopoverEntry && displayPopoverEntry.mode === 'ai' && (
            <>
              <div className="pop-header">
                <div className="pop-meta">
                  <span className="pop-tag">{KIND_LABELS[displayPopoverEntry.data.item.kind]}</span>
                  {displayPopoverEntry.data.item.timestamp_label && (
                    <button
                      type="button"
                      className="pop-ts"
                      onClick={() => {
                        if (typeof displayPopoverEntry.data.item.timestamp === 'number') {
                          triggerTimeJump(displayPopoverEntry.data.item.timestamp)
                        }
                      }}
                    >
                      {displayPopoverEntry.data.item.timestamp_label}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="close-circle"
                  aria-label="关闭详注"
                  onClick={e => {
                    e.stopPropagation()
                    setActiveAnnoKey(null)
                  }}
                >
                  <HairlineCloseIcon />
                </button>
              </div>
              <p className="pop-content">{displayPopoverEntry.data.item.full_detail}</p>
            </>
          )}

          {displayPopoverEntry && displayPopoverEntry.mode === 'user' && (() => {
            const u = displayPopoverEntry.data
            const isEditing = editingUserAnnoId === u.id
            return (
              <>
                <div className="pop-header">
                  <div className="pop-meta">
                    <span className="pop-tag">{u.source === 'assistant' ? '助手沉淀' : '个人批注'}</span>
                    {u.section_title && <span className="pop-ts" style={{ cursor: 'default' }}>{u.section_title}</span>}
                  </div>
                  <button
                    type="button"
                    className="close-circle"
                    aria-label="关闭批注"
                    onClick={e => {
                      e.stopPropagation()
                      setEditingUserAnnoId(null)
                      setActiveAnnoKey(null)
                    }}
                  >
                    <HairlineCloseIcon />
                  </button>
                </div>

                {u.anchor_text && (
                  <blockquote className="pop-anchor-quote">“{u.anchor_text}”</blockquote>
                )}

                {isEditing ? (
                  <form
                    className="pop-edit-form"
                    onSubmit={async event => {
                      event.preventDefault()
                      if (!onEditUserAnnotation || !editDetail.trim() || savingUserAnno) return
                      setSavingUserAnno(true)
                      try {
                        await onEditUserAnnotation(u.id, {
                          title: editTitle.trim(),
                          detail: editDetail.trim(),
                        })
                        setEditingUserAnnoId(null)
                      } finally {
                        setSavingUserAnno(false)
                      }
                    }}
                  >
                    <input
                      type="text"
                      className="pop-edit-input"
                      placeholder="批注标题"
                      maxLength={80}
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                    />
                    <textarea
                      className="pop-edit-textarea"
                      placeholder="批注内容"
                      maxLength={4000}
                      value={editDetail}
                      onChange={e => setEditDetail(e.target.value)}
                    />
                    <div className="pop-user-actions">
                      <button
                        type="button"
                        className="pop-action-btn"
                        disabled={savingUserAnno}
                        onClick={() => setEditingUserAnnoId(null)}
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        className="pop-action-btn is-primary"
                        disabled={savingUserAnno || !editDetail.trim()}
                      >
                        {savingUserAnno ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    {u.title && <p className="pop-user-title">{u.title}</p>}
                    <p className="pop-content" style={{ whiteSpace: 'pre-wrap' }}>{u.detail}</p>
                    {(onEditUserAnnotation || onDeleteUserAnnotation) && (
                      <div className="pop-user-actions">
                        {onEditUserAnnotation && (
                          <button
                            type="button"
                            className="pop-action-btn"
                            onClick={() => {
                              setEditTitle(u.title || '')
                              setEditDetail(u.detail || '')
                              setEditingUserAnnoId(u.id)
                            }}
                          >
                            <Pencil size={11} strokeWidth={1.7} />
                            <span>编辑</span>
                          </button>
                        )}
                        {onDeleteUserAnnotation && (
                          <button
                            type="button"
                            className="pop-action-btn is-danger"
                            onClick={async () => {
                              if (savingUserAnno) return
                              setSavingUserAnno(true)
                              try {
                                await onDeleteUserAnnotation(u.id)
                                setActiveAnnoKey(null)
                              } finally {
                                setSavingUserAnno(false)
                              }
                            }}
                          >
                            <Trash2 size={11} strokeWidth={1.7} />
                            <span>删除</span>
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )
          })()}
        </div>
      </div>
    </div>
  )
}
