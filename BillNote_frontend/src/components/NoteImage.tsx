import { useContext, useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Maximize, X, ZoomIn, ZoomOut, MessageSquarePlus, Loader2 } from 'lucide-react'
import './note-image.css'
import { holdImageViewerWindowControls } from '@/store/imageViewerStore'
import { NoteImageChatContext } from './NoteImageChatContext'
import { readNoteImage } from '@/utils/noteImageAttachment'

type Picture = { src: string; alt: string; blockId?: string }
type Props = ImgHTMLAttributes<HTMLImageElement>
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value))

function ImageCanvas({ picture, onClose, action }: { picture: Picture; onClose: () => void; action?: (ready: boolean) => ReactNode }) {
  const stage = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 1, height: 1 })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const fit = natural.width ? Math.min(1, bounds.width / natural.width, bounds.height / natural.height) : 1
  const scale = fit * zoom
  const width = natural.width * scale
  const height = natural.height * scale
  const limitX = Math.max(0, (width - bounds.width) / 2)
  const limitY = Math.max(0, (height - bounds.height) / 2)
  const x = clamp(offset.x, limitX)
  const y = clamp(offset.y, limitY)
  const maxZoom = Math.max(4, 1 / fit)
  const changeZoom = (factor: number) => setZoom(value => Math.max(1, Math.min(maxZoom, value * factor)))
  const reset = () => { setZoom(1); setOffset({ x: 0, y: 0 }) }
  useEffect(() => {
    const node = stage.current
    if (!node) return
    const update = () => setBounds({ width: Math.max(1, node.clientWidth - 32), height: Math.max(1, node.clientHeight - 32) })
    const observer = new ResizeObserver(update)
    observer.observe(node); update()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const node = stage.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (natural.width && !failed && event.deltaY) setZoom(value => Math.max(1, Math.min(maxZoom, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15))))
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [maxZoom, natural.width, failed])
  const ready = natural.width > 0 && !failed
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!ready || event.ctrlKey || event.metaKey || event.altKey) return
      if (['+', '=', '-', '0'].includes(event.key)) {
        event.preventDefault()
        if (event.key === '0') { setZoom(1); setOffset({ x: 0, y: 0 }) }
        else setZoom(value => Math.max(1, Math.min(maxZoom, value * (event.key === '-' ? 1 / 1.25 : 1.25))))
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [ready, maxZoom])
  return <div className="note-image-view">
    <div className="note-image-stage" ref={stage} data-pannable={ready && (limitX > 0 || limitY > 0)}
      onClick={event => { if (event.target === event.currentTarget && zoom === 1) onClose() }}
      onDoubleClick={() => { if (ready) { if (zoom > 1) reset(); else setZoom(Math.min(maxZoom, Math.max(2, 1 / fit))) } }}
      onPointerDown={event => {
        if (!ready || event.button !== 0 || !(limitX || limitY)) return
        event.preventDefault()
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: x, oy: y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const start = drag.current
        if (start?.id === event.pointerId) setOffset({ x: clamp(start.ox + event.clientX - start.x, limitX), y: clamp(start.oy + event.clientY - start.y, limitY) })
      }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
      {!failed && <img key={attempt} src={picture.src} alt={picture.alt} draggable={false}
        onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setFailed(false) }}
        onError={() => setFailed(true)}
        style={{ width: ready ? width : undefined, height: ready ? height : undefined, opacity: ready ? 1 : 0, transform: `translate(${x}px, ${y}px)` }} onClick={event => event.stopPropagation()} />}
      {!ready && <div className="note-image-message" role="status">{failed ? <><span>图片加载失败</span><button type="button" onClick={() => { setFailed(false); setNatural({ width: 0, height: 0 }); reset(); setAttempt(value => value + 1) }}>重新加载</button></> : '图片加载中…'}</div>}
    </div>
    <div className="note-image-controls" role="toolbar" aria-label="图片缩放">
      <div className="note-image-zoom-group">
      <button type="button" aria-label="缩小图片" title="缩小（−）" disabled={!ready || zoom <= 1} onClick={() => changeZoom(1 / 1.25)}><ZoomOut /></button>
      <span aria-live="polite">{ready ? `${Math.round(scale * 100)}%` : '—'}</span>
      <button type="button" aria-label="放大图片" title="放大（+）" disabled={!ready || zoom >= maxZoom} onClick={() => changeZoom(1.25)}><ZoomIn /></button>
      </div>
      <button type="button" aria-label="图片原始尺寸" title="原始尺寸" disabled={!ready} onClick={() => { setZoom(1 / fit); setOffset({ x: 0, y: 0 }) }}>1:1</button>
      <button type="button" aria-label="图片适应窗口" title="适应窗口（0）" disabled={!ready} onClick={reset}><Maximize /></button>
      {action?.(ready)}
    </div>
  </div>
}

