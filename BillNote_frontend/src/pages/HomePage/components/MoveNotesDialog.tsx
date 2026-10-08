import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { NoteFolder } from '@/services/noteFolders'

interface MoveNotesDialogProps {
  open: boolean
  folders: NoteFolder[]
  count: number
  busy: boolean
  onOpenChange: (open: boolean) => void
  onMove: (folderId: string) => void
}

const MoveNotesDialog = ({ open, folders, count, busy, onOpenChange, onMove }: MoveNotesDialogProps) => <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}>
  <DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
    <DialogHeader><DialogTitle>移动笔记</DialogTitle><DialogDescription>选择 {count} 篇笔记要放入的逻辑文件夹。</DialogDescription></DialogHeader>
    <div className="grid max-h-56 gap-2 overflow-y-auto py-1">
      {folders.map(folder => <Button key={folder.id} type="button" variant="outline" disabled={busy} className="min-w-0 max-w-full justify-start" onClick={() => onMove(folder.id)}><span className="min-w-0 truncate">{folder.name}</span></Button>)}
    </div>
    <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button></DialogFooter>
  </DialogContent>
</Dialog>

export default MoveNotesDialog
