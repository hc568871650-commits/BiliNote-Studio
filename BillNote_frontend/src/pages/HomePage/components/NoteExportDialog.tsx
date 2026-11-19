import { useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Task } from '@/store/taskStore'
import { noteExportContent, noteVersions } from '@/utils/noteActions'
import { generationTitle } from '@/utils/taskProgress'
import ChoiceSelect from '@/components/ChoiceSelect'
import { formatVersionLabel } from '@/utils/versionLabel'
import { resolveStructuredNote } from '@/types/structuredNote'
import { renderEnhancedMarkdown, renderInteractiveHtml } from '@/utils/structuredExport'

type ExportFormat = 'markdown' | 'html'

export default function NoteExportDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const versions = noteVersions(task)
  const [versionId, setVersionId] = useState(() => versions[0]?.ver_id || '')
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const selectedVersionId = versions.some(version => version.ver_id === versionId) ? versionId : versions[0]?.ver_id || ''
  const selectedVersion = versions.find(version => version.ver_id === selectedVersionId)
  const structuredDoc = resolveStructuredNote(selectedVersion)
  const rawContent = noteExportContent(task, selectedVersionId)
  const title = generationTitle(task)
  const hasContent = Boolean(rawContent.trim() || structuredDoc)

  const exportNote = () => {
    if (!hasContent) return
    try {
      const filename = Array.from(title.replace(/[<>:"/\\|?*]/g, '_'), character => character.charCodeAt(0) < 32 ? '_' : character).join('') || 'note'
      const body = format === 'html'
        ? renderInteractiveHtml(structuredDoc, rawContent, title)
        : structuredDoc
          ? renderEnhancedMarkdown(structuredDoc, title)
          : rawContent
      const mime = format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8'
      const ext = format === 'html' ? 'html' : 'md'
      const url = URL.createObjectURL(new Blob([body], { type: mime }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${filename}.${ext}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(format === 'html' ? '已导出单文件交互 HTML' : '已导出增强 Markdown')
      onClose()
    } catch (error) { console.error('导出笔记失败', error); toast.error('导出失败，请稍后重试') }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>导出笔记</DialogTitle>
        <DialogDescription className="break-words">{title}</DialogDescription>
      </DialogHeader>
      {versions.length > 0 && (
        <label className="flex flex-col gap-2 text-sm">
          笔记版本
          <ChoiceSelect
            label="导出笔记版本"
            className="metadata-choice"
            value={selectedVersionId}
            onChange={setVersionId}
            options={versions.map((version, index) => ({
              value: version.ver_id,
              label: `${formatVersionLabel(version, index, versions.length)} · ${version.model_name || '未记录模型'}`,
            }))}
          />
        </label>
      )}
      <div className="flex flex-col gap-2 text-sm">
        <span>导出格式</span>
        <div className="codex-segmented" role="tablist" aria-label="导出格式" data-active-index={format === 'markdown' ? 0 : 1}>
          <span className="codex-segmented-thumb" aria-hidden="true" />
          <button type="button" role="tab" aria-selected={format === 'markdown'} className={`codex-segmented-tab text-xs ${format === 'markdown' ? 'is-active' : ''}`} onClick={() => setFormat('markdown')}>
            增强 Markdown (.md)
          </button>
          <button type="button" role="tab" aria-selected={format === 'html'} className={`codex-segmented-tab text-xs ${format === 'html' ? 'is-active' : ''}`} onClick={() => setFormat('html')}>
            交互网页 (.html)
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {format === 'html'
          ? '单文件零外链，离线可交互展开批注与自测判题。'
          : structuredDoc
            ? '完整保留核心结论、批注详卡与自测解析。'
            : '下载为标准 Markdown（.md）文件。'}
      </p>
      {!hasContent && <p role="status" className="text-sm text-muted-foreground">所选版本暂无可导出的正文。</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button disabled={!hasContent} onClick={exportNote}>{format === 'html' ? '导出 HTML' : '导出 Markdown'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
