import { useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Task } from '@/store/taskStore'
import { noteExportContent, noteVersions } from '@/utils/noteActions'
import { generationTitle } from '@/utils/taskProgress'

export default function NoteExportDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const versions = noteVersions(task)
  const [versionId, setVersionId] = useState(() => versions[0]?.ver_id || '')
  const selectedVersionId = versions.some(version => version.ver_id === versionId) ? versionId : versions[0]?.ver_id || ''
  const content = noteExportContent(task, selectedVersionId)
  const exportNote = () => {
    if (!content.trim()) return
    try {
      const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      const filename = Array.from(generationTitle(task).replace(/[<>:"/\\|?*]/g, '_'), character => character.charCodeAt(0) < 32 ? '_' : character).join('')
      link.download = `${filename || 'note'}.md`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      onClose()
    } catch (error) { console.error('导出笔记失败', error); toast.error('导出失败，请稍后重试') }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>导出笔记</DialogTitle><DialogDescription className="break-words">{generationTitle(task)}</DialogDescription></DialogHeader>
    {versions.length > 0 ? <label className="flex flex-col gap-2 text-sm">笔记版本<select aria-label="导出笔记版本" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={selectedVersionId} onChange={event => setVersionId(event.target.value)}>{versions.map((version, index) => <option key={version.ver_id} value={version.ver_id}>{index === 0 ? '最新版本' : '历史版本'} · {version.created_at ? new Date(version.created_at).toLocaleString('zh-CN') : version.ver_id.slice(-6)} · {version.model_name || '未记录模型'}</option>)}</select></label> : <p className="text-sm text-muted-foreground">导出当前笔记正文。</p>}
    <p className="text-xs text-muted-foreground">下载为 Markdown（.md）文件。</p>{!content.trim() && <p role="status" className="text-sm text-muted-foreground">所选版本暂无可导出的正文。</p>}<DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button disabled={!content.trim()} onClick={exportNote}>导出 Markdown</Button></DialogFooter>
  </DialogContent></Dialog>
}
