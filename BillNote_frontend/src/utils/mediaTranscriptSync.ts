export interface TranscriptSegmentLike {
  start: number
  end: number
  text?: string
  translated_text?: string
}

export interface MediaConcatSegment {
  index?: number
  label?: string
  start: number
  end: number
  duration?: number
}

const CJK_CHAR_RE = /[\u4e00-\u9fff]/g
const FOREIGN_CHAR_RE = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af]/g

export function hasTranslatedCaptions(segments: readonly TranscriptSegmentLike[] | null | undefined): boolean {
  return Boolean(segments?.some(seg => Boolean(seg.translated_text?.trim())))
}

export function hasUntranslatedCaptions(segments: readonly TranscriptSegmentLike[] | null | undefined): boolean {
  if (!segments || segments.length === 0) return false
  return segments.some(seg => Boolean(seg.text?.trim()) && !seg.translated_text?.trim())
}

export function isForeignTranscript(segments: readonly TranscriptSegmentLike[] | null | undefined): boolean {
  if (!segments || segments.length === 0) return false
  const joined = segments.map(seg => (seg.text || '').trim()).filter(Boolean).join(' ')
  const compact = joined.replace(/\s+/g, '')
  if (compact.length < 12) return false
  const foreignCount = (compact.match(FOREIGN_CHAR_RE) || []).length
  if (foreignCount < 8) return false
  const cjkCount = (compact.match(CJK_CHAR_RE) || []).length
  return cjkCount / compact.length < 0.22
}

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const
export type PlaybackRate = (typeof PLAYBACK_RATES)[number]

export type TimestampAction = 'play_local' | 'play_embed' | 'transcript_only' | 'open_external' | 'noop'

export interface OnlineVideoEmbed {
  provider: 'bilibili' | 'youtube'
  label: string
  videoId: string
  page?: number
  buildEmbedUrl: (options: { startSeconds: number; autoPlay: boolean; captions: boolean }) => string
}

const BV_PATTERN = /\b(BV[0-9A-Za-z]{10})\b/i
const YT_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function resolveOnlineVideoEmbed(options: {
  platform?: string | null
  videoId?: string | null
  videoUrl?: string | null
}): OnlineVideoEmbed | null {
  const platform = String(options.platform || '').trim().toLowerCase()
  const rawUrl = String(options.videoUrl || '').trim()
  const rawId = String(options.videoId || '').trim()

  // Bilibili：提取 BV 号与可选分 P（不下载直接内嵌官方外链播放器）
  const bvMatch = rawUrl.match(BV_PATTERN) || rawId.match(BV_PATTERN)
  if (bvMatch && (platform === 'bilibili' || !platform || /bilibili\.com|b23\.tv/i.test(rawUrl))) {
    const bvid = bvMatch[1]
    let page = 1
    try {
      const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`)
      const pVal = Number(parsed.searchParams.get('p'))
      if (Number.isInteger(pVal) && pVal > 0) page = pVal
    } catch {
      const pMatch = rawUrl.match(/[?&]p=(\d+)/i)
      if (pMatch) page = Math.max(1, Number(pMatch[1]) || 1)
    }
    return {
      provider: 'bilibili',
      label: 'B 站在线',
      videoId: bvid,
      page,
      buildEmbedUrl: ({ startSeconds, autoPlay }) => {
        const t = Math.max(0, Math.floor(startSeconds))
        return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&p=${page}&t=${t}&autoplay=${autoPlay ? 1 : 0}&high_quality=1&danmaku=0`
      },
    }
  }

  // YouTube：支持 watch?v= / youtu.be / shorts / embed
  let ytId = ''
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`)
      const host = parsed.hostname.toLowerCase()
      if (host.includes('youtu.be')) {
        ytId = parsed.pathname.replace(/^\/+/, '').split('/')[0] || ''
      } else if (host.includes('youtube.com')) {
        ytId = parsed.searchParams.get('v') || ''
        if (!ytId) {
          const segMatch = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/i)
          if (segMatch) ytId = segMatch[1]
        }
      }
    } catch {
      // 忽略非法 URL
    }
  }
  if (!ytId && platform === 'youtube' && YT_ID_PATTERN.test(rawId)) {
    ytId = rawId
  }
  if (ytId && YT_ID_PATTERN.test(ytId)) {
    return {
      provider: 'youtube',
      label: 'YouTube 在线',
      videoId: ytId,
      buildEmbedUrl: ({ startSeconds, autoPlay, captions }) => {
        const start = Math.max(0, Math.floor(startSeconds))
        return `https://www.youtube.com/embed/${encodeURIComponent(ytId)}?start=${start}&autoplay=${autoPlay ? 1 : 0}&rel=0&cc_load_policy=${captions ? 1 : 0}&enablejsapi=1`
      },
    }
  }

  return null
}

/**
 * 将播放秒数匹配到对应转写段索引：
 * 1) 优先命中包含当前时间点的区间 [start, end)（末段含右边界）
 * 2) 若落在两段间隙内，就近命中最近的前一段
 * 3) 若在首段前 <= 15s，返回首段；其余非法/越界返回 -1
 */
export function findSegmentIndexForTime(
  segments: readonly TranscriptSegmentLike[] | null | undefined,
  seconds: number,
): number {
  if (!segments || segments.length === 0) return -1
  if (!Number.isFinite(seconds) || seconds < 0) return -1

  let lastBefore = -1
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    const isLast = i === segments.length - 1
    if (seconds >= seg.start && (seconds < seg.end || (isLast && seconds <= seg.end))) {
      return i
    }
    if (seg.start <= seconds) {
      lastBefore = i
    }
  }

  if (lastBefore >= 0) return lastBefore
  if (segments[0].start - seconds <= 15) return 0
  return -1
}

export function resolveTimestampAction(options: {
  mediaAvailable: boolean
  embedAvailable?: boolean
  hasTranscriptMatch: boolean
  originUrl?: string | null
}): TimestampAction {
  if (options.mediaAvailable) return 'play_local'
  if (options.embedAvailable) return 'play_embed'
  if (options.hasTranscriptMatch) return 'transcript_only'
  if (options.originUrl && options.originUrl.trim()) return 'open_external'
  return 'noop'
}

export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const secStr = secs.toString().padStart(2, '0')
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secStr}`
  }
  return `${mins}:${secStr}`
}

export function clampPlaybackRate(rate: number): PlaybackRate {
  if (!Number.isFinite(rate)) return 1
  if (rate <= PLAYBACK_RATES[0]) return PLAYBACK_RATES[0]
  const last = PLAYBACK_RATES[PLAYBACK_RATES.length - 1]
  if (rate >= last) return last
  let closest: PlaybackRate = 1
  let minDiff = Number.POSITIVE_INFINITY
  for (const candidate of PLAYBACK_RATES) {
    const diff = Math.abs(candidate - rate)
    if (diff < minDiff) {
      minDiff = diff
      closest = candidate
    }
  }
  return closest
}

export function nextPlaybackRate(current: number): PlaybackRate {
  const normalized = clampPlaybackRate(current)
  const idx = PLAYBACK_RATES.indexOf(normalized)
  return PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length]
}
