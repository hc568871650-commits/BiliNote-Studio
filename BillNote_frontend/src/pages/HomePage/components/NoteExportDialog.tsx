import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Task } from '@/store/taskStore'
import { useLibraryStore } from '@/store/libraryStore'
import { noteExportContent, noteVersions } from '@/utils/noteActions'
import { generationTitle } from '@/utils/taskProgress'
import ChoiceSelect from '@/components/ChoiceSelect'
import { formatVersionLabel } from '@/utils/versionLabel'
import { resolveStructuredNote } from '@/types/structuredNote'
import {
  renderAnkiTsv,
  renderEnhancedMarkdown,
  renderInteractiveHtml,
  renderObsidianMarkdown,
} from '@/utils/structuredExport'

type ExportFormat = 'markdown' | 'obsidian' | 'html' | 'anki'

const FORMAT_OPTIONS: Array<{ id: ExportFormat; label: string; ext: string }> = [
  { id: 'markdown', label: '增强 Markdown', ext: '.md' },
  { id: 'obsidian', label: 'Obsidian 增强', ext: '.md' },
  { id: 'html', label: '交互网页', ext: '.html' },
  { id: 'anki', label: 'Anki 闪卡', ext: '.tsv' },
]

export default function NoteExportDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const versions = noteVersions(task)
  const libraryEntry = useLibraryStore(state => state.entries[task.id])
  const [versionId, setVersionId] = useState(() => versions[0]?.ver_id || '')
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const selectedVersionId = versions.some(version => version.ver_id === versionId) ? versionId : versions[0]?.ver_id || ''
  const selectedVersion = versions.find(version => version.ver_id === selectedVersionId)
  const rawContent = noteExportContent(task, selectedVersionId)
  const structuredDoc = useMemo(
    () => resolveStructuredNote(selectedVersion, rawContent),
    [selectedVersion, rawContent],
  )
  const title = generationTitle(task)
  const hasContent = Boolean(rawContent.trim() || structuredDoc)

  const ankiPreview = useMemo(
    () => renderAnkiTsv(structuredDoc, title),
    [structuredDoc, title],
  )

  const canExport = format === 'anki' ? ankiPreview.cardCount > 0 : hasContent

  const exportNote = () => {
    if (!canExport) return
    try {
      const filename = Array.from(title.replace(/[<>:"/\\|?*]/g, '_'), character => character.charCodeAt(0) < 32 ? '_' : character).join('') || 'note'
      let body = ''
      let mime = 'text/markdown;charset=utf-8'
      let ext = 'md'
      let successMsg = '已导出增强 Markdown'

      if (format === 'html') {
        body = renderInteractiveHtml(structuredDoc, rawContent, title)
        mime = 'text/html;charset=utf-8'
        ext = 'html'
        successMsg = '已导出单文件交互 HTML'
      } else if (format === 'obsidian') {
        body = renderObsidianMarkdown(structuredDoc, rawContent, {
          title,
          sourceUrl: task.formData?.video_url,
          platform: task.audioMeta?.platform || task.formData?.platform,
          videoId: task.audioMeta?.video_id,
          modelName: selectedVersion?.model_name || task.formData?.model_name,
          createdAt: selectedVersion?.created_at || task.createdAt,
          tags: libraryEntry?.tags || [],
        })
        mime = 'text/markdown;charset=utf-8'
        ext = 'md'
        successMsg = '已导出 Obsidian 增强 Markdown'
      } else if (format === 'anki') {
        body = ankiPreview.content
        mime = 'text/tab-separated-values;charset=utf-8'
        ext = 'tsv'
        successMsg = `已导出 ${ankiPreview.cardCount} 张 Anki 闪卡`
      } else {
        body = structuredDoc ? renderEnhancedMarkdown(structuredDoc, title) : rawContent
      }

      const url = URL.createObjectURL(new Blob([body], { type: mime }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${filename}.${ext}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(successMsg)
      onClose()
    } catch (error) {
      console.error('导出笔记失败', error)
      toast.error('导出失败，请稍后重试')
    }
  }

  const formatHint = format === 'html'
    ? '单文件零外链，离线可交互展开批注与自测判题。'
    : format === 'obsidian'
      ? '含 YAML 属性头、Obsidian 折叠 Callout（原理 / 避坑 / 自测）与原片时间链接。'
      : format === 'anki'
        ? ankiPreview.cardCount > 0
          ? `将从自测题与高频避坑生成 ${ankiPreview.cardCount} 张制表符分隔闪卡（UTF-8 BOM，直接导入 Anki）。`
          : '当前版本暂无自测题或高频避坑条目，无法生成 Anki 闪卡。'
        : structuredDoc
          ? '完整保留核心结论、批注详卡与自测解析。'
          : '下载为标准 Markdown（.md）文件。'

  const primaryLabel = format === 'html'
    ? '导出 HTML'
    : format === 'obsidian'
      ? '导出 Obsidian'
      : format === 'anki'
        ? `导出 Anki（${ankiPreview.cardCount} 张）`
        : '导出 Markdown'

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
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
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="导出格式">
            {FORMAT_OPTIONS.map(option => {
              const selected = format === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                    selected
                      ? 'border-[color-mix(in_srgb,var(--reading-accent,var(--primary))_45%,transparent)] bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_12%,transparent)] font-medium text-foreground'
                      : 'border-[var(--surface-hairline)] bg-[var(--surface-input)] text-muted-foreground hover:border-[var(--surface-border)] hover:text-foreground'
                  }`}
                  onClick={() => setFormat(option.id)}
                >
                  <span>{option.label}</span>
                  <span className="font-mono text-[11px] opacity-75">
                    {option.id === 'anki' ? `${ankiPreview.cardCount} 张` : option.ext}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{formatHint}</p>
        {!hasContent && <p role="status" className="text-sm text-muted-foreground">所选版本暂无可导出的正文。</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={!canExport} onClick={exportNote}>{primaryLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
