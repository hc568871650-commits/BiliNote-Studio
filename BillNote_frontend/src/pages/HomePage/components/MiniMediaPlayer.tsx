import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { HairlineCloseIcon } from './StructuredNoteReader/AnnotationIcons'
import {
  clampPlaybackRate,
  findSegmentIndexForTime,
  formatMediaTime,
  nextPlaybackRate,
  type OnlineVideoEmbed,
  type PlaybackRate,
  type TranscriptSegmentLike,
} from '@/utils/mediaTranscriptSync'
import {
  clampVideoPosition,
  clampVideoWidth,
  computeResizedFloatingRect,
  computeVideoSizeLimits,
  createDefaultFloatingState,
  FLOATING_VIDEO_EDGE_MARGIN,
  persistFloatingLayout,
  restoreFloatingState,
  snapVideoPosition,
  videoHeightForWidth,
  type ContainerBounds,
  type FloatingVideoState,
  type ResizeCorner,
} from '@/utils/floatingVideoLayout'
import './mini-media-player.css'

const CAPTIONS_STORAGE_KEY = 'bilinote-media-captions-v1'
const DRAG_THRESHOLD_PX = 4
const KEYBOARD_STEP_PX = 28
const FRAME_BORDER_PX = 2
const COLLAPSED_BAR_WIDTH = 248
const COLLAPSED_STAGE_HEIGHT = 34
const COLLAPSED_BAR_HEIGHT = COLLAPSED_STAGE_HEIGHT + FRAME_BORDER_PX
const RUBBER_BAND_MAX_X = 7
const RUBBER_BAND_MAX_TOP = 5
const RUBBER_BAND_MAX_BOTTOM = 6

function collapsedWidthFor(videoWidth: number): number {
  return Math.min(videoWidth, COLLAPSED_BAR_WIDTH)
}

// Apple 柔和阻尼 + 严格硬上限：快接近容器边框时阻力迅速增大，绝不越出边框外
function rubberBandOffset(excess: number, maxOffset: number): number {
  if (excess === 0 || maxOffset <= 0) return 0
  const sign = Math.sign(excess)
  const abs = Math.abs(excess)
  const damped = (abs * maxOffset * 0.24) / (maxOffset + abs * 0.24)
  return Number((sign * Math.min(maxOffset, damped)).toFixed(2))
}

