export type SourcePlatformId = 'bilibili' | 'youtube' | 'x' | 'xiaoyuzhou' | 'web' | 'kuaishou' | 'local'

export interface SourcePlatformMeta {
  value: Exclude<SourcePlatformId, 'local'>
  label: string
  supportsCollection?: boolean
}

export const LINK_PLATFORMS: readonly SourcePlatformMeta[] = [
  { value: 'bilibili', label: '哔哩哔哩', supportsCollection: true },
  { value: 'youtube', label: 'YouTube', supportsCollection: true },
  { value: 'x', label: 'X (Twitter)', supportsCollection: false },
  { value: 'xiaoyuzhou', label: '小宇宙播客', supportsCollection: false },
  { value: 'web', label: '网页文章', supportsCollection: false },
  { value: 'kuaishou', label: '快手', supportsCollection: false },
] as const

export const PLATFORM_LABELS: Record<string, string> = {
  bilibili: '哔哩哔哩',
  youtube: 'YouTube',
  x: 'X (Twitter)',
  xiaoyuzhou: '小宇宙播客',
  web: '网页文章',
  kuaishou: '快手',
  local: '本地文件',
}

const COMMON_TRACKING_PARAMS = new Set([
  'spm_id_from', 'vd_source', 'share_source', 'share_medium', 'share_plat',
  'share_session_id', 'share_tag', 'share_times', 'bbid', 'ts', 'from_spmid',
  'buvid', 'mid', 'unique_k', 'si', 'feature', 'pp', 'ab_channel', 'fbclid',
  'gclid', 'igsh', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
])

// 仅在 X (Twitter) 域名下剥离，避免误伤 YouTube 的 ?t=123s 跳转参数
const X_ONLY_TRACKING_PARAMS = new Set(['s', 't', 'ref_src', 'ref_url', 'src'])

const X_HOST_RE = /(^|\.)(x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)$/i
const X_MIRROR_HOST_RE = /(^|\.)(twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)$/i
const XIAOYUZHOU_HOST_RE = /(^|\.)xiaoyuzhoufm\.com$/i

const isPublicWebHost = (host: string): boolean => {
  const clean = host.toLowerCase().replace(/\.$/, '')
  if (!clean || !clean.includes('.')) return false
  if (clean === 'localhost' || /\.(localhost|local|internal|test|invalid)$/i.test(clean)) return false
  // 排除常见私有/回环 IPv4
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(clean)) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) return false
  return true
}

export const withScheme = (url: string): string =>
  /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url.trim() : `https://${url.trim()}`

export const inferPlatform = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/\bBV[0-9A-Za-z]{10,12}\b/.test(trimmed)) return 'bilibili'
  try {
    const parsed = new URL(withScheme(trimmed))
    const host = parsed.hostname.toLowerCase()
    if (/(^|\.)(bilibili\.com|b23\.tv)$/.test(host)) return 'bilibili'
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube'
    if (X_HOST_RE.test(host) || host === 't.co') return 'x'
    if (XIAOYUZHOU_HOST_RE.test(host)) return 'xiaoyuzhou'
    if (/(^|\.)(kuaishou\.com|gifshow\.com)$/.test(host)) return 'kuaishou'
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isPublicWebHost(host)) return 'web'
    return null
  } catch {
    return null
  }
}

export const cleanExtractedUrl = (raw: string): string => {
  try {
    const parsed = new URL(withScheme(raw))
    const host = parsed.hostname.toLowerCase()
    const isXHost = X_HOST_RE.test(host) || host === 't.co'

    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase()
      if (
        COMMON_TRACKING_PARAMS.has(lower) ||
        lower.startsWith('utm_') ||
        (isXHost && X_ONLY_TRACKING_PARAMS.has(lower))
      ) {
        parsed.searchParams.delete(key)
      }
    }

    if (/^\/video\/BV[0-9A-Za-z]{10,12}\/$/.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }

    // 将 twitter.com / 镜像域名统一规范化为 https://x.com/...
    if (X_MIRROR_HOST_RE.test(host) && /\/(?:status|statuses|article|broadcasts|spaces)\//i.test(parsed.pathname)) {
      parsed.protocol = 'https:'
      parsed.hostname = 'x.com'
      parsed.pathname = parsed.pathname.replace(/\/statuses\//i, '/status/').replace(/\/+$/, '')
    } else if ((host === 'x.com' || host === 'www.x.com' || host === 'mobile.x.com') && parsed.pathname.length > 1) {
      parsed.protocol = 'https:'
      parsed.hostname = 'x.com'
      parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    } else if (XIAOYUZHOU_HOST_RE.test(host)) {
      const epMatch = parsed.pathname.match(/\/episode\/([0-9A-Za-z_-]+)/i)
      if (epMatch) {
        return `https://www.xiaoyuzhoufm.com/episode/${epMatch[1]}`
      }
    }

    return parsed.toString()
  } catch {
    return raw.trim()
  }
}

export const extractShareInput = (raw: string): { url: string; platform: string | null; extracted: boolean } => {
  const trimmed = raw.trim()
  if (!trimmed) return { url: '', platform: null, extracted: false }
  const urlMatch = trimmed.match(/https?:\/\/[^\s"'<>，。！？、）】\]》]+/i)
  if (urlMatch) {
    const cleaned = cleanExtractedUrl(urlMatch[0].replace(/[.,;:!?。，；！？）》\]】]+$/, ''))
    const detected = inferPlatform(cleaned)
    return { url: cleaned, platform: detected, extracted: cleaned !== trimmed }
  }
  const bvMatch = trimmed.match(/\b(BV[0-9A-Za-z]{10,12})\b/)
  if (bvMatch) {
    const cleaned = `https://www.bilibili.com/video/${bvMatch[1]}`
    return { url: cleaned, platform: 'bilibili', extracted: cleaned !== trimmed }
  }
  return { url: trimmed, platform: inferPlatform(trimmed), extracted: false }
}

export const isSubtitleSourceName = (value: string): boolean => /\.(srt|vtt)(?:[?#].*)?$/i.test(value.trim())

export const isDocumentSourceName = (value: string): boolean => /\.(pdf|md|markdown|txt)(?:[?#].*)?$/i.test(value.trim())

export const looksLikeCollectionUrl = (value: string): boolean => {
  const text = value.trim()
  if (!text) return false
  const detected = inferPlatform(text)
  if (detected === 'x' || detected === 'xiaoyuzhou' || detected === 'web') return false
  return /[?&]list=|\/playlist\b|\/medialist\b|collectiondetail|favlist|\/lists\/|[?&]p=\d+/i.test(text)
}
