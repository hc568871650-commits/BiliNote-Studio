import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StructuredQuiz } from '@/types/structuredNote'
import { AskChatIcon, CheckCircleIcon, CrossCircleIcon, HairlineCloseIcon, MiniStatusGlyph } from './AnnotationIcons'

export interface QuizAskPayload {
  quiz: StructuredQuiz
  pickedKey: string
  sectionTitle: string
  sectionSummary: string
}

export interface QuizAnswerPayload {
  sectionId: string
  sectionTitle: string
  pickedKey: string
  correctKey: string
  isCorrect: boolean
  question: string
  explanation: string
}

interface Props {
  quiz: StructuredQuiz
  sectionId: string
  sectionTitle: string
  sectionSummary: string
  expanded: boolean
  initialPickedKey?: string | null
  onExpandedChange: (next: boolean) => void
  onAskAssistant: (payload: QuizAskPayload) => void
  onAnswer?: (payload: QuizAnswerPayload) => void
}

export default function MorphingQuizCapsule({
  quiz,
  sectionId,
  sectionTitle,
  sectionSummary,
  expanded,
  initialPickedKey = null,
  onExpandedChange,
  onAskAssistant,
  onAnswer,
}: Props) {
  const [pickedKey, setPickedKey] = useState<string | null>(initialPickedKey)
  const [askToast, setAskToast] = useState('')
  const [boxStyle, setBoxStyle] = useState<{
    width?: number
    height?: number
    fullWidth?: number
    miniHeight?: number
    ansHeight: number
  }>({
    ansHeight: 0,
  })

  const slotRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLButtonElement>(null)
  const fullRef = useRef<HTMLDivElement>(null)
  const qRowRef = useRef<HTMLDivElement>(null)
  const optsRef = useRef<HTMLDivElement>(null)
  const ansInnerRef = useRef<HTMLDivElement>(null)
  const lastPickedKeyRef = useRef<string | null>(null)

  if (pickedKey !== null) {
    lastPickedKeyRef.current = pickedKey
  }

  const answered = pickedKey !== null
  const isCorrect = pickedKey === quiz.correct_key
  const displayKey = pickedKey ?? lastPickedKeyRef.current
  const displayOption = displayKey ? quiz.options.find(opt => opt.key === displayKey) : null
  const displayIsCorrect = displayKey !== null && displayKey === quiz.correct_key

  useEffect(() => {
    setPickedKey(initialPickedKey ?? null)
    setAskToast('')
    lastPickedKeyRef.current = initialPickedKey ?? null
  }, [quiz, initialPickedKey])

  const syncDimensions = useCallback(() => {
    const slot = slotRef.current
    if (!slot) return
    const availW = slot.clientWidth || 440
    const fontPx = parseFloat(getComputedStyle(slot).fontSize) || 15
    const targetFullW = Math.min(Math.round(fontPx * 30), availW)
    if (fullRef.current) {
      fullRef.current.style.width = `${targetFullW}px`
    }

    const ansTopGap = ansInnerRef.current ? parseFloat(getComputedStyle(ansInnerRef.current).marginTop) || 0 : 0
    const desiredAnsH = answered && ansInnerRef.current ? Math.ceil(ansInnerRef.current.offsetHeight + ansTopGap) : 0
    const miniRectH = Math.ceil(miniRef.current?.offsetHeight || slot.clientHeight || fontPx * 2.05)

    const commitBox = (next: {
      width: number
      height: number
      fullWidth: number
      miniHeight: number
      ansHeight: number
    }) => {
      setBoxStyle(prev =>
        prev.width === next.width &&
        prev.height === next.height &&
        prev.fullWidth === next.fullWidth &&
        prev.miniHeight === next.miniHeight &&
        prev.ansHeight === next.ansHeight
          ? prev
          : next,
      )
    }

    if (!expanded) {
      const naturalMiniW = Math.ceil((miniRef.current?.scrollWidth || 220) + 2)
      const miniW = Math.min(naturalMiniW, availW)
      commitBox({
        width: miniW,
        height: miniRectH,
        fullWidth: targetFullW,
        miniHeight: miniRectH,
        ansHeight: desiredAnsH,
      })
    } else {
      const fullStyle = fullRef.current ? getComputedStyle(fullRef.current) : null
      const padY = fullStyle
        ? (parseFloat(fullStyle.paddingTop) || 0) + (parseFloat(fullStyle.paddingBottom) || 0)
        : 20
      const qGap = qRowRef.current ? parseFloat(getComputedStyle(qRowRef.current).marginBottom) || 0 : 8
      const qH = qRowRef.current?.offsetHeight || 24
      const optsH = optsRef.current?.offsetHeight || 96
      const finalH = Math.ceil(padY + qH + qGap + optsH + desiredAnsH + 2)
      commitBox({
        width: targetFullW,
        height: finalH,
        fullWidth: targetFullW,
        miniHeight: miniRectH,
        ansHeight: desiredAnsH,
      })
    }
  }, [answered, expanded])

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(syncDimensions)
    return () => cancelAnimationFrame(raf)
  }, [syncDimensions, pickedKey, askToast, quiz])

  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    const scheduleSync = () => requestAnimationFrame(syncDimensions)
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleSync) : null
    if (resizeObserver) {
      ;[slot, miniRef.current, qRowRef.current, optsRef.current, ansInnerRef.current].forEach(el => {
        if (el) resizeObserver.observe(el)
      })
    }
    const mutationObserver =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(scheduleSync) : null
    if (mutationObserver) {
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      })
      const readerBody = slot.closest('.reader-body')
      if (readerBody) {
        mutationObserver.observe(readerBody, { attributes: true, attributeFilter: ['style'] })
      }
    }
    let active = true
    document.fonts?.ready.then(() => {
      if (active) scheduleSync()
    })
    return () => {
      active = false
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [syncDimensions])

  return (
    <div
      className="quiz-anchor-slot"
      ref={slotRef}
      style={boxStyle.miniHeight ? { height: `${boxStyle.miniHeight}px` } : undefined}
    >
      <div
        className={`morph-quiz glass-surface${expanded ? ' is-expanded' : ''}`}
        role={expanded ? 'region' : undefined}
        aria-label={expanded ? `章节自测：${quiz.full_question}` : undefined}
        style={{
          width: boxStyle.width ? `${boxStyle.width}px` : undefined,
          height: boxStyle.height ? `${boxStyle.height}px` : '2.05em',
        }}
        onClick={event => {
          event.stopPropagation()
          if (!expanded) onExpandedChange(true)
        }}
        onKeyDown={event => {
          if (expanded && event.key === 'Escape') {
            event.stopPropagation()
            onExpandedChange(false)
          }
        }}
      >
        <button
          type="button"
          className={`quiz-mini-layer${answered ? ' has-badge' : ''}`}
          ref={miniRef}
          aria-label={`展开自测：${quiz.short_prompt}`}
          aria-expanded={expanded}
          aria-hidden={expanded}
          tabIndex={expanded ? -1 : 0}
          onClick={event => {
            event.stopPropagation()
            onExpandedChange(true)
          }}
        >
          <span className={`mini-dot${answered ? (isCorrect ? ' is-pass' : ' is-fail') : ''}`}>
            {answered && <MiniStatusGlyph pass={isCorrect} />}
          </span>
          <span className="mini-text">{quiz.short_prompt}</span>
        </button>

        <div
          className="quiz-full-layer"
          ref={fullRef}
          aria-hidden={!expanded}
          inert={!expanded}
          style={{ width: boxStyle.fullWidth ? `${boxStyle.fullWidth}px` : undefined }}
        >
          <div className="quiz-q-row" ref={qRowRef}>
            <p className="quiz-q">{quiz.full_question}</p>
            <button
              type="button"
              className="close-circle"
              aria-label="收起自测"
              onClick={event => {
                event.stopPropagation()
                onExpandedChange(false)
              }}
            >
              <HairlineCloseIcon />
            </button>
          </div>

          <div className="quiz-options" ref={optsRef}>
            {quiz.options.map(opt => {
              const isAnswer = opt.key === quiz.correct_key
              const isPickedWrong = answered && !isAnswer && opt.key === pickedKey
              const isCrossedOut = answered && !isAnswer && opt.key !== pickedKey
              const stateClass = answered
                ? isAnswer
                  ? 'is-locked is-answer-right show-mark'
                  : isPickedWrong
                    ? 'is-locked is-picked-wrong show-mark'
                    : 'is-locked is-crossed-out'
                : ''

              return (
                <button
                  key={opt.key}
                  type="button"
                  className={`quiz-opt${stateClass ? ` ${stateClass}` : ''}`}
                  disabled={answered}
                  onClick={event => {
                    event.stopPropagation()
                    if (!answered) {
                      setPickedKey(opt.key)
                      onAnswer?.({
                        sectionId,
                        sectionTitle,
                        pickedKey: opt.key,
                        correctKey: quiz.correct_key,
                        isCorrect: opt.key === quiz.correct_key,
                        question: quiz.full_question,
                        explanation: quiz.explanation,
                      })
                    }
                  }}
                >
                  <span className="opt-left">
                    <span className="opt-key">{opt.key}</span>
                    <span className="opt-text">{opt.text}</span>
                  </span>
                  <span className="opt-mark">
                    {answered && isAnswer && <CheckCircleIcon />}
                    {isPickedWrong && <CrossCircleIcon />}
                  </span>
                </button>
              )
            })}
          </div>

          <div
            className={`quiz-answer-wrap${answered ? ' is-open' : ''}`}
            style={{ height: answered ? `${boxStyle.ansHeight}px` : '0px' }}
          >
            <div className="quiz-answer-inner" ref={ansInnerRef}>
              <p className="ans-explain">
                {displayKey !== null && (
                  <span className={`ans-status-chip ${displayIsCorrect ? 'is-pass' : 'is-fail'}`}>
                    {displayIsCorrect
                      ? `回答正确 · 选 ${quiz.correct_key}`
                      : `选错了（你选了 ${displayOption?.key || displayKey}）· 正确为 ${quiz.correct_key}`}
                  </span>
                )}
                {quiz.explanation}
              </p>
              <div className="ans-footer">
                <div className="ans-actions">
                  <button
                    type="button"
                    className="ask-pill"
                    onClick={event => {
                      event.stopPropagation()
                      if (!pickedKey) return
                      onAskAssistant({ quiz, pickedKey, sectionTitle, sectionSummary })
                      setAskToast(`已挂入右侧聊天框（含你的选项 ${pickedKey}）`)
                    }}
                  >
                    <AskChatIcon />
                    <span>去问助手</span>
                  </button>
                  <button
                    type="button"
                    className="quiz-reset"
                    onClick={event => {
                      event.stopPropagation()
                      setPickedKey(null)
                      setAskToast('')
                    }}
                  >
                    重选
                  </button>
                </div>
                <span className={`ask-toast${askToast ? ' is-shown' : ''}`}>{askToast}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
