import { useState } from 'react'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { editionName, isQuickEdition, hasLocalWhisper } from '@/utils/edition'
import { checkAppUpdate, type UpdateCheckResult } from '@/services/system'
import studioMark from '@/assets/studio-mark.svg?raw'
import '@/components/startup.css'

const studioMarkMarkup = studioMark.replaceAll('#fff', 'currentColor')
const CURRENT_VERSION = String(import.meta.env.VITE_APP_VERSION || '0.4.2')

export default function AboutPage() {
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [updateError, setUpdateError] = useState('')

  const handleCheckUpdate = async () => {
    if (checking) return
    setChecking(true)
    setUpdateError('')
    try {
      const res = await checkAppUpdate(CURRENT_VERSION)
      setUpdateInfo(res)
    } catch (err) {
      setUpdateError((err as { msg?: string; message?: string })?.msg || (err as Error)?.message || '检查更新失败，请稍后重试')
    } finally {
      setChecking(false)
    }
  }

  return <article className="settings-page">
    <header className="settings-page-header"><h1 className="flex items-center gap-2"><span className="studio-brand-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: studioMarkMarkup }} />关于 BiliNote Studio</h1><p>开源 AI 多源知识学习工作台 · 当前版本 v{CURRENT_VERSION}</p></header>
    <section className="settings-card">
      <div className="settings-row">
        <div>
          <h2>版本与更新</h2>
          <p>
            当前版本：v{CURRENT_VERSION}（{editionName}）
            {updateInfo && !updateInfo.has_update ? ` · 已是最新版本（v${updateInfo.latest_version}）` : ''}
          </p>
        </div>
        <button
          type="button"
          disabled={checking}
          onClick={() => void handleCheckUpdate()}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--surface-border)] px-3 text-xs font-medium hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          <span>{checking ? '检查中…' : '检查更新'}</span>
        </button>
      </div>
      {updateError && (
        <div className="mx-4 mb-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {updateError}
        </div>
      )}
      {updateInfo?.has_update && (
        <div className="mx-4 mb-3 space-y-2 rounded-xl border border-[color-mix(in_srgb,var(--reading-accent,var(--primary))_35%,transparent)] bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_8%,transparent)] px-3 py-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <strong className="font-semibold text-foreground">发现新版本 v{updateInfo.latest_version}</strong>
            <a className="settings-link" href={updateInfo.release_url} target="_blank" rel="noopener noreferrer">
              前往发布页 <ExternalLink size={13} />
            </a>
          </div>
          {updateInfo.summary && <p className="whitespace-pre-wrap text-muted-foreground">{updateInfo.summary}</p>}
        </div>
      )}
      <div className="settings-row"><div><h2>BiliNote Studio {editionName}</h2><p>{isQuickEdition ? '笔记生成、阅读、导图与问答，使用在线音频转写。' : hasLocalWhisper ? '包含整理助手与本地、在线音频转写的完整功能。' : '笔记生成、阅读、导图、问答与整理助手，使用在线音频转写。'} AI 生成与问答需配置你自己的模型 API。</p></div></div>
      <div className="settings-row"><div><h2>项目介绍</h2><p>BiliNote Studio 支持从视频、播客、推文、网页与本地文档提取知识，生成高信噪比结构化笔记，并通过批注、自测、复习本与问答辅助深度学习。</p></div></div>
      <div className="settings-row"><div><h2>独立维护说明</h2><p>本项目基于 JefferyHcool / BiliNote 上游 v2.4.5 独立维护，是非官方衍生项目，不代表上游官方版本。</p></div></div>
      <div className="settings-row"><div><h2>原项目地址</h2><p>JefferyHcool / BiliNote</p></div><a className="settings-link" href="https://github.com/JefferyHcool/BiliNote" target="_blank" rel="noopener noreferrer">打开 GitHub <ExternalLink size={14} /></a></div>
      <div className="settings-row"><div><h2>Studio 项目地址</h2><p>BiliNote Studio 独立维护仓库</p></div><a className="settings-link" href="https://github.com/hc568871650-commits/BiliNote-Studio" target="_blank" rel="noopener noreferrer">打开 GitHub <ExternalLink size={14} /></a></div>
    </section>
  </article>
}
