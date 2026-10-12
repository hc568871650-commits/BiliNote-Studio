/* eslint-disable react-refresh/only-export-components -- Standalone test entry; edits require a full reload. */
import { createRoot } from 'react-dom/client'
import { useLayoutEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import ReaderPane from '@/pages/HomePage/components/ReaderPane'
import { MarkdownHeader } from '@/pages/HomePage/components/MarkdownHeader'
import { rehypeNoteOutline } from '@/utils/noteOutline'
import { defaultLibraryEntry, useLibraryStore } from '@/store/libraryStore'
import { runReaderInteractionChecks } from '../../tests/reader-interactions.browser'
import '@/index.css'
import 'github-markdown-css/github-markdown.css'

// Real reader/header components, synthetic text and local state only. No backend.
useLibraryStore.setState({ loadState: 'ready', entries: { 'reader-fixture': { ...defaultLibraryEntry(), learning_status: 'learning' } },
  updateEntries: async () => {}, startReading: async () => {},
})
const content = Array.from({ length: 45 }, (_, i) => `## 回归章节 ${i + 1}\n\n这是一段用于验证阅读手势和布局的合成正文。滚动、目录跳转和选字均不连接正式安装。\n\n${'保持当前阅读位置，并核对工具栏的收起状态。'.repeat(8)}\n`).join('\n')
function Preview() {
  const [compact, setCompact] = useState(false)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const [version, setVersion] = useState(0)
  const [layoutSamples, setLayoutSamples] = useState('')
  useLayoutEffect(() => {
    if (!version) return
    const samples: string[] = []
    let frame = 0
    const started = performance.now()
    const sample = () => {
      const navigation = document.querySelector('.reading-navigation')!
      const viewport = document.querySelector('[data-testid="reader-viewport"]')!
      const sizes = `${navigation.getBoundingClientRect().width.toFixed(1)}/${viewport.getBoundingClientRect().width.toFixed(1)}`
      if (samples[samples.length - 1] !== sizes) samples.push(sizes)
      if (performance.now() - started < 320) frame = requestAnimationFrame(sample)
      else setLayoutSamples(`目录/正文宽度(px)：${samples.join(' → ')}`)
    }
    // Sample visible frames, after all layout effects have completed.
    frame = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(frame)
  }, [version])
  return <main className="h-screen flex flex-col bg-background text-foreground">
    <header className="flex shrink-0 gap-3 items-center border-b px-4 py-2 text-sm"><strong>阅读交互回归</strong><span>真实组件 · 合成正文 · 零后端请求</span><button disabled={running} onClick={async () => {
      setRunning(true); setResults([])
      try { setResults(await runReaderInteractionChecks()) } finally { setRunning(false) }
    }}>{running ? '检查中' : '运行回归检查'}</button><button disabled={running} onClick={() => setVersion(value => value + 1)}>切换正文并记录布局</button></header>
    {layoutSamples && <output className="shrink-0 px-4 py-2 text-xs">{layoutSamples}</output>}
    {!!results.length && <pre role="status" className="shrink-0 max-h-48 overflow-auto px-4 py-2 text-xs">{results.join('\n')}</pre>}
    <MarkdownHeader compact={compact} currentTask={{ id: 'reader-fixture', markdown: '' }} isMultiVersion={false} currentVerId="fixture" setCurrentVerId={() => {}} modelName="合成示例" style="tutorial" noteStyles={[]} onCopy={() => {}} onDownload={() => {}} showTranscribe={false} setShowTranscribe={() => {}} viewMode="preview" setViewMode={() => {}} />
    <ReaderPane key={version} taskId="reader-fixture" versionId={`fixture-${version}`} content={content} title="阅读交互回归" onCompactChange={setCompact}>
      <ReactMarkdown className="markdown-body" rehypePlugins={[rehypeNoteOutline]}>{content}</ReactMarkdown>
    </ReaderPane>
  </main>
}
const Entry = new URLSearchParams(location.search).get('layout') === '1' ? (await import('./reader-layout-preview')).default : Preview
createRoot(document.getElementById('root')!).render(<Entry />)
