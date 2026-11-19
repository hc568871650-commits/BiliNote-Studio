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
  douyin: '抖音',
  xiaohongshu: '小红书',
  local: '本地视频',
}

export default function VideoBanner({ audioMeta, videoUrl, modelName, styleLabel, createdAt }: VideoBannerProps) {
  const rawCover = audioMeta?.cover_url
  // 通过后端代理加载封面，避免跨域/Referrer 限制
  const apiBase = String(import.meta.env.VITE_API_BASE_URL || 'api').replace(/\/$/, '')
  const coverUrl = rawCover
    ? (audioMeta?.platform === 'local' ? rawCover : `${apiBase}/image_proxy?url=${encodeURIComponent(rawCover)}`)
    : ''
  const title = audioMeta?.title
  const uploader = audioMeta?.raw_info?.uploader || ''
  const platform = audioMeta ? (platformLabel[audioMeta.platform] || audioMeta.platform || '') : ''
  const originalUrl = videoUrl || audioMeta?.raw_info?.webpage_url || ''
  const timeText = formatNoteTime(createdAt)
  const metaText = [uploader, platform, modelName, styleLabel, timeText].filter(Boolean).join(' · ')
  // Old local notes may still carry a black first-frame cover.
  const showCover = Boolean(coverUrl) && (audioMeta?.platform !== 'local' || audioMeta?.raw_info?.cover_strategy === 'ten-percent')

  if (!metaText && !originalUrl && !showCover) return null

  return (
    <div className="video-source-row" title={title || metaText}>
      {showCover && <img src={coverUrl} alt="" referrerPolicy="no-referrer" className="h-5 w-8 shrink-0 rounded object-cover" />}
      <span className="min-w-0 truncate">{metaText}</span>
      {originalUrl && (
        <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="video-source-link">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          <span>原视频</span>
        </a>
      )}
    </div>
  )
}
