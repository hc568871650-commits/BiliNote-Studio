export type HorizontalDock = 'left' | 'right'
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

export interface ContainerBounds {
  width: number
  height: number
  bottomClearance: number
}

export interface FloatingVideoState {
  width: number
  left: number
  top: number
  dockX: HorizontalDock
}

export interface FloatingSizeLimits {
  minWidth: number
  maxWidth: number
}

export const FLOATING_VIDEO_MIN_WIDTH = 240
export const FLOATING_VIDEO_MAX_WIDTH = 560
export const FLOATING_VIDEO_DEFAULT_WIDTH = 360
export const FLOATING_VIDEO_EDGE_MARGIN = 14
export const FLOATING_VIDEO_VERTICAL_SNAP_THRESHOLD = 44

const LAYOUT_STORAGE_KEY = 'bilinote-video-pip-layout-v1'

export function videoHeightForWidth(width: number): number {
  return Math.round((width * 9) / 16)
}

/**
 * 计算当前容器尺寸下允许的视频宽度上下限：
 * - 不小于 240px（除非容器极窄）
 * - 不大于 560px，且不超过容器宽度的 68%、不超过容器可用高度 52% 对应的 16:9 宽度
 */
export function computeVideoSizeLimits(bounds: ContainerBounds): FloatingSizeLimits {
  const usableW = Math.max(180, bounds.width - FLOATING_VIDEO_EDGE_MARGIN * 2)
  const usableH = Math.max(120, bounds.height - FLOATING_VIDEO_EDGE_MARGIN - bounds.bottomClearance)
  const minW = Math.min(FLOATING_VIDEO_MIN_WIDTH, usableW)
  const maxByWidth = Math.floor(bounds.width * 0.68)
  const maxByHeight = Math.floor((usableH * 0.56) * (16 / 9))
  const maxW = Math.max(
    minW,
    Math.min(FLOATING_VIDEO_MAX_WIDTH, usableW, maxByWidth, maxByHeight),
  )
  return { minWidth: minW, maxWidth: maxW }
}

export function clampVideoWidth(width: number, bounds: ContainerBounds): number {
  const { minWidth, maxWidth } = computeVideoSizeLimits(bounds)
  if (!Number.isFinite(width)) return Math.min(maxWidth, Math.max(minWidth, FLOATING_VIDEO_DEFAULT_WIDTH))
  return Math.round(Math.max(minWidth, Math.min(maxWidth, width)))
}

export function clampVideoPosition(
  left: number,
  top: number,
  width: number,
  bounds: ContainerBounds,
  extraHeight = 0,
): { left: number; top: number } {
  const height = videoHeightForWidth(width) + extraHeight
  const minLeft = FLOATING_VIDEO_EDGE_MARGIN
  const maxLeft = Math.max(minLeft, bounds.width - width - FLOATING_VIDEO_EDGE_MARGIN)
  const minTop = FLOATING_VIDEO_EDGE_MARGIN
  const maxTop = Math.max(minTop, bounds.height - height - bounds.bottomClearance)
  return {
    left: Math.round(Math.max(minLeft, Math.min(maxLeft, left))),
    top: Math.round(Math.max(minTop, Math.min(maxTop, top))),
  }
}

/**
 * 磁吸吸附规则（macOS PiP 风格）：
 * - 水平方向：松手后按中心点自动磁吸贴左或贴右，确保永不挡住中间正文阅读轴；
 * - 垂直方向：距顶部或底部 <= 44px 自动吸顶/吸底，否则保持用户松手高度。
 */
export function snapVideoPosition(
  left: number,
  top: number,
  width: number,
  bounds: ContainerBounds,
  extraHeight = 0,
): { left: number; top: number; dockX: HorizontalDock; label: string } {
  const height = videoHeightForWidth(width) + extraHeight
  const minLeft = FLOATING_VIDEO_EDGE_MARGIN
  const maxLeft = Math.max(minLeft, bounds.width - width - FLOATING_VIDEO_EDGE_MARGIN)
  const minTop = FLOATING_VIDEO_EDGE_MARGIN
  const maxTop = Math.max(minTop, bounds.height - height - bounds.bottomClearance)

  const clamped = clampVideoPosition(left, top, width, bounds, extraHeight)
  const centerX = clamped.left + width / 2
  const dockX: HorizontalDock = centerX <= bounds.width / 2 ? 'left' : 'right'
  const snappedLeft = dockX === 'left' ? minLeft : maxLeft

  let snappedTop = clamped.top
  let verticalZone: 'top' | 'middle' | 'bottom' = 'middle'
  if (clamped.top - minTop <= FLOATING_VIDEO_VERTICAL_SNAP_THRESHOLD) {
    snappedTop = minTop
    verticalZone = 'top'
  } else if (maxTop - clamped.top <= FLOATING_VIDEO_VERTICAL_SNAP_THRESHOLD) {
    snappedTop = maxTop
    verticalZone = 'bottom'
  }

  const labelMap: Record<`${HorizontalDock}-${'top' | 'middle' | 'bottom'}`, string> = {
    'left-top': '左上角',
    'left-middle': '左侧边缘',
    'left-bottom': '左下角',
    'right-top': '右上角',
    'right-middle': '右侧边缘',
    'right-bottom': '右下角',
  }

  return {
    left: Math.round(snappedLeft),
    top: Math.round(snappedTop),
    dockX,
    label: labelMap[`${dockX}-${verticalZone}`],
  }
}

