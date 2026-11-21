import assert from 'node:assert/strict'
import {
  clampPlaybackRate,
  findSegmentIndexForTime,
  formatMediaTime,
  resolveOnlineVideoEmbed,
  resolveTimestampAction,
  type TranscriptSegmentLike,
} from '../src/utils/mediaTranscriptSync.ts'

const segments: TranscriptSegmentLike[] = [
  { start: 0, end: 15, text: '开场介绍' },
  { start: 15, end: 32, text: '连接池原理' },
  { start: 40, end: 68, text: '压测数据对比' },
  { start: 728, end: 760, text: '12:08 核心公式' },
]

// 1. 精确命中区间内部与左闭边界
assert.equal(findSegmentIndexForTime(segments, 0), 0)
assert.equal(findSegmentIndexForTime(segments, 14.9), 0)
assert.equal(findSegmentIndexForTime(segments, 15), 1)
assert.equal(findSegmentIndexForTime(segments, 50), 2)
assert.equal(findSegmentIndexForTime(segments, 728), 3)
assert.equal(findSegmentIndexForTime(segments, 760), 3, '最后一段右边界应命中末段')

// 2. 区间间隙（32~40 之间）应就近命中前一段
assert.equal(findSegmentIndexForTime(segments, 35), 1)

// 3. 空数组与非法输入安全返回 -1
assert.equal(findSegmentIndexForTime([], 10), -1)
assert.equal(findSegmentIndexForTime(segments, -5), -1)
assert.equal(findSegmentIndexForTime(segments, Number.NaN), -1)

// 4. 点击时间戳动作决策：优先本地媒体回看 -> 原文定位 -> 外链降级 -> noop
assert.equal(
  resolveTimestampAction({
    mediaAvailable: true,
    hasTranscriptMatch: true,
    originUrl: 'https://www.bilibili.com/video/BV1xx?t=728',
  }),
  'play_local',
)
assert.equal(
  resolveTimestampAction({
    mediaAvailable: true,
    hasTranscriptMatch: false,
    originUrl: 'https://www.bilibili.com/video/BV1xx?t=728',
  }),
  'play_local',
)
assert.equal(
  resolveTimestampAction({
    mediaAvailable: false,
    hasTranscriptMatch: true,
    originUrl: 'https://www.bilibili.com/video/BV1xx?t=728',
  }),
  'transcript_only',
)
assert.equal(
  resolveTimestampAction({
    mediaAvailable: false,
    hasTranscriptMatch: false,
    originUrl: 'https://www.bilibili.com/video/BV1xx?t=728',
  }),
  'open_external',
)
assert.equal(
  resolveTimestampAction({
    mediaAvailable: false,
    hasTranscriptMatch: false,
    originUrl: null,
  }),
  'noop',
)

// 5. 时间格式化与倍速归一化
assert.equal(formatMediaTime(0), '0:00')
assert.equal(formatMediaTime(65), '1:05')
assert.equal(formatMediaTime(728), '12:08')
assert.equal(formatMediaTime(3661), '1:01:01')
assert.equal(clampPlaybackRate(1.25), 1.25)
assert.equal(clampPlaybackRate(3.5), 2)
assert.equal(clampPlaybackRate(0.2), 0.75)

// 6. 无下载在线视频嵌入解析（B 站 / YouTube + 字幕参数）
const biliEmbed = resolveOnlineVideoEmbed({
  platform: 'bilibili',
  videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=3',
})
assert.ok(biliEmbed)
assert.equal(biliEmbed.provider, 'bilibili')
assert.equal(biliEmbed.page, 3)
assert.equal(
  biliEmbed.buildEmbedUrl({ startSeconds: 728.9, autoPlay: true, captions: true }),
  'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&p=3&t=728&autoplay=1&high_quality=1&danmaku=0',
)

const ytEmbed = resolveOnlineVideoEmbed({
  platform: 'youtube',
  videoUrl: 'https://youtu.be/dQw4w9WgXcQ?t=42',
})
assert.ok(ytEmbed)
assert.equal(ytEmbed.provider, 'youtube')
assert.match(ytEmbed.buildEmbedUrl({ startSeconds: 120, autoPlay: true, captions: true }), /cc_load_policy=1/)
assert.match(ytEmbed.buildEmbedUrl({ startSeconds: 120, autoPlay: false, captions: false }), /cc_load_policy=0/)

assert.equal(
  resolveTimestampAction({
    mediaAvailable: false,
    embedAvailable: true,
    hasTranscriptMatch: true,
    originUrl: 'https://youtu.be/dQw4w9WgXcQ',
  }),
  'play_embed',
)

console.log('media-transcript-sync: ALL PASSED')
