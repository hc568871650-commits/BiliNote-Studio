import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import ReaderPane from '@/pages/HomePage/components/ReaderPane'
import { rehypeNoteOutline } from '@/utils/noteOutline'
import { defaultLibraryEntry, useLibraryStore } from '@/store/libraryStore'
import '@/index.css'
import 'github-markdown-css/github-markdown.css'

// Synthetic, browser-only fixture. No backend, model, production data or credentials.
useLibraryStore.setState({ loadState: 'ready', entries: { 'outline-fixture': { ...defaultLibraryEntry(), learning_status: 'learning' } },
  updateEntries: async (_ids, changes) => { useLibraryStore.setState(state => ({ entries: { 'outline-fixture': { ...state.entries['outline-fixture'], ...changes } } })) },
  startReading: async () => {},
})
const phases = ['准备与部件选区', '基础色与通道', '颜色变化', '粗糙度与表面细节', '磨边与遮罩', '模型修正', '金属材质', '文字贴图', '自发光', '整体调整', '最终检查']
const long = phases.map((phase, part) => `## 来源分段 ${part + 1}\n\n# 材质制作示例\n\n` + Array.from({ length: part === 10 ? 5 : 10 }, (_, index) => `## ${phase} · ${['操作准备', '对象与图层', '底色调整', '遮罩范围', '细节控制', '检查效果', '修正问题', '整理图层', '局部优化', '完成确认'][index]} *Content-[${String(part * 9 + index).padStart(2, '0')}:00]\n\n本节为目录交互示例，先确认当前对象与图层，再调整对应参数。保留操作顺序和检查结果，点击目录可回到具体步骤。\n\n- 检查操作对象与选区。\n- 根据画面调整效果。\n- 对比修改前后并保存。\n`).join('\n')).join('\n')
const short = '# 简短教程\n\n## 准备 *Content-[00:00]\n\n准备素材。\n\n### 检查输入\n\n核对对象。\n\n## 制作 *Content-[01:00]\n\n开始操作。\n\n### 调整细节\n\n检查参数。\n\n## 完成 *Content-[03:00]\n\n保存结果。'
function Preview() {
  const [kind, setKind] = useState('long')
  const [dark, setDark] = useState(false)
  const content = kind === 'long' ? long : kind === 'short' ? short : '这篇示例没有标题。正文仍然正常显示。'
  return <main className={dark ? 'outline-fixture dark h-screen flex flex-col bg-background text-foreground' : 'outline-fixture h-screen flex flex-col bg-background text-foreground'} data-color-mode={dark ? 'dark' : 'light'}>
    <style>{`.outline-fixture .markdown-body { background:transparent; color:inherit; } .outline-fixture .markdown-body :is(h1,h2,h3,h4,h5,h6) { color:inherit; }`}</style>
    <header className="flex flex-wrap gap-3 items-center border-b px-5 py-3 text-sm"><strong>目录重做预览</strong><span className="text-muted-foreground">示例数据 · 不连接正式版</span><select aria-label="示例笔记" value={kind} onChange={e => setKind(e.target.value)}><option value="long">长教程 · 105 个操作标题</option><option value="short">短教程 · 层级目录</option><option value="empty">无标题笔记</option></select><button onClick={() => setDark(!dark)}>切换明暗</button></header>
    <ReaderPane taskId="outline-fixture" versionId={kind} content={content} title="目录交互示例"><ReactMarkdown className="markdown-body" rehypePlugins={[rehypeNoteOutline]}>{content}</ReactMarkdown></ReaderPane>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
