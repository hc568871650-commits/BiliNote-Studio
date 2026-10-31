'use client'

import { BrainCircuit, FileText, MessageSquare, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { noteStyleLabel } from '@/utils/noteGeneration'
import { formatNoteTime, formatVersionLabel } from '@/utils/versionLabel'
import { useInterfaceStore } from '@/store/interfaceStore'
import { lazy, Suspense, useState } from 'react'
import { useTaskStore } from '@/store/taskStore'
import toast from 'react-hot-toast'
const GenerationDetailsDialog = lazy(() => import('./GenerationDetailsDialog'))

interface VersionNote {
  ver_id: string
  model_name?: string
  style?: string
  created_at?: string
}

interface NoteHeaderProps {
  compact?: boolean
  currentTask?: {
    id: string
    markdown: VersionNote[] | string
    archived_at?: string | null
  } | null
  isMultiVersion: boolean
  currentVerId: string
  setCurrentVerId: (id: string) => void
  modelName: string
  style: string
  noteStyles: readonly { value: string; label: string }[]
  onCopy: () => void
  onDownload: () => void
  createAt?: string | Date
  showTranscribe: boolean
  setShowTranscribe: (show: boolean) => void
  showChat?: false | 'half' | 'full'
  setShowChat?: (mode: false | 'half' | 'full') => void
  viewMode: 'map' | 'preview'
  setViewMode: (mode: 'map' | 'preview') => void
}

export function MarkdownHeader({
  compact = false,
  currentTask,
  isMultiVersion,
  currentVerId,
  setCurrentVerId,
  modelName,
  style,
  noteStyles,
  createAt,
  showTranscribe,
  setShowTranscribe,
  showChat,
  setShowChat,
  viewMode,
  setViewMode,
}: NoteHeaderProps) {
  const reducedMotion = useInterfaceStore(state => state.reducedMotion)
  const task = useTaskStore(state => state.tasks.find(item => item.id === currentTask?.id))
  const [diagnosticsId, setDiagnosticsId] = useState<string | null>(null)
  const failed = task?.status === 'FAILED'
  const collapsed = compact && !failed
  const styleName = noteStyles.find(v => v.value === style)?.label || noteStyleLabel(style)

  const versions: VersionNote[] = Array.isArray(currentTask?.markdown)
    ? currentTask.markdown
    : []
  const versionIndex = Math.max(0, versions.findIndex(v => v.ver_id === currentVerId))
  const meta = [modelName, styleName, formatNoteTime(createAt)].filter(Boolean).join(' · ')

  return (
    <div className="workspace-note-header-motion" data-collapsed={collapsed} data-reduced-motion={reducedMotion} aria-hidden={collapsed} inert={collapsed}>
    <div className="workspace-note-header-clip">
    <div className="workspace-note-header note-header-row border-b bg-background">
      <div className="note-header-meta">
        {currentTask?.archived_at && <Badge variant="outline">已归档</Badge>}
        {isMultiVersion && versions.length > 1 && (
          <Select value={currentVerId} onValueChange={setCurrentVerId}>
            <SelectTrigger className="note-version-trigger" aria-label="笔记版本">
              <span className="truncate">{formatVersionLabel(versions[versionIndex], versionIndex, versions.length)}</span>
            </SelectTrigger>
            <SelectContent>
              {versions.map((v, index) => (
                <SelectItem key={v.ver_id} value={v.ver_id}>
                  <span className="flex flex-col gap-0.5">
                    <span>{formatVersionLabel(v, index, versions.length)}</span>
                    {v.model_name && <span className="text-[11px] text-muted-foreground">{v.model_name}</span>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="note-header-info" title={meta}>{meta}</span>
      </div>

      <div className="note-header-actions">
        {failed && <><span className="text-xs text-destructive">{task.cancelled ? '已取消生成' : '本次生成未完成'}</span><Button variant="outline" size="sm" className="h-8 px-2" onClick={() => setDiagnosticsId(task.id)}>诊断与恢复</Button><Button variant="ghost" size="sm" className="h-8 px-2" title="重新调用模型生成笔记，可能产生费用" disabled={Boolean(task.archived_at) || task.submissionInFlight} onClick={() => { void useTaskStore.getState().retryTask(task.id).catch((error: unknown) => { const failure = error as { msg?: string; message?: string }; toast.error(failure?.msg || failure?.message || '提交失败，请检查任务状态') }) }}>重新生成（调用模型）</Button></>}
        <Button onClick={() => setViewMode(viewMode == 'preview' ? 'map' : 'preview')} variant="ghost" size="sm" className="note-header-action" aria-pressed={viewMode === 'map'} title={viewMode == 'preview' ? '思维导图' : '返回正文'}>
          {viewMode == 'preview' ? <BrainCircuit className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
          <span>{viewMode == 'preview' ? '思维导图' : '正文'}</span>
        </Button>
        {setShowChat && <Button onClick={() => setShowChat(showChat ? false : 'half')} variant="ghost" size="sm" className="note-header-action" aria-pressed={Boolean(showChat)} title="AI 问答"><MessageSquare className="h-4 w-4" /><span>AI 问答</span></Button>}
        <Button onClick={() => setShowTranscribe(!showTranscribe)} variant="ghost" size="sm" className="note-header-action" aria-pressed={showTranscribe} title="原文参照"><ScrollText className="h-4 w-4" /><span>原文参照</span></Button>
      </div>
    </div>
    {task && diagnosticsId === task.id && <Suspense fallback={<p role="status">读取诊断…</p>}><GenerationDetailsDialog key={task.id} taskId={task.id} versionId={currentVerId} modelName={task.formData?.model_name || modelName} initialTab="diagnostics" allowComparison={false} onClose={() => setDiagnosticsId(null)} /></Suspense>}
    </div>
    </div>
  )
}
