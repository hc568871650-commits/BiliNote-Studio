import { ExternalLink } from 'lucide-react'
import type { AudioMeta } from '@/store/taskStore'
import { formatNoteTime } from '@/utils/versionLabel'

interface VideoBannerProps {
  audioMeta?: AudioMeta
  videoUrl?: string
  modelName?: string
  styleLabel?: string
  createdAt?: string | Date
}

/** 平台 label 映射 */
const platformLabel: Record<string, string> = {
  bilibili: '哔哩哔哩',
  youtube: 'YouTube',
  x: 'X (Twitter)',
  xiaoyuzhou: '小宇宙播客',
  web: '网页文章',
  kuaishou: '快手',
  douyin: '抖音',
  xiaohongshu: '小红书',
  local: '本地文件',
}

export default function VideoBanner({ audioMeta, videoUrl, modelName, styleLabel, createdAt }: VideoBannerProps) {
  const rawCover = audioMeta?.cover_url
  // 通过后端代理加载外链封面；已本地化的 /static 或 /uploads 路径直接访问
  const apiBase = String(import.meta.env.VITE_API_BASE_URL || 'api').replace(/\/$/, '')
  const apiOrigin = apiBase.replace(/\/api$/i, '')
  const coverUrl = rawCover
    ? (audioMeta?.platform === 'local'
      ? rawCover
      : rawCover.startsWith('/')
        ? `${apiOrigin}${rawCover}`
        : `${apiBase}/image_proxy?url=${encodeURIComponent(rawCover)}`)
    : ''
  const title = audioMeta?.title
  const uploader = audioMeta?.raw_info?.uploader || ''
  const isDocument = Boolean(audioMeta?.raw_info?.is_document)
  const platform = audioMeta
    ? (audioMeta.platform === 'local' && isDocument ? '本地文档' : (platformLabel[audioMeta.platform] || audioMeta.platform || ''))
    : ''
  const originalUrl = videoUrl || audioMeta?.raw_info?.webpage_url || ''
  const hasExternalLink = /^https?:\/\//i.test(originalUrl)
  const isTextPost = audioMeta?.raw_info?.media_kind === 'text_post'
  const isAudioOnly = audioMeta?.raw_info?.media_kind === 'audio'
  const sourceLinkLabel = audioMeta?.platform === 'web'
    ? '原文'
    : isTextPost
      ? '原帖'
      : isAudioOnly
        ? '原音频'
        : '原视频'
  const timeText = formatNoteTime(createdAt)
  const uploaderText = uploader && uploader !== platform ? uploader : ''
  const metaText = [uploaderText, platform, modelName, styleLabel, timeText].filter(Boolean).join(' · ')
  // Old local notes may still carry a black first-frame cover.
  const showCover = Boolean(coverUrl) && (audioMeta?.platform !== 'local' || audioMeta?.raw_info?.cover_strategy === 'ten-percent')

  if (!metaText && !hasExternalLink && !showCover) return null

  return (
    <div className="video-source-row" title={title || metaText}>
      {showCover && <img src={coverUrl} alt="" referrerPolicy="no-referrer" className="h-5 w-8 shrink-0 rounded object-cover" />}
      <span className="min-w-0 truncate">{metaText}</span>
      {hasExternalLink && (
        <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="video-source-link">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{sourceLinkLabel}</span>
        </a>
      )}
    </div>
  )
}
