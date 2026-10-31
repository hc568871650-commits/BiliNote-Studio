import { ExternalLink } from 'lucide-react'
import { editionName, isQuickEdition, hasLocalWhisper } from '@/utils/edition'
import studioMark from '@/assets/studio-mark.svg?raw'
import '@/components/startup.css'

const studioMarkMarkup = studioMark.replaceAll('#fff', 'currentColor')

export default function AboutPage() {
  return <article className="settings-page">
    <header className="settings-page-header"><h1 className="flex items-center gap-2"><span className="studio-brand-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: studioMarkMarkup }} />关于 BiliNote Studio</h1><p>开源 AI 视频学习工作台</p></header>
    <section className="settings-card">
      <div className="settings-row"><div><h2>BiliNote Studio {editionName}</h2><p>{isQuickEdition ? '笔记生成、阅读、导图与问答，使用在线音频转写。' : hasLocalWhisper ? '包含整理助手与本地、在线音频转写的完整功能。' : '笔记生成、阅读、导图、问答与整理助手，使用在线音频转写。'} AI 生成与问答需配置你自己的模型 API。</p></div></div>
      <div className="settings-row"><div><h2>项目介绍</h2><p>BiliNote Studio 支持从视频链接提取内容，生成结构清晰的 Markdown 笔记，并通过截图与原视频跳转辅助阅读和学习。</p></div></div>
      <div className="settings-row"><div><h2>独立维护说明</h2><p>本项目基于 JefferyHcool / BiliNote 上游 v2.4.5 独立维护，是非官方衍生项目，不代表上游官方版本。</p></div></div>
      <div className="settings-row"><div><h2>原项目地址</h2><p>JefferyHcool / BiliNote</p></div><a className="settings-link" href="https://github.com/JefferyHcool/BiliNote" target="_blank" rel="noopener noreferrer">打开 GitHub <ExternalLink size={14} /></a></div>
      <div className="settings-row"><div><h2>Studio 项目地址</h2><p>BiliNote Studio 独立维护仓库</p></div><a className="settings-link" href="https://github.com/hc568871650-commits/BiliNote-Studio" target="_blank" rel="noopener noreferrer">打开 GitHub <ExternalLink size={14} /></a></div>
    </section>
  </article>
}
