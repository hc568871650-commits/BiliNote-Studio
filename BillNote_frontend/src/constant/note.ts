/* -------------------- 常量 -------------------- */
import {
  BiliBiliLogo,
  KuaishouLogo,
  LocalLogo,
  XLogo,
  YoutubeLogo,
} from '@/components/Icons/platform.tsx'

export const noteFormats = [
  { label: '自动配图', value: 'screenshot' },
] as const

export const noteStyles = [
  { label: '教程笔记', value: 'tutorial' },
  { label: '知识笔记', value: 'knowledge' },
] as const

export const videoPlatforms = [
  { label: '哔哩哔哩', value: 'bilibili', logo: BiliBiliLogo },
  { label: 'YouTube', value: 'youtube', logo: YoutubeLogo },
  { label: 'X (Twitter)', value: 'x', logo: XLogo },
  { label: '快手', value: 'kuaishou', logo: KuaishouLogo },
  { label: '本地视频', value: 'local', logo: LocalLogo },
] as const