/**
 * 根据拖拽的缩放角（nw/ne/sw/se）计算等比 16:9 缩放后的新宽度与锚点补偿位置（保持对角固定不动）。
 */
export function computeResizedFloatingRect(options: {
  corner: ResizeCorner
  startLeft: number
  startTop: number
  startWidth: number
  deltaX: number
  deltaY: number
  bounds: ContainerBounds
  extraHeight?: number
}): { width: number; left: number; top: number } {
  const extraHeight = options.extraHeight || 0
  const startHeight = videoHeightForWidth(options.startWidth)
  const horizontalSign = options.corner === 'ne' || options.corner === 'se' ? 1 : -1
  const verticalSign = options.corner === 'sw' || options.corner === 'se' ? 1 : -1

  // 取水平与垂直换算为宽度的主导增量，拖拽更跟手
  const candidateByX = options.startWidth + options.deltaX * horizontalSign
  const candidateByY = options.startWidth + (options.deltaY * verticalSign) * (16 / 9)
  const rawWidth = Math.abs(options.deltaX) >= Math.abs(options.deltaY) ? candidateByX : candidateByY
  const nextWidth = clampVideoWidth(rawWidth, options.bounds)
  const nextHeight = videoHeightForWidth(nextWidth)

  let nextLeft = options.startLeft
  let nextTop = options.startTop
  if (options.corner === 'nw' || options.corner === 'sw') {
    nextLeft = options.startLeft + (options.startWidth - nextWidth)
  }
  if (options.corner === 'nw' || options.corner === 'ne') {
    nextTop = options.startTop + (startHeight - nextHeight)
  }

  const clamped = clampVideoPosition(nextLeft, nextTop, nextWidth, options.bounds, extraHeight)
  return { width: nextWidth, left: clamped.left, top: clamped.top }
}

export function createDefaultFloatingState(
  bounds: ContainerBounds,
  preferredWidth = FLOATING_VIDEO_DEFAULT_WIDTH,
  extraHeight = 0,
): FloatingVideoState {
  const width = clampVideoWidth(preferredWidth, bounds)
  const height = videoHeightForWidth(width) + extraHeight
  const left = Math.max(FLOATING_VIDEO_EDGE_MARGIN, bounds.width - width - FLOATING_VIDEO_EDGE_MARGIN)
  const top = Math.max(FLOATING_VIDEO_EDGE_MARGIN, bounds.height - height - bounds.bottomClearance)
  return { width, left: Math.round(left), top: Math.round(top), dockX: 'right' }
}

interface PersistedFloatingLayout {
  width: number
  dockX: HorizontalDock
  topRatio: number
}

export function readPersistedFloatingLayout(): PersistedFloatingLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedFloatingLayout>
    if (
      typeof parsed.width === 'number'
      && Number.isFinite(parsed.width)
      && (parsed.dockX === 'left' || parsed.dockX === 'right')
      && typeof parsed.topRatio === 'number'
      && Number.isFinite(parsed.topRatio)
    ) {
      return {
        width: parsed.width,
        dockX: parsed.dockX,
        topRatio: Math.max(0, Math.min(1, parsed.topRatio)),
      }
    }
  } catch {
    // 忽略损坏数据
  }
  return null
}

export function persistFloatingLayout(state: FloatingVideoState, bounds: ContainerBounds, extraHeight = 0): void {
  try {
    const height = videoHeightForWidth(state.width) + extraHeight
    const minTop = FLOATING_VIDEO_EDGE_MARGIN
    const maxTop = Math.max(minTop, bounds.height - height - bounds.bottomClearance)
    const span = Math.max(1, maxTop - minTop)
    const topRatio = Math.max(0, Math.min(1, (state.top - minTop) / span))
    const payload: PersistedFloatingLayout = {
      width: state.width,
      dockX: state.dockX,
      topRatio,
    }
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 忽略受限存储
  }
}

export function restoreFloatingState(bounds: ContainerBounds, extraHeight = 0): FloatingVideoState {
  const saved = readPersistedFloatingLayout()
  if (!saved) {
    return createDefaultFloatingState(bounds, FLOATING_VIDEO_DEFAULT_WIDTH, extraHeight)
  }
  const width = clampVideoWidth(saved.width, bounds)
  const height = videoHeightForWidth(width) + extraHeight
  const minLeft = FLOATING_VIDEO_EDGE_MARGIN
  const maxLeft = Math.max(minLeft, bounds.width - width - FLOATING_VIDEO_EDGE_MARGIN)
  const minTop = FLOATING_VIDEO_EDGE_MARGIN
  const maxTop = Math.max(minTop, bounds.height - height - bounds.bottomClearance)
  const left = saved.dockX === 'left' ? minLeft : maxLeft
  const top = Math.round(minTop + saved.topRatio * (maxTop - minTop))
  return { width, left, top, dockX: saved.dockX }
}
