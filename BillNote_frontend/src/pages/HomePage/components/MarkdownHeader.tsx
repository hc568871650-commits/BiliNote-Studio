'use client'

import { useEffect, useState } from 'react'
import { Copy, Download, BrainCircuit, MessageSquare, FolderOpen } from 'lucide-react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { toast } from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'

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
  }
  isMultiVersion: boolean
  currentVerId: string
  setCurrentVerId: (id: string) => void
  modelName: string
  style: string
  noteStyles: { value: string; label: string }[]
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
  onCopy,
  onDownload,
  createAt,
  showTranscribe,
  setShowTranscribe,
  showChat,
  setShowChat,
  viewMode,
  setViewMode,
}: NoteHeaderProps) {
  const [copied, setCopied] = useState(false)
  const [openingFolder, setOpeningFolder] = useState(false)

  const openFolder = async () => {
    if (!currentTask?.id || openingFolder) return
    setOpeningFolder(true)
    try {
      await invoke('open_note_folder', { taskId: currentTask.id })
    } catch (error) {
      toast.error(`无法打开教程文件夹：${String(error)}`)
    } finally {
      setOpeningFolder(false)
    }
  }

  useEffect(() => {
    let timer: NodeJS.Timeout
    if (copied) {
      timer = setTimeout(() => setCopied(false), 2000)
    }
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = () => {
    onCopy()
    setCopied(true)
  }

  const styleName = noteStyles.find(v => v.value === style)?.label || style

  const versions: VersionNote[] = Array.isArray(currentTask?.markdown)
    ? currentTask.markdown
    : []

  const formatDate = (date: string | Date | undefined) => {
    if (!date) return ''
    const d = typeof date === 'string' ? new Date(date) : date
    if (isNaN(d.getTime())) return ''
    return d
      .toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      .replace(/\//g, '-')
  }

  return (
    <div hidden={compact} className="workspace-note-header flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-background px-5 py-2">
      {/* 左侧区域：版本 + 标签 + 创建时间 */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {currentTask?.archived_at && <Badge variant="outline">已归档</Badge>}
        {isMultiVersion && (
          <Select value={currentVerId} onValueChange={setCurrentVerId}>
            <SelectTrigger className="h-8 w-[160px] text-sm">
              <div className="flex items-center">
                {(() => {
                  const idx = versions.findIndex(v => v.ver_id === currentVerId)
                  return idx !== -1 ? `版本（${currentVerId.slice(-6)}）` : ''
                })()}
              </div>
            </SelectTrigger>

            <SelectContent>
              {versions.map(v => {
                const shortId = v.ver_id.slice(-6)
                return (
                  <SelectItem key={v.ver_id} value={v.ver_id}>
                    {`版本（${shortId}）`}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        )}

        <Badge variant="secondary" className="max-w-48 truncate text-muted-foreground font-normal">
          {modelName}
        </Badge>
        <Badge variant="secondary" className="text-muted-foreground font-normal">
          {styleName}
        </Badge>

        {createAt && (
          <div className="text-muted-foreground text-[11px]">{formatDate(createAt)}</div>
        )}
      </div>

      {/* 右侧操作按钮 */}
      <div className="flex flex-wrap items-center gap-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => {
                  setViewMode(viewMode == 'preview' ? 'map' : 'preview')
                }}
                variant="ghost"
                size="sm"
                className="h-8 px-2"
              >
                <BrainCircuit className="mr-1.5 h-4 w-4" />
                <span className="text-sm">{viewMode == 'preview' ? '思维导图' : 'markdown'}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>思维导图</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {setShowChat && <Button onClick={() => setShowChat(showChat ? false : 'half')} variant="ghost" size="sm" className="h-8 px-2" aria-pressed={Boolean(showChat)} title="基于笔记内容的 AI 问答"><MessageSquare className="mr-1.5 h-4 w-4" /><span className="text-sm">AI 问答</span></Button>}
        <Button onClick={() => setShowTranscribe(!showTranscribe)} variant="ghost" size="sm" className="h-8 px-2" aria-pressed={showTranscribe} title="原文参照"><span className="text-sm">原文参照</span></Button>
        {isTauri() && currentTask?.id && <Button onClick={openFolder} disabled={openingFolder} variant="ghost" size="sm" className="h-8 px-2" title="在文件资源管理器中打开当前教程目录"><FolderOpen className="mr-1.5 h-4 w-4" /><span className="text-sm">{openingFolder ? '正在打开…' : '打开文件夹'}</span></Button>}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={handleCopy} variant="ghost" size="sm" className="h-8 px-2">
                <Copy className="mr-1.5 h-4 w-4" />
                <span className="text-sm">{copied ? '已复制' : '复制'}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>复制内容</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={onDownload} variant="ghost" size="sm" className="h-8 px-2">
                <Download className="mr-1.5 h-4 w-4" />
                <span className="text-sm">导出</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>下载为 Markdown 文件</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