export default function NoteImage({ src = '', alt = '', ...props }: Props) {
  const chatTarget = useContext(NoteImageChatContext)
  const currentTarget = useRef(chatTarget)
  currentTarget.current = chatTarget
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pictures, setPictures] = useState<Picture[]>([])
  const [index, setIndex] = useState(0)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const close = () => { pending.current?.abort(); pending.current = null; setOpen(false); setAdding(false); setAddError('') }
  useEffect(() => {
    pending.current?.abort(); pending.current = null
    setAdding(false); setAddError(''); setOpen(false)
    return () => { pending.current?.abort(); pending.current = null }
  }, [chatTarget?.identity])
  useLayoutEffect(() => {
    if (open) return holdImageViewerWindowControls()
  }, [open])
  const show = () => {
    const buttons = Array.from(trigger.current?.closest('.markdown-body')?.querySelectorAll<HTMLButtonElement>('[data-note-image]') || [])
    const gallery = buttons.map(button => ({ src: button.dataset.noteImage || '', alt: button.querySelector('img')?.alt || '', blockId: button.closest<HTMLElement>('[data-note-block]')?.dataset.noteBlock }))
    const selected = buttons.indexOf(trigger.current!)
    setPictures(gallery.length ? gallery : [{ src, alt }]); setIndex(Math.max(0, selected)); setOpen(true)
  }
  const picture = pictures[index]
  const addToChat = async () => {
    const target = currentTarget.current
    if (!target || !picture || pending.current) return
    const controller = new AbortController(); pending.current = controller
    setAdding(true); setAddError('')
    try {
      const attachment = await readNoteImage({ ...picture, taskId: target.taskId, versionId: target.versionId, title: target.title }, controller.signal)
      if (controller.signal.aborted || currentTarget.current?.identity !== target.identity) return
      target.attach(attachment)
      close()
    } catch (error) {
      if (!controller.signal.aborted && currentTarget.current?.identity === target.identity) setAddError(error instanceof Error ? error.message : '图片未能加入，请重试')
    } finally {
      if (pending.current === controller) { pending.current = null; setAdding(false) }
    }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) close() }}>
    <Dialog.Trigger asChild><button ref={trigger} type="button" className="note-image-thumbnail" data-note-image={src} aria-label={`查看图片：${alt || '笔记截图'}`} onClick={event => { event.preventDefault(); show() }}>
      <img {...props} src={src} alt={alt} />
    </button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="note-image-backdrop" />
      <Dialog.Content className="note-image-dialog" aria-describedby={undefined} onEscapeKeyDown={event => event.stopPropagation()} onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation()
          if (adding) return
          setAddError('')
          setIndex(value => Math.max(0, Math.min(pictures.length - 1, value + (event.key === 'ArrowLeft' ? -1 : 1))))
        }
      }}>
        <header className="note-image-header"><Dialog.Title title={picture?.alt || '笔记截图'}>{picture?.alt || '笔记截图'}</Dialog.Title><span aria-live="polite">{index + 1} / {pictures.length}</span></header>
        <Dialog.Close className="note-image-close" aria-label="关闭看图" title="关闭看图（Esc）"><X /></Dialog.Close>
        {picture && <ImageCanvas key={`${index}:${picture.src}`} picture={picture} onClose={close} action={chatTarget ? ready => <button type="button" className="note-image-add-chat" disabled={!ready || adding} onClick={() => void addToChat()} title="只加入本篇问答草稿，不会发送">{adding ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />}<span>{adding ? '读取中…' : '加入问答'}</span></button> : undefined} />}
        {addError && <p className="note-image-add-error" role="alert">{addError}</p>}
        {pictures.length > 1 && <><button type="button" className="note-image-prev" aria-label="上一张图片" title="上一张（←）" disabled={adding || index === 0} onClick={() => { setAddError(''); setIndex(value => value - 1) }}><ChevronLeft /></button><button type="button" className="note-image-next" aria-label="下一张图片" title="下一张（→）" disabled={adding || index === pictures.length - 1} onClick={() => { setAddError(''); setIndex(value => value + 1) }}><ChevronRight /></button></>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
