import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { LearningStatus, NoteLibraryEntry } from '@/services/noteLibrary'
import { readingLabels } from '@/utils/readingStatus'

interface Props {
  open: boolean
  title: string
  entry: NoteLibraryEntry
  busy?: boolean
  showReadingStatus?: boolean
  onOpenChange: (open: boolean) => void
  onSave: (changes: Pick<NoteLibraryEntry, 'tags' | 'remark'> & Partial<Pick<NoteLibraryEntry, 'learning_status'>>) => void
}

const statuses: Array<{ value: LearningStatus, label: string }> = [
  { value: 'unread', label: readingLabels.unread }, { value: 'learning', label: readingLabels.learning }, { value: 'done', label: readingLabels.done },
]

const LibraryMetadataDialog = ({ open, title, entry, busy, showReadingStatus = true, onOpenChange, onSave }: Props) => {
  const [learningStatus, setLearningStatus] = useState<LearningStatus>(entry.learning_status)
  const [tagsText, setTagsText] = useState(entry.tags.join(', '))
  const [remark, setRemark] = useState(entry.remark)
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLearningStatus(entry.learning_status)
    setTagsText(entry.tags.join(', '))
    setRemark(entry.remark)
    setValidationError(null)
  }, [open, entry])

  const save = () => {
    const tags = [...new Set(tagsText.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))]
    if (tags.length > 10) return setValidationError('标签不能超过 10 个，请删除多余标签后保存')
    if (tags.some(tag => Array.from(tag).length > 24)) return setValidationError('每个标签不能超过 24 个字符，请修改后保存')
    if (Array.from(remark).length > 2000) return setValidationError('备注不能超过 2000 个字符，请缩短后保存')
    setValidationError(null)
    onSave({ ...(showReadingStatus ? { learning_status: learningStatus } : {}), tags, remark })
  }

  return <Dialog open={open} onOpenChange={nextOpen => { if (!busy || nextOpen) onOpenChange(nextOpen) }}>
    <DialogContent className="max-w-lg" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
      <DialogHeader><DialogTitle>编辑笔记信息</DialogTitle><DialogDescription className="truncate">{title}</DialogDescription></DialogHeader>
      <div className="space-y-4 py-1">
        {showReadingStatus && <label className="block text-sm font-medium">阅读状态
          <select disabled={busy} className="mt-1 block w-full rounded border border-input bg-background px-3 py-2" value={learningStatus} onChange={event => setLearningStatus(event.target.value as LearningStatus)}>
            {statuses.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}
          </select>
        </label>}
        <label className="block text-sm font-medium">标签（最多 10 个，每个 24 字）
          <input disabled={busy} className="mt-1 block w-full rounded border border-input bg-background px-3 py-2" value={tagsText} onChange={event => { setTagsText(event.target.value); setValidationError(null) }} placeholder="例如：教程, 待复习" />
        </label>
        <label className="block text-sm font-medium">备注（最多 2000 字）
          <textarea disabled={busy} className="mt-1 block min-h-28 w-full resize-y rounded border border-input bg-background px-3 py-2" value={remark} onChange={event => { setRemark(event.target.value); setValidationError(null) }} />
        </label>
        {validationError && <p className="text-sm text-destructive" role="alert">{validationError}</p>}
      </div>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export default LibraryMetadataDialog
