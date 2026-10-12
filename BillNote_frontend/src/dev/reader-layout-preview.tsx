import { useEffect, useState } from 'react'
import MarkdownViewer from '@/pages/HomePage/components/MarkdownViewer'
import { useTaskStore, type Task } from '@/store/taskStore'
import { defaultLibraryEntry, useLibraryStore } from '@/store/libraryStore'
import request from '@/utils/request'
import { getPreviewTasks, previewAdapter } from './previewMock'

// Real MarkdownViewer with distinct note/version IDs, synthetic data and no backend.
request.defaults.adapter = previewAdapter
const tasks: Task[] = getPreviewTasks().filter(task => task.status === 'SUCCESS').slice(0, 2).map((task, index) => {
  const version = Array.isArray(task.markdown) ? task.markdown[0] : null
  const content = version?.content || String(task.markdown)
  return { ...task, markdown: [
    { ...version, ver_id: `layout-${index}-first1`, content, style: 'tutorial', model_name: '布局合成测试', created_at: version?.created_at || task.createdAt },
    { ...version, ver_id: `layout-${index}-second`, content: content.replace(/核心思路/g, '第二版本内容'), style: 'tutorial', model_name: '布局合成测试', created_at: version?.created_at || task.createdAt },
  ] }
})
const plain = { ...tasks[0], id: 'layout-no-headings', markdown: '这篇合成笔记没有标题。正文不应保留空目录槽位。', audioMeta: { ...tasks[0].audioMeta, title: '无标题正文' } }
await useTaskStore.persist.rehydrate()
useTaskStore.setState({ tasks: [...tasks, plain], currentTaskId: tasks[0].id })
useLibraryStore.setState({ loadState: 'ready', entries: Object.fromEntries([...tasks, plain].map(task => [task.id, { ...defaultLibraryEntry(), learning_status: 'learning' }])), updateEntries: async () => {}, startReading: async () => {} })

export default function ReaderLayoutPreview() {
  const [report, setReport] = useState('切换笔记或版本后，采样首帧和随后320ms的正文布局。')
  const currentId = useTaskStore(state => state.currentTaskId)
  useEffect(() => {
    const root = document.getElementById('reader-layout-fixture')!
    let frame = 0, started = 0, active = false, mounts = 0
    let samples: { rail: number; left: number; width: number }[] = []
    let seen = new Set<Element>()
    const sample = () => {
      const viewport = root.querySelector<HTMLElement>('[data-testid="reader-viewport"]')
      const rail = root.querySelector('.reading-navigation')
      if (viewport && rail) {
        const rect = viewport.getBoundingClientRect()
        samples.push({ rail: rail.getBoundingClientRect().width, left: rect.left, width: rect.width })
      }
      if (performance.now() - started < 320) frame = requestAnimationFrame(sample)
      else {
        active = false
        const range = (key: 'rail' | 'left' | 'width') => Math.max(...samples.map(s => s[key])) - Math.min(...samples.map(s => s[key]))
        const expected = viewport?.querySelector('[data-note-heading]') ? 50 : 0
        const passed = samples.length > 0 && mounts === 1 && samples.every(s => Math.abs(s.rail - expected) < .5) && range('left') < .5 && range('width') < .5
        setReport(`${passed ? 'PASS' : 'FAIL'} 切换布局：${mounts}次挂载；首帧目录${samples[0]?.rail}px；正文左边界变化${range('left').toFixed(2)}px；宽度变化${range('width').toFixed(2)}px；${samples.length}帧`)
      }
    }
    const observe = (viewport: Element) => {
      if (seen.has(viewport)) return
      if (!active) {
        active = true; started = performance.now(); mounts = 0; samples = []; seen = new Set()
        setReport('正在采样切换后的布局…')
        frame = requestAnimationFrame(sample)
      }
      seen.add(viewport); mounts++
    }
    const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
      if (!(node instanceof Element)) return
      if (node.matches('[data-testid="reader-viewport"]')) observe(node)
      node.querySelectorAll('[data-testid="reader-viewport"]').forEach(observe)
    })))
    observer.observe(root, { childList: true, subtree: true })
    const viewport = root.querySelector('[data-testid="reader-viewport"]')
    if (viewport) observe(viewport)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  return <main className="h-screen flex flex-col bg-background text-foreground">
    <header className="flex flex-wrap shrink-0 items-center gap-3 border-b px-4 py-2 text-sm"><strong>正文切换回归 · 真实阅读工作台</strong><span>合成内容 · 无后端</span>
      <button onClick={() => useTaskStore.setState({ currentTaskId: currentId === tasks[0].id ? tasks[1].id : tasks[0].id })}>切换笔记</button>
      <button onClick={() => useTaskStore.setState({ currentTaskId: plain.id })}>无标题正文</button>
    </header>
    <output className="shrink-0 border-b px-4 py-2 text-xs">{report}</output>
    <div id="reader-layout-fixture" className="flex-1 min-h-0"><MarkdownViewer status="success" /></div>
  </main>
}