function readCaptionsPreference(): boolean {
  try {
    const raw = localStorage.getItem(CAPTIONS_STORAGE_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    // 存储不可用时默认开启字幕
  }
  return true
}

function writeCaptionsPreference(enabled: boolean): void {
  try {
    localStorage.setItem(CAPTIONS_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // 忽略受限存储
  }
}

export interface MediaSeekCommand {
  seconds: number
  autoPlay: boolean
  nonce: number
}

interface MiniMediaPlayerProps {
  open: boolean
  src: string
  mediaType?: string | null
  synthetic?: boolean
  onlineEmbed?: OnlineVideoEmbed | null
  transcriptSegments?: readonly TranscriptSegmentLike[]
  durationHint?: number
  seekCommand: MediaSeekCommand | null
  externalUrl?: string | null
  onTimeUpdate?: (seconds: number) => void
  onPlayingChange?: (playing: boolean) => void
  onUnavailable?: () => void
  onClose: () => void
}

type VelocitySample = {
  x: number
  y: number
  t: number
}

type MoveSession = {
  kind: 'move'
  fromEar: boolean
  earPullMode: 'undecided' | 'expand' | 'move'
  pointerId: number
  captureEl: HTMLElement
  startClientX: number
  startClientY: number
  startTime: number
  startLeft: number
  startTop: number
  startWidth: number
  startDisplayWidth: number
  startDockX: 'left' | 'right'
  anchorBottom: number
  anchorRight: number
  startExpanded: boolean
  fullHeight: number
  currentStageHeight: number
  collapseEnteredAt: number | null
  velocitySamples: VelocitySample[]
  moved: boolean
}

type ResizeSession = {
  kind: 'resize'
  corner: ResizeCorner
  pointerId: number
  captureEl: HTMLElement
  startClientX: number
  startClientY: number
  startLeft: number
  startTop: number
  startWidth: number
}

export default function MiniMediaPlayer({
  open,
  src,
  mediaType = null,
  synthetic = false,
  onlineEmbed = null,
  transcriptSegments = [],
  durationHint = 0,
  seekCommand,
  externalUrl,
  onTimeUpdate,
  onPlayingChange,
  onUnavailable,
  onClose,
}: MiniMediaPlayerProps) {
  const isEmbedMode = Boolean(!src && onlineEmbed)
  const isLocalVideo = Boolean(!isEmbedMode && (synthetic || (mediaType && mediaType.toLowerCase().startsWith('video/'))))
  const canExpandVideo = isEmbedMode || isLocalVideo

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const floatingRef = useRef<HTMLDivElement | null>(null)
  const interactionRef = useRef<MoveSession | ResizeSession | null>(null)
  const suppressClickRef = useRef(false)
  const liveTimerRef = useRef<number | null>(null)
  const moveRafRef = useRef<number | null>(null)
  const pendingMoveFrameRef = useRef<{
    left: number
    top: number
    width?: number
    curtain: number | null | 'keep'
    mode?: 'dragging' | 'curtain'
  } | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(durationHint > 0 ? durationHint : 0)
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(1)
  const [muted, setMuted] = useState(false)
  // 本地音视频默认收起为精简音频进度条，按住顶耳上拉或点击展开为 16:9 视频；在线嵌入直接展开
  const [videoExpanded, setVideoExpanded] = useState<boolean>(isEmbedMode)
  const [curtainHeight, setCurtainHeight] = useState<number | null>(null)
  const [embedBarOpen, setEmbedBarOpen] = useState(false)
  const [captionsEnabled, setCaptionsEnabled] = useState<boolean>(() => readCaptionsPreference())
  const [embedStartTime, setEmbedStartTime] = useState(0)
  const [embedAutoPlay, setEmbedAutoPlay] = useState(true)
  const [embedNonce, setEmbedNonce] = useState(0)
  const [embedCaptionOffset, setEmbedCaptionOffset] = useState(0)

  const bottomClearance = 16
  const [bounds, setBounds] = useState<ContainerBounds>({
    width: 960,
    height: 640,
    bottomClearance,
  })
  const [floating, setFloating] = useState<FloatingVideoState>(() =>
    restoreFloatingState({ width: 960, height: 640, bottomClearance }),
  )
  const floatingStateRef = useRef(floating)
  floatingStateRef.current = floating
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const videoExpandedRef = useRef(videoExpanded)
  videoExpandedRef.current = videoExpanded

  const [interactionMode, setInteractionMode] = useState<'idle' | 'dragging' | 'resizing' | 'curtain'>('idle')
  const [liveAnnouncement, setLiveAnnouncement] = useState('')

  const onTimeUpdateRef = useRef(onTimeUpdate)
  const onPlayingChangeRef = useRef(onPlayingChange)
  const onUnavailableRef = useRef(onUnavailable)
  onTimeUpdateRef.current = onTimeUpdate
  onPlayingChangeRef.current = onPlayingChange
  onUnavailableRef.current = onUnavailable

  const fullStageHeight = videoHeightForWidth(floating.width)
  const activeStageHeight = isEmbedMode
    ? fullStageHeight
    : curtainHeight !== null
      ? curtainHeight
      : (videoExpanded && isLocalVideo ? fullStageHeight : COLLAPSED_STAGE_HEIGHT)

  const displayWidthFor = useCallback(
    (videoWidth: number, expanded: boolean, stageOverride: number | null = null): number => {
      if (isEmbedMode) return videoWidth
      const minW = collapsedWidthFor(videoWidth)
      if (stageOverride !== null) {
        const fullH = videoHeightForWidth(videoWidth)
        const span = Math.max(1, fullH - COLLAPSED_STAGE_HEIGHT)
        const t = Math.max(0, Math.min(1, (stageOverride - COLLAPSED_STAGE_HEIGHT) / span))
        return Math.round(minW + (videoWidth - minW) * t)
      }
      return expanded && isLocalVideo ? videoWidth : minW
    },
    [isEmbedMode, isLocalVideo],
  )

  const currentTotalHeight = useCallback(
    (width: number, expanded: boolean, stageOverride: number | null = null): number => {
      if (isEmbedMode) {
        const capExtra = captionsEnabled && transcriptSegments.length > 0 ? 40 : 0
        return videoHeightForWidth(width) + FRAME_BORDER_PX + capExtra
      }
      const stageH = stageOverride !== null
        ? stageOverride
        : (expanded && isLocalVideo ? videoHeightForWidth(width) : COLLAPSED_STAGE_HEIGHT)
      return Math.max(COLLAPSED_BAR_HEIGHT, stageH + FRAME_BORDER_PX)
    },
    [captionsEnabled, isEmbedMode, isLocalVideo, transcriptSegments.length],
  )

  const extraHeightForClamping = useCallback(
    (width: number, expanded: boolean, stageOverride: number | null = null): number => {
      const displayW = displayWidthFor(width, expanded, stageOverride)
      return currentTotalHeight(width, expanded, stageOverride) - videoHeightForWidth(displayW)
    },
    [currentTotalHeight, displayWidthFor],
  )

  const announce = useCallback((message: string) => {
    setLiveAnnouncement(message)
    if (liveTimerRef.current !== null) window.clearTimeout(liveTimerRef.current)
    liveTimerRef.current = window.setTimeout(() => {
      setLiveAnnouncement('')
      liveTimerRef.current = null
    }, 1400)
  }, [])

  const applyPhysicsStyle = useCallback((ox: number, oy: number) => {
    const el = floatingRef.current
    if (!el) return
    el.style.setProperty('--pip-ox', `${ox}px`)
    el.style.setProperty('--pip-oy', `${oy}px`)
  }, [])

  const resetPhysicsStyle = useCallback(() => {
    applyPhysicsStyle(0, 0)
  }, [applyPhysicsStyle])

  const cancelPendingMoveFrame = useCallback(() => {
    if (moveRafRef.current !== null) {
      window.cancelAnimationFrame(moveRafRef.current)
      moveRafRef.current = null
    }
    pendingMoveFrameRef.current = null
  }, [])

  const scheduleMoveFrame = useCallback((frame: {
    left: number
    top: number
    width?: number
    curtain: number | null | 'keep'
    mode?: 'dragging' | 'curtain'
  }) => {
    pendingMoveFrameRef.current = frame
    if (moveRafRef.current !== null) return
    moveRafRef.current = window.requestAnimationFrame(() => {
      moveRafRef.current = null
      const next = pendingMoveFrameRef.current
      pendingMoveFrameRef.current = null
      if (!next) return
      if (next.curtain !== 'keep') setCurtainHeight(next.curtain)
      if (next.mode) setInteractionMode(next.mode)
      setFloating(prev => {
        const nextWidth = next.width ?? prev.width
        if (prev.left === next.left && prev.top === next.top && prev.width === nextWidth) return prev
        return { ...prev, width: nextWidth, left: next.left, top: next.top }
      })
    })
  }, [])

  useEffect(() => () => {
    if (liveTimerRef.current !== null) window.clearTimeout(liveTimerRef.current)
    if (moveRafRef.current !== null) window.cancelAnimationFrame(moveRafRef.current)
  }, [])

  const getActiveMediaEl = useCallback((): HTMLMediaElement | null => {
    return isLocalVideo ? videoRef.current : audioRef.current
  }, [isLocalVideo])

  const supportsPiP =
    typeof document !== 'undefined'
    && 'pictureInPictureEnabled' in document
    && Boolean((document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled)

  const toggleCaptions = useCallback(() => {
    setCaptionsEnabled(prev => {
      const next = !prev
      writeCaptionsPreference(next)
      return next
    })
  }, [])

  // 停靠角锚定切换展开/收起状态（底边与停靠侧边同时 0px 锚定，宽度与高度同步丝滑舒展/收拢）
  const setExpandedAnchored = useCallback((nextExpanded: boolean) => {
    if (!isLocalVideo) return
    const cur = floatingStateRef.current
    const b = boundsRef.current
    const prevExp = videoExpandedRef.current
    const prevW = displayWidthFor(cur.width, prevExp, null)
    const nextW = displayWidthFor(cur.width, nextExpanded, null)
    const prevTotal = currentTotalHeight(cur.width, prevExp, null)
    const nextTotal = currentTotalHeight(cur.width, nextExpanded, null)
    const anchorBottom = cur.top + prevTotal
    const targetTop = anchorBottom - nextTotal
    const targetLeft = cur.dockX === 'right' ? cur.left + prevW - nextW : cur.left
    const extra = nextTotal - videoHeightForWidth(nextW)
    const clamped = clampVideoPosition(targetLeft, targetTop, nextW, b, extra)
    setVideoExpanded(nextExpanded)
    setCurtainHeight(null)
    const nextState: FloatingVideoState = { ...cur, left: clamped.left, top: clamped.top }
    setFloating(nextState)
    persistFloatingLayout({ ...nextState, width: cur.width }, b, extra)
    announce(nextExpanded ? '已展开视频画面' : '已收起为音频进度条')
  }, [announce, currentTotalHeight, displayWidthFor, isLocalVideo])

  // 切换模式时同步默认形态（本地音视频默认收起为音频进度条，在线嵌入默认展开）
  useEffect(() => {
    if (!open) return
    setVideoExpanded(isEmbedMode)
    setCurtainHeight(null)
  }, [open, isEmbedMode])

  // 监测阅读区容器大小变化，动态收敛尺寸上限与贴边磁吸
  useEffect(() => {
    if (!open) return
    const host = floatingRef.current?.offsetParent as HTMLElement | null
    if (!host) return

    const syncBounds = (isInitial: boolean) => {
      const rect = host.getBoundingClientRect()
      if (rect.width < 120 || rect.height < 120) return
      const nextBounds: ContainerBounds = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottomClearance: 16,
      }
      setBounds(nextBounds)
      setFloating(prev => {
        const exp = isInitial ? isEmbedMode : videoExpandedRef.current
        if (isInitial) {
          const restored = restoreFloatingState(nextBounds, 0)
          const displayW = displayWidthFor(restored.width, exp, null)
          const totalH = currentTotalHeight(restored.width, exp, null)
          const minLeft = FLOATING_VIDEO_EDGE_MARGIN
          const maxLeft = Math.max(minLeft, nextBounds.width - displayW - FLOATING_VIDEO_EDGE_MARGIN)
          const dockedLeft = restored.dockX === 'left' ? minLeft : maxLeft
          const minTop = FLOATING_VIDEO_EDGE_MARGIN
          const maxTop = Math.max(minTop, nextBounds.height - totalH - nextBounds.bottomClearance)
          return {
            ...restored,
            left: dockedLeft,
            top: maxTop,
          }
        }
        const nextWidth = clampVideoWidth(prev.width, nextBounds)
        const displayW = displayWidthFor(nextWidth, exp, null)
        const minLeft = FLOATING_VIDEO_EDGE_MARGIN
        const maxLeft = Math.max(minLeft, nextBounds.width - displayW - FLOATING_VIDEO_EDGE_MARGIN)
        const dockedLeft = prev.dockX === 'left' ? minLeft : maxLeft
        const extra = extraHeightForClamping(nextWidth, exp, null)
        const clamped = clampVideoPosition(dockedLeft, prev.top, displayW, nextBounds, extra)
        return { width: nextWidth, left: clamped.left, top: clamped.top, dockX: prev.dockX }
      })
    }

    syncBounds(true)
    const observer = new ResizeObserver(() => syncBounds(false))
    observer.observe(host)
    return () => observer.disconnect()
  }, [open, isEmbedMode, currentTotalHeight, displayWidthFor, extraHeightForClamping])

  useEffect(() => {
    if (durationHint > 0 && duration <= 0) {
      setDuration(durationHint)
    }
  }, [duration, durationHint])

  useEffect(() => {
    if (!open) {
      cancelPendingMoveFrame()
      resetPhysicsStyle()
      setPlaying(false)
      setInteractionMode('idle')
      setCurtainHeight(null)
      interactionRef.current = null
      const media = getActiveMediaEl()
      if (media) media.pause()
      if (typeof document !== 'undefined' && document.pictureInPictureElement) {
        void document.exitPictureInPicture().catch(() => undefined)
      }
    }
  }, [open, cancelPendingMoveFrame, getActiveMediaEl, resetPhysicsStyle])

  useEffect(() => {
    onPlayingChangeRef.current?.(open && !isEmbedMode && playing)
  }, [open, isEmbedMode, playing])

  useEffect(() => {
    if (!open) return
    onTimeUpdateRef.current?.(currentTime)
  }, [open, currentTime])

  // 合成预览虚拟时钟
  useEffect(() => {
    if (!open || !synthetic || isEmbedMode || !playing) return
    const maxSec = Math.max(duration || durationHint || 2700, 60)
    let lastTick = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      const deltaSec = ((now - lastTick) / 1000) * playbackRate
      lastTick = now
      setCurrentTime(prev => Math.min(maxSec, prev + deltaSec))
    }, 250)
    return () => window.clearInterval(timer)
  }, [open, synthetic, isEmbedMode, playing, playbackRate, duration, durationHint])

  useEffect(() => {
    if (!open || !synthetic || isEmbedMode || !playing) return
    const maxSec = Math.max(duration || durationHint || 2700, 60)
    if (currentTime >= maxSec) setPlaying(false)
  }, [open, synthetic, isEmbedMode, playing, currentTime, duration, durationHint])

  // 响应外部 seek 命令
  useEffect(() => {
    if (!open || !seekCommand) return
    const target = Math.max(0, seekCommand.seconds)
    setCurrentTime(target)
    setEmbedCaptionOffset(0)

    if (isEmbedMode) {
      setEmbedStartTime(target)
      setEmbedAutoPlay(seekCommand.autoPlay)
      setEmbedNonce(seekCommand.nonce)
      setVideoExpanded(true)
      return
    }

    if (synthetic) {
      setDuration(prev => Math.max(prev, durationHint || 0, target + 120))
      if (seekCommand.autoPlay) setPlaying(true)
      return
    }

    const media = getActiveMediaEl()
    if (!media) return
    const applySeek = () => {
      try {
        media.currentTime = target
        if (seekCommand.autoPlay) void media.play().catch(() => undefined)
      } catch {
        // 等待元数据就绪
      }
    }
    if (media.readyState >= 1) {
      applySeek()
    } else {
      const onLoaded = () => {
        media.removeEventListener('loadedmetadata', onLoaded)
        applySeek()
      }
      media.addEventListener('loadedmetadata', onLoaded)
      return () => media.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [open, seekCommand, isEmbedMode, synthetic, durationHint, getActiveMediaEl])

  useEffect(() => {
    const media = getActiveMediaEl()
    if (!media || synthetic || isEmbedMode) return
    media.playbackRate = playbackRate
  }, [playbackRate, synthetic, isEmbedMode, getActiveMediaEl])

  useEffect(() => {
    const media = getActiveMediaEl()
    if (!media || synthetic || isEmbedMode) return
    media.muted = muted
  }, [muted, synthetic, isEmbedMode, getActiveMediaEl])

  const seekTo = useCallback((seconds: number) => {
    const maxSec = duration > 0 ? duration : Math.max(seconds, 0)
    const clamped = Math.max(0, Math.min(maxSec, seconds))
    setCurrentTime(clamped)
    if (!synthetic && !isEmbedMode) {
      const media = getActiveMediaEl()
      if (media) {
        try {
          media.currentTime = clamped
        } catch {
          // 忽略未就绪状态
        }
      }
    }
  }, [duration, synthetic, isEmbedMode, getActiveMediaEl])

  const togglePlay = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (synthetic) {
      setPlaying(prev => !prev)
      return
    }
    const media = getActiveMediaEl()
    if (!media) return
    if (media.paused) void media.play().catch(() => undefined)
    else media.pause()
  }, [synthetic, getActiveMediaEl])

  const togglePictureInPicture = useCallback(async () => {
    const video = videoRef.current
    if (!video || !supportsPiP) return
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch {
      // 忽略系统策略拒绝
    }
  }, [supportsPiP])

  // ---------------- 两类零冲突指针手势：整窗全向拖动（收起态顶耳上拉优先展开，展开态触底续拉压扁收起）/ 四角等比缩放 ----------------

  const beginMoveSession = useCallback((event: ReactPointerEvent<HTMLElement>, fromEar: boolean) => {
    const captureEl = event.currentTarget
    const cur = floatingStateRef.current
    const fullH = videoHeightForWidth(cur.width)
    const startExp = isEmbedMode || videoExpandedRef.current
    const startDisplayW = displayWidthFor(cur.width, startExp, null)
    const startTotal = currentTotalHeight(cur.width, startExp, null)
    const now = performance.now()
    const earPullMode: MoveSession['earPullMode'] =
      fromEar && !startExp && canExpandVideo ? 'undecided' : 'move'

    interactionRef.current = {
      kind: 'move',
      fromEar,
      earPullMode,
      pointerId: event.pointerId,
      captureEl,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTime: now,
      startLeft: cur.left,
      startTop: cur.top,
      startWidth: cur.width,
      startDisplayWidth: startDisplayW,
      startDockX: cur.dockX,
      anchorBottom: cur.top + startTotal,
      anchorRight: cur.left + startDisplayW,
      startExpanded: startExp,
      fullHeight: fullH,
      currentStageHeight: startExp ? fullH : COLLAPSED_STAGE_HEIGHT,
      collapseEnteredAt: null,
      velocitySamples: [{ x: event.clientX, y: event.clientY, t: now }],
      moved: false,
    }
    try {
      captureEl.setPointerCapture(event.pointerId)
    } catch {
      // 忽略
    }
  }, [canExpandVideo, currentTotalHeight, displayWidthFor, isEmbedMode])

  const startBodyMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, [data-resize-corner], .apple-scrubber')) return
    beginMoveSession(event, false)
  }, [beginMoveSession])

  const startEarDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    beginMoveSession(event, true)
  }, [beginMoveSession])

  const startResize = useCallback((corner: ResizeCorner, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const captureEl = event.currentTarget
    const cur = floatingStateRef.current
    interactionRef.current = {
      kind: 'resize',
      corner,
      pointerId: event.pointerId,
      captureEl,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: cur.left,
      startTop: cur.top,
      startWidth: cur.width,
    }
    setInteractionMode('resizing')
    try {
      captureEl.setPointerCapture(event.pointerId)
    } catch {
      // 忽略
    }
  }, [])

  const computePointerVelocity = useCallback((samples: VelocitySample[], now: number): { vx: number; vy: number } => {
    if (samples.length < 2) return { vx: 0, vy: 0 }
    const latest = samples[samples.length - 1]
    if (now - latest.t > 90) return { vx: 0, vy: 0 }
    let anchor = samples[0]
    for (let i = samples.length - 2; i >= 0; i -= 1) {
      anchor = samples[i]
      if (latest.t - anchor.t >= 28) break
    }
    const dt = latest.t - anchor.t
    if (dt < 8) return { vx: 0, vy: 0 }
    return {
      vx: (latest.x - anchor.x) / dt,
      vy: (latest.y - anchor.y) / dt,
    }
  }, [])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = interactionRef.current
    if (!session || session.pointerId !== event.pointerId) return

    const dx = event.clientX - session.startClientX
    const dy = event.clientY - session.startClientY

    if (session.kind === 'move') {
      if (!session.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      const now = performance.now()

      // 滚动采样最近 85ms 轨迹，供速度微倾与松手惯性抛射使用
      session.velocitySamples.push({ x: event.clientX, y: event.clientY, t: now })
      while (session.velocitySamples.length > 6 || (session.velocitySamples.length > 2 && now - session.velocitySamples[0].t > 85)) {
        session.velocitySamples.shift()
      }

      if (!session.moved) {
        session.moved = true
        // 收起态按住顶耳：只要向上拉即优先进入卷帘展开，横向或向下拖则自由移动音频条
        if (session.earPullMode === 'undecided') {
          session.earPullMode = dy < 0 && Math.abs(dy) >= Math.abs(dx) * 0.65 ? 'expand' : 'move'
        }
        setInteractionMode(session.earPullMode === 'expand' ? 'curtain' : 'dragging')
      }

      const b = boundsRef.current
      const w = session.startWidth
      const minLeft = FLOATING_VIDEO_EDGE_MARGIN

      // 分支 1：收起态顶耳向上优先拉开为 16:9 视频；支持斜拉跟随横移，拉满瞬间无缝交接给 360° 全向自由拖框
      if (session.earPullMode === 'expand') {
        const rawStageH = COLLAPSED_STAGE_HEIGHT - dy
        const nextStageH = Math.max(COLLAPSED_STAGE_HEIGHT, Math.min(session.fullHeight, Math.round(rawStageH)))
        session.currentStageHeight = nextStageH

        const nextDisplayW = displayWidthFor(w, false, nextStageH)
        const maxLeftForW = Math.max(minLeft, b.width - nextDisplayW - FLOATING_VIDEO_EDGE_MARGIN)
        const anchoredLeft = session.startDockX === 'right'
          ? session.anchorRight - nextDisplayW
          : session.startLeft
        // 14px 内轻抖保持停靠边纹丝不动，超出 14px 即允许斜拉顺滑横移
        const horizDrag = Math.abs(dx) > 14 ? dx - Math.sign(dx) * 14 : 0
        const rawLeft = anchoredLeft + horizDrag
        const nextLeft = Math.max(minLeft, Math.min(maxLeftForW, Math.round(rawLeft)))

        const nextTotal = Math.max(COLLAPSED_BAR_HEIGHT, nextStageH + FRAME_BORDER_PX)
        const maxTop = Math.max(FLOATING_VIDEO_EDGE_MARGIN, b.height - nextTotal - b.bottomClearance)
        const rawTop = session.anchorBottom - nextTotal
        const nextTop = Math.max(FLOATING_VIDEO_EDGE_MARGIN, Math.min(maxTop, Math.round(rawTop)))

        // 一旦拉满完整 16:9 画面，无缝升级为已展开态自由拖拽，此后上下左右完全自由横移与触底收起
        if (rawStageH >= session.fullHeight) {
          session.earPullMode = 'move'
          session.startExpanded = true
          session.startLeft = nextLeft
          session.startTop = nextTop
          session.startClientX = event.clientX
          session.startClientY = event.clientY
          session.currentStageHeight = session.fullHeight
          session.collapseEnteredAt = null
          videoExpandedRef.current = true
          setVideoExpanded(true)
          applyPhysicsStyle(0, 0)
          scheduleMoveFrame({ left: nextLeft, top: nextTop, curtain: null, mode: 'dragging' })
          return
        }

        const ox = rawLeft < minLeft
          ? rubberBandOffset(rawLeft - minLeft, RUBBER_BAND_MAX_X)
          : rawLeft > maxLeftForW
            ? rubberBandOffset(rawLeft - maxLeftForW, RUBBER_BAND_MAX_X)
            : 0
        applyPhysicsStyle(ox, 0)
        scheduleMoveFrame({ left: nextLeft, top: nextTop, curtain: nextStageH, mode: 'curtain' })
        return
      }

      // 分支 2：展开态下 360° 自由拖拽整窗；底边触底后继续往下拉，超额下拉量一比一压扁收起为小巧音频条
      if (session.startExpanded && canExpandVideo) {
        const fullTotal = currentTotalHeight(w, true, null)
        const bottomEdge = b.height - b.bottomClearance
        const maxTopFull = Math.max(FLOATING_VIDEO_EDGE_MARGIN, bottomEdge - fullTotal)
        const rawTop = session.startTop + dy

        if (rawTop > maxTopFull) {
          const overshoot = rawTop - maxTopFull
          const nextStageH = Math.max(
            COLLAPSED_STAGE_HEIGHT,
            Math.min(session.fullHeight, Math.round(session.fullHeight - overshoot)),
          )
          if (session.collapseEnteredAt === null) {
            session.collapseEnteredAt = now
          }
          session.currentStageHeight = nextStageH
          const nextDisplayW = displayWidthFor(w, true, nextStageH)
          const maxLeftForW = Math.max(minLeft, b.width - nextDisplayW - FLOATING_VIDEO_EDGE_MARGIN)
          const widthShrink = w - nextDisplayW
          const rawLeft = session.startLeft + dx + (session.startDockX === 'right' ? widthShrink : 0)
          const nextLeft = Math.max(minLeft, Math.min(maxLeftForW, Math.round(rawLeft)))
          const nextTotal = Math.max(COLLAPSED_BAR_HEIGHT, nextStageH + FRAME_BORDER_PX)
          const nextTop = Math.max(FLOATING_VIDEO_EDGE_MARGIN, Math.round(bottomEdge - nextTotal))
          const ox = rawLeft < minLeft
            ? rubberBandOffset(rawLeft - minLeft, RUBBER_BAND_MAX_X)
            : rawLeft > maxLeftForW
              ? rubberBandOffset(rawLeft - maxLeftForW, RUBBER_BAND_MAX_X)
              : 0
          applyPhysicsStyle(ox, 0)
          scheduleMoveFrame({ left: nextLeft, top: nextTop, curtain: nextStageH, mode: 'curtain' })
          return
        }

        // 未触底，或从触底压扁中向上回推恢复满高
        let nextMode: 'dragging' | undefined
        let nextCurtain: number | null | 'keep' = 'keep'
        if (session.currentStageHeight !== session.fullHeight) {
          session.currentStageHeight = session.fullHeight
          session.collapseEnteredAt = null
          nextCurtain = null
          nextMode = 'dragging'
        }
        const maxLeft = Math.max(minLeft, b.width - w - FLOATING_VIDEO_EDGE_MARGIN)
        const rawLeft = session.startLeft + dx
        const nextLeft = Math.max(minLeft, Math.min(maxLeft, Math.round(rawLeft)))
        const nextTop = Math.max(FLOATING_VIDEO_EDGE_MARGIN, Math.round(rawTop))
        const ox = rawLeft < minLeft
          ? rubberBandOffset(rawLeft - minLeft, RUBBER_BAND_MAX_X)
          : rawLeft > maxLeft
            ? rubberBandOffset(rawLeft - maxLeft, RUBBER_BAND_MAX_X)
            : 0
        const oy = rawTop < FLOATING_VIDEO_EDGE_MARGIN
          ? rubberBandOffset(rawTop - FLOATING_VIDEO_EDGE_MARGIN, RUBBER_BAND_MAX_TOP)
          : 0
        applyPhysicsStyle(ox, oy)
        scheduleMoveFrame({ left: nextLeft, top: nextTop, curtain: nextCurtain, mode: nextMode })
        return
      }

      // 分支 3：收起态音频进度条 / 纯音频：360° 自由平移 + 严格封顶的边缘弹性
      const displayW = session.startDisplayWidth
      const extra = extraHeightForClamping(w, false, null)
      const rawLeft = session.startLeft + dx
      const rawTop = session.startTop + dy
      const clamped = clampVideoPosition(rawLeft, rawTop, displayW, b, extra)
      const ox = rawLeft !== clamped.left
        ? rubberBandOffset(rawLeft - clamped.left, RUBBER_BAND_MAX_X)
        : 0
      const oy = rawTop < clamped.top
        ? rubberBandOffset(rawTop - clamped.top, RUBBER_BAND_MAX_TOP)
        : rawTop > clamped.top
          ? rubberBandOffset(rawTop - clamped.top, RUBBER_BAND_MAX_BOTTOM)
          : 0
      applyPhysicsStyle(ox, oy)
      scheduleMoveFrame({ left: clamped.left, top: clamped.top, curtain: 'keep' })
      return
    }

    const extra = extraHeightForClamping(session.startWidth, videoExpandedRef.current, null)
    const resized = computeResizedFloatingRect({
      corner: session.corner,
      startLeft: session.startLeft,
      startTop: session.startTop,
      startWidth: session.startWidth,
      deltaX: dx,
      deltaY: dy,
      bounds: boundsRef.current,
      extraHeight: extra,
    })
    scheduleMoveFrame({ left: resized.left, top: resized.top, width: resized.width, curtain: 'keep' })
  }, [applyPhysicsStyle, canExpandVideo, currentTotalHeight, displayWidthFor, extraHeightForClamping, scheduleMoveFrame])

  const finishInteraction = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = interactionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    interactionRef.current = null
    try {
      if (session.captureEl.hasPointerCapture(event.pointerId)) {
        session.captureEl.releasePointerCapture(event.pointerId)
      }
    } catch {
      // 忽略
    }

    // 在结算最终落点前先刷掉待执行的 rAF 帧并复位橡皮筋与微倾，确保松手弹簧丝滑过渡
    const pendingFrame = pendingMoveFrameRef.current
    cancelPendingMoveFrame()
    resetPhysicsStyle()
    setInteractionMode('idle')

    const liveCur: FloatingVideoState = pendingFrame
      ? {
        ...floatingStateRef.current,
        width: pendingFrame.width ?? floatingStateRef.current.width,
        left: pendingFrame.left,
        top: pendingFrame.top,
      }
      : floatingStateRef.current

    if (session.kind === 'move') {
      if (!session.moved) {
        // 轻点顶耳：在线模式切换工具栏，本地视频直接一键平滑切换展开/收起
        if (session.fromEar) {
          if (isEmbedMode) {
            setEmbedBarOpen(prev => !prev)
          } else if (isLocalVideo) {
            setExpandedAnchored(!session.startExpanded)
          }
        }
        return
      }

      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 60)

      const cur = liveCur
      const b = boundsRef.current
      const now = performance.now()
      const { vx, vy } = computePointerVelocity(session.velocitySamples, now)
      // 苹果风甩手惯性预测：轻甩顺势滑翔至目标边，慢拖精准停在松手处
      const throwX = Math.abs(vx) > 0.22 ? Math.max(-240, Math.min(240, Math.round(vx * 150))) : 0
      const throwY = Math.abs(vy) > 0.22 ? Math.max(-180, Math.min(180, Math.round(vy * 125))) : 0

      // 分支 1：收起态顶耳上拉展开结算
      if (session.earPullMode === 'expand') {
        const span = Math.max(1, session.fullHeight - COLLAPSED_STAGE_HEIGHT)
        const ratio = (session.currentStageHeight - COLLAPSED_STAGE_HEIGHT) / span
        const expandDelta = session.currentStageHeight - COLLAPSED_STAGE_HEIGHT
        const elapsed = Math.max(16, now - session.startTime)
        const expandVelocity = expandDelta / elapsed
        const shouldExpand = ratio >= 0.25 || (expandDelta >= 14 && expandVelocity >= 0.32)

        setCurtainHeight(null)

        if (shouldExpand) {
          const extraFull = extraHeightForClamping(cur.width, true, null)
          const fullTotal = currentTotalHeight(cur.width, true, null)
          const targetTop = Math.min(cur.top, session.anchorBottom - fullTotal)
          const dxFromStart = event.clientX - session.startClientX
          const baseLeft = Math.abs(dxFromStart) > 14
            ? cur.left + throwX
            : (session.startDockX === 'right' ? session.anchorRight - cur.width : session.startLeft)
          const snapped = snapVideoPosition(baseLeft, targetTop, cur.width, b, extraFull)
          setVideoExpanded(true)
          const next: FloatingVideoState = {
            width: cur.width,
            left: snapped.left,
            top: snapped.top,
            dockX: snapped.dockX,
          }
          setFloating(next)
          persistFloatingLayout(next, b, extraFull)
          announce('已展开视频画面')
          return
        }

        // 未拉到位：轻柔回落为原位音频条
        const extraCollapsed = extraHeightForClamping(cur.width, false, null)
        const collapsedW = displayWidthFor(cur.width, false, null)
        const snapped = snapVideoPosition(session.startLeft, session.startTop, collapsedW, b, extraCollapsed)
        const next: FloatingVideoState = {
          width: cur.width,
          left: snapped.left,
          top: snapped.top,
          dockX: snapped.dockX,
        }
        setFloating(next)
        persistFloatingLayout(next, b, extraCollapsed)
        return
      }

      // 分支 2：展开态触底续拉压扁判定：达标即吸附收起到底部小巧音频条，未达标回弹满高并正常贴边磁吸
      if (session.startExpanded && canExpandVideo && session.currentStageHeight < session.fullHeight) {
        const span = Math.max(1, session.fullHeight - COLLAPSED_STAGE_HEIGHT)
        const ratio = (session.currentStageHeight - COLLAPSED_STAGE_HEIGHT) / span
        const collapseDelta = session.fullHeight - session.currentStageHeight
        const collapseElapsed = Math.max(16, now - (session.collapseEnteredAt ?? session.startTime))
        const collapseVelocity = collapseDelta / collapseElapsed
        const shouldCollapse = ratio <= 0.68 || (collapseDelta >= 16 && collapseVelocity >= 0.4)

        setCurtainHeight(null)

        if (shouldCollapse) {
          if (isEmbedMode) {
            onClose()
            announce('在线视频小窗已收起')
            return
          }
          const collapsedW = displayWidthFor(cur.width, false, null)
          const extraCollapsed = extraHeightForClamping(cur.width, false, null)
          const bottomTop = Math.max(FLOATING_VIDEO_EDGE_MARGIN, b.height - b.bottomClearance - COLLAPSED_BAR_HEIGHT)
          const snapped = snapVideoPosition(cur.left + throwX, bottomTop, collapsedW, b, extraCollapsed)
          setVideoExpanded(false)
          const next: FloatingVideoState = {
            width: cur.width,
            left: snapped.left,
            top: snapped.top,
            dockX: snapped.dockX,
          }
          setFloating(next)
          persistFloatingLayout(next, b, extraCollapsed)
          announce('已收起为音频进度条')
          return
        }

        // 未达收起阈值：弹性回弹保持展开，同时吸附左右边
        const extraFull = extraHeightForClamping(cur.width, true, null)
        const maxTopFull = Math.max(
          FLOATING_VIDEO_EDGE_MARGIN,
          b.height - b.bottomClearance - currentTotalHeight(cur.width, true, null),
        )
        const snapped = snapVideoPosition(cur.left + throwX, maxTopFull, cur.width, b, extraFull)
        const next: FloatingVideoState = {
          width: cur.width,
          left: snapped.left,
          top: snapped.top,
          dockX: snapped.dockX,
        }
        setFloating(next)
        persistFloatingLayout(next, b, extraFull)
        announce(`播放器已吸附至${snapped.label}`)
        return
      }

      // 分支 3：常规整窗平移松手：惯性抛射 + 弹簧磁吸贴左 / 贴右
      const exp = videoExpandedRef.current
      const displayW = displayWidthFor(cur.width, exp, null)
      const extra = extraHeightForClamping(cur.width, exp, null)
      const snapped = snapVideoPosition(cur.left + throwX, cur.top + throwY, displayW, b, extra)
      const next: FloatingVideoState = {
        width: cur.width,
        left: snapped.left,
        top: snapped.top,
        dockX: snapped.dockX,
      }
      setFloating(next)
      persistFloatingLayout(next, b, extra)
      announce(`播放器已吸附至${snapped.label}`)
      return
    }

    // 缩放结束磁吸
    const cur = liveCur
    const extra = extraHeightForClamping(cur.width, videoExpandedRef.current, null)
    const snapped = snapVideoPosition(cur.left, cur.top, cur.width, boundsRef.current, extra)
    const next: FloatingVideoState = {
      width: cur.width,
      left: snapped.left,
      top: snapped.top,
      dockX: snapped.dockX,
    }
    setFloating(next)
    persistFloatingLayout(next, boundsRef.current, extra)
    announce('播放器尺寸已更新')
  }, [announce, canExpandVideo, cancelPendingMoveFrame, computePointerVelocity, currentTotalHeight, displayWidthFor, extraHeightForClamping, isEmbedMode, isLocalVideo, onClose, resetPhysicsStyle, setExpandedAnchored])

  const handleEarKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      if (isLocalVideo) {
        event.preventDefault()
        setExpandedAnchored(!videoExpandedRef.current)
      }
      return
    }
    let dx = 0
    let dy = 0
    if (event.key === 'ArrowLeft') dx = -KEYBOARD_STEP_PX
    else if (event.key === 'ArrowRight') dx = KEYBOARD_STEP_PX
    else if (event.key === 'ArrowUp') dy = -KEYBOARD_STEP_PX
    else if (event.key === 'ArrowDown') dy = KEYBOARD_STEP_PX
    else return

    event.preventDefault()
    const cur = floatingStateRef.current
    const exp = videoExpandedRef.current
    const displayW = displayWidthFor(cur.width, exp, null)
    const extra = extraHeightForClamping(cur.width, exp, null)
    const clamped = clampVideoPosition(cur.left + dx, cur.top + dy, displayW, boundsRef.current, extra)
    const nextDock = clamped.left + displayW / 2 <= boundsRef.current.width / 2 ? 'left' : 'right'
    const next: FloatingVideoState = { ...cur, left: clamped.left, top: clamped.top, dockX: nextDock }
    setFloating(next)
    persistFloatingLayout(next, boundsRef.current, extra)
    announce(dx < 0 ? '播放器向左移动' : dx > 0 ? '播放器向右移动' : dy < 0 ? '播放器向上移动' : '播放器向下移动')
  }, [announce, displayWidthFor, extraHeightForClamping, isLocalVideo, setExpandedAnchored])

  const resetFloatingLayout = useCallback(() => {
    const exp = videoExpandedRef.current
    const b = boundsRef.current
    const defaultVideo = createDefaultFloatingState(b, undefined, 0)
    const displayW = displayWidthFor(defaultVideo.width, exp, null)
    const totalH = currentTotalHeight(defaultVideo.width, exp, null)
    const next: FloatingVideoState = {
      width: defaultVideo.width,
      left: Math.max(FLOATING_VIDEO_EDGE_MARGIN, b.width - displayW - FLOATING_VIDEO_EDGE_MARGIN),
      top: Math.max(FLOATING_VIDEO_EDGE_MARGIN, b.height - totalH - b.bottomClearance),
      dockX: 'right',
    }
    setFloating(next)
    persistFloatingLayout(next, b, extraHeightForClamping(next.width, exp, null))
    announce('播放器已复位至右下角')
  }, [announce, currentTotalHeight, displayWidthFor, extraHeightForClamping])

  const hasTranscriptCaptions = transcriptSegments.length > 0
  const canToggleCaptions = hasTranscriptCaptions || onlineEmbed?.provider === 'youtube'

  const baseSegmentIndex = useMemo(
    () => findSegmentIndexForTime(transcriptSegments, currentTime),
    [transcriptSegments, currentTime],
  )
  const displaySegmentIndex = useMemo(() => {
    if (!hasTranscriptCaptions) return -1
    const base = baseSegmentIndex >= 0 ? baseSegmentIndex : 0
    if (!isEmbedMode) return baseSegmentIndex
    return Math.max(0, Math.min(transcriptSegments.length - 1, base + embedCaptionOffset))
  }, [hasTranscriptCaptions, baseSegmentIndex, isEmbedMode, embedCaptionOffset, transcriptSegments.length])

  const activeCaptionSegment = displaySegmentIndex >= 0 ? transcriptSegments[displaySegmentIndex] : null
  const activeCaptionText = (activeCaptionSegment?.text || '').trim()

  const embedIframeSrc = useMemo(() => {
    if (!isEmbedMode || !onlineEmbed) return ''
    return onlineEmbed.buildEmbedUrl({
      startSeconds: embedStartTime,
      autoPlay: embedAutoPlay,
      captions: captionsEnabled,
    })
  }, [isEmbedMode, onlineEmbed, embedStartTime, embedAutoPlay, captionsEnabled])

  const sizeLimits = useMemo(() => computeVideoSizeLimits(bounds), [bounds])
  const currentHeight = videoHeightForWidth(floating.width)
  const resizeLimitLabel =
    floating.width <= sizeLimits.minWidth
      ? '最小'
      : floating.width >= sizeLimits.maxWidth
        ? '最大'
        : ''

  if (!open) return null

  const effectiveDuration = Math.max(duration, currentTime, durationHint || 0, 1)
  const progressPercent = Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100))
  const isShowingVideo = isEmbedMode || activeStageHeight > COLLAPSED_STAGE_HEIGHT + 12
  const isCollapsedAudioBar = !isEmbedMode && !isShowingVideo
  const showCollapsedTopCaption = isCollapsedAudioBar && interactionMode !== 'curtain' && captionsEnabled && Boolean(activeCaptionText)
  const renderedWidth = displayWidthFor(floating.width, videoExpanded, curtainHeight)

  const floatingStyle: CSSProperties = {
    width: `${renderedWidth}px`,
    left: `${floating.left}px`,
    top: `${floating.top}px`,
  }

  const stageStyle: CSSProperties | undefined = !isEmbedMode
    ? { height: `${activeStageHeight}px` }
    : undefined

  const resizeCorners: Array<{ corner: ResizeCorner; label: string }> = [
    { corner: 'nw', label: '拖拽左上角调整尺寸' },
    { corner: 'ne', label: '拖拽右上角调整尺寸' },
    { corner: 'sw', label: '拖拽左下角调整尺寸' },
    { corner: 'se', label: '拖拽右下角调整尺寸' },
  ]

  return (
    <>
      <div className="sr-only" aria-live="polite">
        {liveAnnouncement}
      </div>

      {/* 单一连续形变悬浮播放器：默认收起为音频进度条，上拉/点击顶耳原位卷展为 16:9 视频，下拉/点击顶耳原位卷收回音频条 */}
      <div
        ref={floatingRef}
        className={[
          'apple-pip-window',
          isCollapsedAudioBar ? 'is-audio-bar' : 'is-video-open',
          interactionMode !== 'idle' ? 'is-interacting' : '',
          interactionMode === 'dragging' ? 'is-dragging' : '',
          interactionMode === 'curtain' ? 'is-curtaining' : '',
          isEmbedMode ? 'is-embed' : '',
          isEmbedMode && embedBarOpen ? 'is-embed-bar-open' : '',
        ].filter(Boolean).join(' ')}
        style={floatingStyle}
        role="region"
        aria-label={isEmbedMode && onlineEmbed ? `${onlineEmbed.label}悬浮视频` : isCollapsedAudioBar ? '迷你音频进度条' : '画中画视频播放器'}
        onPointerMove={handlePointerMove}
        onPointerUp={finishInteraction}
        onPointerCancel={finishInteraction}
        onLostPointerCapture={finishInteraction}
      >
        {/* 收起态音频进度条开启字幕时，默认浮于顶耳正上方；贴近阅读区顶边时自动翻转到底座下方防裁切 */}
        {showCollapsedTopCaption && (
          <div className={`apple-pip-top-caption ${floating.top < 46 ? 'is-below' : ''}`} aria-live="polite">
            <span>{activeCaptionText}</span>
          </div>
        )}

        {/* 一体化极薄顶耳：全向拖动整窗，视频态触底后继续下拉压扁收起，轻点一键切换展开/收起 */}
        <div
          className="apple-pip-ear-wrap"
          onMouseEnter={isEmbedMode ? () => setEmbedBarOpen(true) : undefined}
          onMouseLeave={isEmbedMode ? () => { if (interactionMode === 'idle') setEmbedBarOpen(false) } : undefined}
        >
          <button
            type="button"
            className={`apple-pip-ear-handle ${interactionMode === 'curtain' ? 'is-curtaining' : ''}`}
            aria-label={
              isEmbedMode
                ? '拖动移动位置，触底继续下拉关闭在线视频，点击展开工具栏'
                : isLocalVideo
                  ? (videoExpanded ? '拖动移动位置，触底继续下拉或点击收起为音频进度条' : '向上拉或点击展开视频，左右拖动移动位置')
                  : '拖动音频进度条，支持方向键移动'
            }
            title={
              isEmbedMode
                ? '拖动移动 · 触底继续下拉收起 · 点击工具栏'
                : isLocalVideo
                  ? (videoExpanded ? '拖动移动 · 触底继续下拉或点击收起' : '往上拉或点击展开视频 · 横拖移动')
                  : '拖动移动位置 · 双击复位'
            }
            onPointerDown={startEarDrag}
            onDoubleClick={resetFloatingLayout}
            onKeyDown={handleEarKeyDown}
          >
            <svg
              className="apple-pip-ear-shape"
              viewBox="0 0 56 8"
              width="56"
              height="8"
              aria-hidden="true"
            >
              <path
                className="apple-pip-ear-fill"
                d="M 0,8 L 0,7.5 C 5.5,7.5 8,6.5 10.5,3.4 C 12.2,1.3 14.5,0.5 18,0.5 L 38,0.5 C 41.5,0.5 43.8,1.3 45.5,3.4 C 48,6.5 50.5,7.5 56,7.5 L 56,8 Z"
              />
              <path
                className="apple-pip-ear-stroke"
                d="M 0,7.5 C 5.5,7.5 8,6.5 10.5,3.4 C 12.2,1.3 14.5,0.5 18,0.5 L 38,0.5 C 41.5,0.5 43.8,1.3 45.5,3.4 C 48,6.5 50.5,7.5 56,7.5"
              />
              <rect
                className="apple-pip-ear-grip"
                x="19"
                y="3.6"
                width="18"
                height="1.4"
                rx="0.7"
              />
            </svg>
          </button>
        </div>

        {/* 统一外框主体（11px 干练圆角，音频条与视频窗共用同一物理画框与底座） */}
        <div
          className="apple-pip-frame"
          onPointerDown={!isEmbedMode ? startBodyMove : undefined}
        >
          {/* 纯音频底层元素（无视频源时使用） */}
          {!synthetic && !isLocalVideo && !isEmbedMode && src && (
            <audio
              ref={audioRef}
              src={src}
              preload="metadata"
              onLoadedMetadata={(event) => {
                const d = event.currentTarget.duration
                if (Number.isFinite(d) && d > 0) setDuration(d)
              }}
              onTimeUpdate={(event) => {
                const t = event.currentTarget.currentTime
                setCurrentTime(t)
                onTimeUpdateRef.current?.(t)
              }}
              onPlay={() => {
                setPlaying(true)
                onPlayingChangeRef.current?.(true)
              }}
              onPause={() => {
                setPlaying(false)
                onPlayingChangeRef.current?.(false)
              }}
              onEnded={() => {
                setPlaying(false)
                onPlayingChangeRef.current?.(false)
              }}
              onError={() => {
                setPlaying(false)
                onPlayingChangeRef.current?.(false)
                onUnavailableRef.current?.()
              }}
            />
          )}

          {/* 在线嵌入模式：悬停顶耳滑出极薄工具栏 */}
          {isEmbedMode && onlineEmbed && (
            <div
              className="apple-pip-embed-drawer"
              onMouseEnter={() => setEmbedBarOpen(true)}
              onMouseLeave={() => { if (interactionMode === 'idle') setEmbedBarOpen(false) }}
            >
              <div className="apple-pip-embed-bar">
                <button
                  type="button"
                  className={`apple-pip-embed-drag ${interactionMode === 'dragging' ? 'is-dragging' : ''}`}
                  aria-label="拖动在线视频小窗，支持方向键移动"
                  onPointerDown={startBodyMove}
                  onDoubleClick={resetFloatingLayout}
                  onKeyDown={handleEarKeyDown}
                >
                  <span>{onlineEmbed.label}</span>
                  <span className="apple-pip-mono">{formatMediaTime(embedStartTime)}</span>
                </button>
                <div className="apple-pip-island-group">
                  {canToggleCaptions && (
                    <button
                      type="button"
                      className={`apple-pip-icon ${captionsEnabled ? 'is-active' : ''}`}
                      aria-label={captionsEnabled ? '关闭字幕' : '开启字幕'}
                      aria-pressed={captionsEnabled}
                      title={captionsEnabled ? '关闭字幕' : '开启字幕'}
                      onClick={toggleCaptions}
                    >
                      <Captions size={12} strokeWidth={1.85} aria-hidden="true" />
                    </button>
                  )}
                  {externalUrl && (
                    <a
                      href={externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="apple-pip-icon"
                      aria-label="去原站看高清"
                      title="去原站看高清"
                    >
                      <ExternalLink size={11.5} strokeWidth={1.8} aria-hidden="true" />
                    </a>
                  )}
                  <button
                    type="button"
                    className="apple-pip-icon"
                    aria-label="关闭视频画中画"
                    title="关闭"
                    onClick={onClose}
                  >
                    <HairlineCloseIcon size={11} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 卷帘式 16:9 视频画面区（收起态平滑收拢至 45px 音频底座，全程零布局切换跳动，同时保留 <video> 持续发声） */}
          <div className="apple-pip-stage" style={stageStyle}>
            {canExpandVideo && (
              <>
                {isEmbedMode && onlineEmbed ? (
                  <iframe
                    key={`${onlineEmbed.provider}:${onlineEmbed.videoId}:${embedNonce}:${onlineEmbed.provider === 'youtube' ? Number(captionsEnabled) : 0}`}
                    src={embedIframeSrc}
                    title={`${onlineEmbed.label}视频播放`}
                    className="apple-pip-media"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                ) : !synthetic && src ? (
                  <video
                    ref={videoRef}
                    src={src}
                    width={640}
                    height={360}
                    playsInline
                    preload="metadata"
                    className={`apple-pip-media ${isCollapsedAudioBar ? 'is-hidden-visual' : ''}`}
                    onClick={togglePlay}
                    onLoadedMetadata={(event) => {
                      const d = event.currentTarget.duration
                      if (Number.isFinite(d) && d > 0) setDuration(d)
                    }}
                    onTimeUpdate={(event) => {
                      const t = event.currentTarget.currentTime
                      setCurrentTime(t)
                      onTimeUpdateRef.current?.(t)
                    }}
                    onPlay={() => {
                      setPlaying(true)
                      onPlayingChangeRef.current?.(true)
                    }}
                    onPause={() => {
                      setPlaying(false)
                      onPlayingChangeRef.current?.(false)
                    }}
                    onEnded={() => {
                      setPlaying(false)
                      onPlayingChangeRef.current?.(false)
                    }}
                    onError={() => {
                      setPlaying(false)
                      onPlayingChangeRef.current?.(false)
                      onUnavailableRef.current?.()
                    }}
                  />
                ) : (
                  <div className={`apple-pip-cinema-canvas ${isCollapsedAudioBar ? 'is-hidden-visual' : ''}`} onClick={togglePlay}>
                    <div className="apple-pip-cinema-glow" aria-hidden="true" />
                    <div className="apple-pip-cinema-vignette" aria-hidden="true" />
                    <span className="apple-pip-cinema-stamp" aria-hidden="true">
                      {formatMediaTime(currentTime)}
                    </span>
                  </div>
                )}

                {/* 视频展开态左上角极轻缩小版关闭钮（平时隐身，悬停浮现） */}
                {isLocalVideo && isShowingVideo && (
                  <div className="apple-pip-stage-top">
                    <button
                      type="button"
                      className="apple-pip-close-dot"
                      aria-label="关闭播放器"
                      title="关闭"
                      onClick={onClose}
                    >
                      <HairlineCloseIcon size={10.5} />
                    </button>
                  </div>
                )}

                {interactionMode !== 'idle' && <div className="apple-pip-shield" aria-hidden="true" />}

                {interactionMode === 'resizing' && (
                  <div className="apple-pip-size-hud" aria-hidden="true">
                    {floating.width} × {currentHeight}
                    {resizeLimitLabel ? ` · ${resizeLimitLabel}` : ''}
                  </div>
                )}

                {/* 视频展开态底部实时字幕 */}
                {!isEmbedMode && isShowingVideo && captionsEnabled && activeCaptionText && (
                  <div className="apple-pip-caption" aria-live="polite">
                    <span>{activeCaptionText}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 统一融合控制底座：收起态常驻为精简音频进度条；视频展开态自动融入画面底边悬停浮现 */}
          {!isEmbedMode && (
            <div className={`apple-pip-dock-base ${isCollapsedAudioBar ? 'is-standalone' : 'is-overlay'}`}>
              <div className="apple-scrubber apple-scrubber--dock" style={{ '--scrubber-pct': `${progressPercent.toFixed(2)}%` } as CSSProperties}>
                <div className="apple-scrubber-track" aria-hidden="true">
                  <div className="apple-scrubber-fill" />
                  <div className="apple-scrubber-thumb" />
                </div>
                <input
                  type="range"
                  className="apple-scrubber-input"
                  aria-label="播放进度"
                  min={0}
                  max={Math.round(effectiveDuration)}
                  step={1}
                  value={Math.min(Math.round(effectiveDuration), Math.round(currentTime))}
                  onChange={event => seekTo(Number(event.target.value))}
                />
              </div>

              <div className="apple-pip-dock-controls">
                <div className="apple-pip-dock-left">
                  <span className="apple-pip-time">
                    {formatMediaTime(currentTime)}
                    <span className="apple-pip-time-sep">/</span>
                    <span className="apple-pip-time-total">{formatMediaTime(effectiveDuration)}</span>
                  </span>
                </div>

                <div className="apple-pip-dock-center">
                  <button
                    type="button"
                    className="apple-pip-dock-btn"
                    aria-label="后退 5 秒"
                    title="后退 5 秒"
                    onClick={() => seekTo(currentTime - 5)}
                  >
                    <RotateCcw size={10.5} strokeWidth={1.65} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="apple-pip-dock-btn apple-pip-dock-btn--play"
                    aria-label={playing ? '暂停播放' : '开始播放'}
                    title={playing ? '暂停' : '播放'}
                    onClick={togglePlay}
                  >
                    {playing ? (
                      <Pause size={11} strokeWidth={1.8} fill="currentColor" aria-hidden="true" />
                    ) : (
                      <Play size={11} strokeWidth={1.8} fill="currentColor" className="translate-x-[0.5px]" aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="apple-pip-dock-btn"
                    aria-label="前进 5 秒"
                    title="前进 5 秒"
                    onClick={() => seekTo(currentTime + 5)}
                  >
                    <RotateCw size={10.5} strokeWidth={1.65} aria-hidden="true" />
                  </button>
                </div>

                <div className="apple-pip-dock-right">
                  {canToggleCaptions && (
                    <button
                      type="button"
                      className={`apple-pip-dock-btn ${captionsEnabled ? 'is-active' : ''}`}
                      aria-label={captionsEnabled ? '关闭字幕' : '开启字幕'}
                      aria-pressed={captionsEnabled}
                      title={captionsEnabled ? '关闭字幕' : '开启字幕'}
                      onClick={toggleCaptions}
                    >
                      <Captions size={11} strokeWidth={1.65} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="apple-pip-rate-btn"
                    aria-label={`倍速 ${playbackRate}x，点击切换`}
                    title="切换倍速"
                    onClick={() => setPlaybackRate(prev => clampPlaybackRate(nextPlaybackRate(prev)))}
                  >
                    {playbackRate}x
                  </button>
                  <button
                    type="button"
                    className="apple-pip-dock-btn"
                    aria-label={muted ? '取消静音' : '静音'}
                    title={muted ? '取消静音' : '静音'}
                    onClick={() => setMuted(prev => !prev)}
                  >
                    {muted ? <VolumeX size={10.5} strokeWidth={1.65} aria-hidden="true" /> : <Volume2 size={10.5} strokeWidth={1.65} aria-hidden="true" />}
                  </button>
                  {!synthetic && supportsPiP && isShowingVideo && (
                    <button
                      type="button"
                      className="apple-pip-dock-btn"
                      aria-label="系统画中画"
                      title="系统画中画（PiP）"
                      onClick={() => void togglePictureInPicture()}
                    >
                      <PictureInPicture2 size={10.5} strokeWidth={1.65} aria-hidden="true" />
                    </button>
                  )}
                  {isCollapsedAudioBar && (
                    <button
                      type="button"
                      className="apple-pip-dock-btn apple-pip-dock-btn--close"
                      aria-label="关闭播放器"
                      title="关闭"
                      onClick={onClose}
                    >
                      <HairlineCloseIcon size={9.5} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 在线嵌入模式：可选同步转写字幕条 */}
          {isEmbedMode && captionsEnabled && hasTranscriptCaptions && (
            <div className="apple-pip-embed-caption" role="status" aria-live="polite">
              <button
                type="button"
                className="apple-pip-icon"
                aria-label="上一句字幕"
                disabled={displaySegmentIndex <= 0}
                onClick={() => setEmbedCaptionOffset(prev => prev - 1)}
              >
                <ChevronLeft size={12} aria-hidden="true" />
              </button>
              <div className="apple-pip-embed-caption-copy">
                {activeCaptionSegment && (
                  <span className="apple-pip-embed-caption-time">{formatMediaTime(activeCaptionSegment.start)}</span>
                )}
                <span className="apple-pip-embed-caption-text">
                  {activeCaptionText || '当前时间点暂无对应字幕文本'}
                </span>
              </div>
              <button
                type="button"
                className="apple-pip-icon"
                aria-label="下一句字幕"
                disabled={displaySegmentIndex < 0 || displaySegmentIndex >= transcriptSegments.length - 1}
                onClick={() => setEmbedCaptionOffset(prev => prev + 1)}
              >
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </div>
          )}

          {/* 展开态四角受限等比缩放热区 */}
          {isShowingVideo && resizeCorners.map(({ corner, label }) => (
            <div
              key={corner}
              data-resize-corner={corner}
              className={`apple-pip-resize apple-pip-resize--${corner}`}
              role="presentation"
              title={`${label}（${sizeLimits.minWidth}~${sizeLimits.maxWidth}px）`}
              onPointerDown={event => startResize(corner, event)}
            />
          ))}
        </div>
      </div>
    </>
  )
}
