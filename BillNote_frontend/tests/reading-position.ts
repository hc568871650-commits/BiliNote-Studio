import assert from 'node:assert/strict'
import { captureReadingPosition, parseReadingPosition, trackReadingPosition } from '../src/utils/readingPosition'
import { interfaceDefaults } from '../src/store/interfaceStore'

const host = new EventTarget()
Object.assign(globalThis, { window: host })
let frame: (() => void) | null = null
Object.assign(globalThis, { requestAnimationFrame: (callback: () => void) => { frame = callback; return 1 }, cancelAnimationFrame: () => { frame = null } })
let resized: (() => void) | undefined
Object.assign(globalThis, { ResizeObserver: class { constructor(callback: () => void) { resized = callback } observe() {} disconnect() {} } })
const paint = () => { resized?.(); const callback = frame; frame = null; callback?.() }
class Viewport extends EventTarget {
  clientHeight = 200
  scrollHeight = 1200
  clientTop = 0
  clientWidth = 480
  offsetWidth = 500
  private top = 0
  get scrollTop() { return this.top }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)) }
  getBoundingClientRect() { return { top: 0, right: 500 } }
}
const viewport = new Viewport()
let blockTops = [0, 400, 800]
const article = { querySelectorAll: () => blockTops.map(top => ({ getBoundingClientRect: () => ({ top: top - viewport.scrollTop }) })) } as unknown as HTMLElement
const element = viewport as unknown as HTMLElement
let saved: unknown[] = []
let progress = 0
const open = (autoRestore: boolean, value: unknown) => trackReadingPosition(element, article, { autoRestore, saved: parseReadingPosition(value), onProgress: value => { progress = value }, onSave: value => saved.push(value) })
assert.equal(interfaceDefaults.restoreReadingPosition, false)
assert.deepEqual(parseReadingPosition(0.55), { progress: 0.55 })
assert.equal(parseReadingPosition({ progress: NaN }), null)
assert.deepEqual(parseReadingPosition({ progress: 0.4, block: -1, offset: 1 }), { progress: 0.4 })

let tracker = open(false, 0.55)
assert.equal(viewport.scrollTop, 0, '默认从头打开')
viewport.dispatchEvent(new Event('scroll')); tracker.dispose()
assert.equal(saved.length, 0, '程序归零和清理不覆盖旧位置')
tracker = open(true, 0.55)
assert.equal(viewport.scrollTop, 550, '兼容旧比例恢复')
viewport.scrollHeight = 2200; paint()
assert.equal(viewport.scrollTop, 1100, '图片延迟改变高度时重新定位')
viewport.scrollHeight = 2400; resized?.()
assert.equal(viewport.scrollTop, 1210, '布局通知当帧完成定位，不等待下一帧')
assert.equal(frame, null, '恢复不能排到下一次绘制')
tracker.dispose()
assert.equal(saved.length, 0, '自动恢复不写入进度')

viewport.scrollHeight = 1200
tracker = open(true, { progress: 0.425, block: 1, offset: 25 })
assert.equal(viewport.scrollTop, 425)
blockTops = [0, 650, 1050]; viewport.scrollHeight = 1450; paint()
assert.equal(viewport.scrollTop, 675, '锚点前图片变高后保持原段落')
viewport.dispatchEvent(new Event('note-chapter-jump'))
viewport.scrollTop = 1000; viewport.dispatchEvent(new Event('scroll'))
blockTops = [0, 750, 1150]; viewport.scrollHeight = 1550; paint()
assert.equal(viewport.scrollTop, 1000, '显式章节跳转优先，后续布局不恢复旧进度')
tracker.dispose()
assert.deepEqual(saved.at(-1), { progress: 0.8, block: 1, offset: 350 }, '保存跳转时快照，不使用切换后的 DOM')

saved = []
tracker = open(false, 0.55)
tracker.resume({ progress: 0.5, block: 1, offset: 30 })
assert.equal(viewport.scrollTop, 780, '继续阅读使用保存锚点')
viewport.dispatchEvent(new Event('wheel'))
viewport.scrollTop = 900; viewport.dispatchEvent(new Event('scroll'))
viewport.scrollHeight = 1700; paint()
assert.equal(viewport.scrollTop, 900, '用户滚动接管恢复')
tracker.reset(); viewport.dispatchEvent(new Event('scroll')); tracker.dispose()
assert.equal(saved.length, 0, '显式清除取消等待保存，不能复活旧进度')

tracker = open(true, 0.5)
viewport.clientHeight = 0
viewport.scrollTop = 0; viewport.dispatchEvent(new Event('scroll'))
viewport.clientHeight = 200; paint()
assert.equal(viewport.scrollTop, 750, '隐藏阅读器再显示后恢复且隐藏归零不保存')
assert.equal(progress, 50)
assert.equal(captureReadingPosition(element, article).progress, 0.5)
tracker.dispose()

viewport.clientHeight = 0
viewport.scrollTop = 0
tracker = open(true, { progress: 0.5, block: 1, offset: 30 })
assert.equal(viewport.scrollTop, 0)
viewport.clientHeight = 200; resized?.()
assert.equal(viewport.scrollTop, 780, '隐藏状态初始化后，首个可见绘制前直接恢复锚点')
assert.equal(frame, null)
tracker.dispose()
console.log('PASS reading-position: defaults, legacy data, delayed geometry, anchors, explicit navigation, reset, hidden workspace, safe disposal')
