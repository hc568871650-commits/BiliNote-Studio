import assert from 'node:assert/strict'
import {
  clampVideoPosition,
  clampVideoWidth,
  computeResizedFloatingRect,
  computeVideoSizeLimits,
  createDefaultFloatingState,
  FLOATING_VIDEO_EDGE_MARGIN,
  FLOATING_VIDEO_MAX_WIDTH,
  FLOATING_VIDEO_MIN_WIDTH,
  snapVideoPosition,
  videoHeightForWidth,
} from '../src/utils/floatingVideoLayout.ts'

const desktopBounds = { width: 1000, height: 700, bottomClearance: 72 }
const narrowBounds = { width: 420, height: 540, bottomClearance: 72 }

// 1. 严格尺寸限制（宽屏上限 560，窄屏按 68% 容器宽动态收敛）
const desktopLimits = computeVideoSizeLimits(desktopBounds)
assert.equal(desktopLimits.minWidth, FLOATING_VIDEO_MIN_WIDTH)
assert.ok(desktopLimits.maxWidth <= FLOATING_VIDEO_MAX_WIDTH)
assert.equal(clampVideoWidth(120, desktopBounds), FLOATING_VIDEO_MIN_WIDTH)
assert.equal(clampVideoWidth(999, desktopBounds), desktopLimits.maxWidth)

const narrowLimits = computeVideoSizeLimits(narrowBounds)
assert.ok(narrowLimits.maxWidth <= Math.floor(420 * 0.68), `窄栏上限应受容器 68% 约束: ${narrowLimits.maxWidth}`)

// 2. 默认位置应落在右下角且不压住底部控制条
const def = createDefaultFloatingState(desktopBounds)
assert.equal(def.dockX, 'right')
assert.equal(def.left, desktopBounds.width - def.width - FLOATING_VIDEO_EDGE_MARGIN)
assert.equal(def.top + videoHeightForWidth(def.width), desktopBounds.height - desktopBounds.bottomClearance)

// 3. 边界夹紧防止拖出阅读区
const clamped = clampVideoPosition(-200, 9999, 360, desktopBounds)
assert.equal(clamped.left, FLOATING_VIDEO_EDGE_MARGIN)
assert.equal(clamped.top, desktopBounds.height - videoHeightForWidth(360) - desktopBounds.bottomClearance)

// 4. 磁吸吸附：靠左中线吸左，靠右中线吸右；距顶/底 <= 44px 吸顶/吸底，否则保持高度
const snapTopLeft = snapVideoPosition(120, 30, 360, desktopBounds)
assert.equal(snapTopLeft.dockX, 'left')
assert.equal(snapTopLeft.left, FLOATING_VIDEO_EDGE_MARGIN)
assert.equal(snapTopLeft.top, FLOATING_VIDEO_EDGE_MARGIN)
assert.equal(snapTopLeft.label, '左上角')

const snapRightMid = snapVideoPosition(560, 220, 360, desktopBounds)
assert.equal(snapRightMid.dockX, 'right')
assert.equal(snapRightMid.left, desktopBounds.width - 360 - FLOATING_VIDEO_EDGE_MARGIN)
assert.equal(snapRightMid.top, 220)
assert.equal(snapRightMid.label, '右侧边缘')

const snapBottomRight = snapVideoPosition(600, 440, 360, desktopBounds)
assert.equal(snapBottomRight.dockX, 'right')
assert.equal(snapBottomRight.top, desktopBounds.height - videoHeightForWidth(360) - desktopBounds.bottomClearance)
assert.equal(snapBottomRight.label, '右下角')

// 5. 四角缩放：从左上角往左拉放大时，右下角保持锚定且宽度受上限限制
const resizedNw = computeResizedFloatingRect({
  corner: 'nw',
  startLeft: 626,
  startTop: 425,
  startWidth: 360,
  deltaX: -80,
  deltaY: -45,
  bounds: desktopBounds,
})
assert.equal(resizedNw.width, 440)
assert.equal(resizedNw.left + resizedNw.width, 626 + 360, '从左上角拉伸时右边应保持固定')
assert.equal(
  resizedNw.top + videoHeightForWidth(resizedNw.width),
  425 + videoHeightForWidth(360),
  '从左上角拉伸时底边应保持固定',
)

const resizedOver = computeResizedFloatingRect({
  corner: 'nw',
  startLeft: 626,
  startTop: 425,
  startWidth: 360,
  deltaX: -900,
  deltaY: -900,
  bounds: desktopBounds,
})
assert.equal(resizedOver.width, desktopLimits.maxWidth, '超大拉伸必须被上限截住')

console.log('floating-video-layout: ALL PASSED')
