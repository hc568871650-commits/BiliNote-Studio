import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from 'next-themes'
import {
  BookMarked,
  FileText,
  HardDrive,
  Hash,
  Moon,
  PlusCircle,
  Search,
  Settings2,
  Sparkles,
  Sun,
} from 'lucide-react'
import { useTaskStore } from '@/store/taskStore'
import { useCreateNoteDraftStore } from '@/store/createNoteDraftStore'
import { useSourceNavigationStore } from '@/store/sourceNavigationStore'
import { searchLibrary, type LibrarySearchHit } from '@/services/librarySearch'
import { readSystemClipboardText } from '@/hooks/useQuickCapture'
import { extractShareInput } from '@/utils/sourceUrl'
import { scrollToChapter } from '@/utils/noteOutline'
import { scrollMotion } from '@/utils/motion'
import './command-palette.css'

interface PaletteItem {
  id: string
  group: 'actions' | 'chapters' | 'notes' | 'content'
  label: string
  subtitle?: string
  keywords?: string
  icon: ReactNode
  run: () => void | Promise<void>
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const GROUP_TITLES: Record<PaletteItem['group'], string> = {
  actions: '快捷指令',
  chapters: '当前笔记章节',
  notes: '本地笔记',
  content: '正文搜索命中',
}

export default function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  const tasks = useTaskStore(state => state.tasks)
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [contentHits, setContentHits] = useState<LibrarySearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setContentHits([])
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // 输入 >= 2 字符时防抖检索后端正文，覆盖笔记全文直达
  useEffect(() => {
    const trimmed = query.trim()
    if (!open || trimmed.length < 2) {
      setContentHits([])
      return
    }
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => {
      void searchLibrary({ query: trimmed, scope: 'all', offset: 0, limit: 6 }, ctrl.signal)
        .then(page => {
          if (!ctrl.signal.aborted) {
            setContentHits(page.results || [])
          }
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setContentHits([])
        })
    }, 180)
    return () => {
      window.clearTimeout(timer)
      ctrl.abort()
    }
  }, [open, query])

  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  const openCreateWithClipboard = useCallback(async () => {
    close()
    const clip = await readSystemClipboardText()
    const parsed = clip ? extractShareInput(clip) : null
    if (parsed?.url && parsed.platform) {
      const prev = useCreateNoteDraftStore.getState()
      prev.update({
        values: { ...prev.values, video_url: parsed.url, platform: parsed.platform },
      })
    }
    navigate('/?view=create')
  }, [close, navigate])

  const chapterItems = useMemo<PaletteItem[]>(() => {
    if (!open || typeof document === 'undefined') return []
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.markdown-body [data-note-heading]'))
    return nodes.slice(0, 24).map((el, idx) => {
      const label = (el.dataset.noteLabel || el.textContent || `章节 ${idx + 1}`).trim()
      return {
        id: `chapter:${el.id || idx}`,
        group: 'chapters',
        label,
        subtitle: '跳转到当前笔记章节',
        keywords: `章节 ${label}`,
        icon: <Hash size={13} strokeWidth={1.7} />,
        run: () => {
          close()
          scrollToChapter(el, scrollMotion())
        },
      }
    })
  }, [open, currentTaskId, close])

  const actionItems = useMemo<PaletteItem[]>(() => {
    const isDark = resolvedTheme === 'dark'
    return [
      {
        id: 'action:new-note',
        group: 'actions',
        label: '新建笔记（自动识别剪贴板链接）',
        subtitle: '支持 B 站 / YouTube / X / 小宇宙 / 网页 / 本地文档',
        keywords: 'new create 新建 粘贴 剪贴板 蒸馏',
        icon: <PlusCircle size={14} strokeWidth={1.7} />,
        run: openCreateWithClipboard,
      },
      {
        id: 'action:review-bank',
        group: 'actions',
        label: '打开复习本（错题与高频避坑）',
        subtitle: '查看今日到期复习或发起专题小测',
        keywords: 'review srs 复习 错题 避坑 自测',
        icon: <BookMarked size={14} strokeWidth={1.7} />,
        run: () => {
          close()
          navigate('/?view=read')
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('bilinote-open-review-bank')), 40)
        },
      },
      {
        id: 'action:toggle-theme',
        group: 'actions',
        label: isDark ? '切换为浅色模式' : '切换为深色模式',
        subtitle: '立即切换外观深浅主题',
        keywords: 'theme dark light 主题 浅色 深色 外观',
        icon: isDark ? <Sun size={14} strokeWidth={1.7} /> : <Moon size={14} strokeWidth={1.7} />,
        run: () => {
          setTheme(isDark ? 'light' : 'dark')
          close()
        },
      },
      {
        id: 'action:storage',
        group: 'actions',
        label: '打开存储与维护（清理缓存 / 整库备份）',
        subtitle: '查看空间占用、导出 .zip 备份或恢复',
        keywords: 'storage backup restore cache 存储 清理 备份 恢复',
        icon: <HardDrive size={14} strokeWidth={1.7} />,
        run: () => {
          close()
          navigate('/settings/storage')
        },
      },
      {
        id: 'action:settings',
        group: 'actions',
        label: '打开设置',
        subtitle: '模型、语言、下载与常规偏好',
        keywords: 'settings config 设置 模型 常规',
        icon: <Settings2 size={14} strokeWidth={1.7} />,
        run: () => {
          close()
          navigate('/settings/general')
        },
      },
    ]
  }, [close, navigate, openCreateWithClipboard, resolvedTheme, setTheme])

  const noteItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()
    const activeNotes = tasks.filter(t => !t.archived_at)
    const matched = q
      ? activeNotes.filter(t => {
          const title = (t.audioMeta?.title || t.id).toLowerCase()
          const platform = (t.audioMeta?.platform || t.formData?.platform || '').toLowerCase()
          return title.includes(q) || platform.includes(q)
        })
      : activeNotes
    return matched.slice(0, q ? 12 : 6).map(t => ({
      id: `note:${t.id}`,
      group: 'notes',
      label: t.audioMeta?.title || t.id,
      subtitle: t.audioMeta?.platform || t.formData?.platform || '笔记',
      icon: <FileText size={13} strokeWidth={1.65} />,
      run: () => {
        useTaskStore.getState().setCurrentTask(t.id)
        close()
        navigate('/?view=read')
      },
    }))
  }, [tasks, query, close, navigate])

  const filteredItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()
    const matchText = (item: PaletteItem) =>
      !q
      || item.label.toLowerCase().includes(q)
      || (item.subtitle || '').toLowerCase().includes(q)
      || (item.keywords || '').toLowerCase().includes(q)

    const actions = actionItems.filter(matchText)
    const chapters = chapterItems.filter(matchText).slice(0, 8)
    const content: PaletteItem[] = contentHits
      .filter(hit => hit.match_kind === 'body')
      .map((hit, idx) => ({
        id: `hit:${hit.note_id}:${hit.section_id}:${idx}`,
        group: 'content',
        label: hit.title || hit.note_id,
        subtitle: `${hit.section_title ? `${hit.section_title} · ` : ''}${hit.excerpt}`,
        icon: <Sparkles size={13} strokeWidth={1.65} />,
        run: () => {
          useTaskStore.getState().setCurrentTask(hit.note_id)
          useSourceNavigationStore.getState().open({
            note_id: hit.note_id,
            version_id: hit.version_id || undefined,
            section_id: hit.section_id || undefined,
            section_title: hit.section_title || undefined,
            text: hit.match_text || hit.text,
          })
          close()
          navigate('/?view=read')
        },
      }))

    return [...(q ? [] : actions), ...chapters, ...noteItems, ...content, ...(q ? actions : [])]
  }, [actionItems, chapterItems, contentHits, noteItems, query, close, navigate])

  useEffect(() => {
    setActiveIndex(0)
  }, [query, filteredItems.length])

  if (!open) return null

  const groups: Array<{ group: PaletteItem['group']; items: Array<{ item: PaletteItem; flatIndex: number }> }> = []
  filteredItems.forEach((item, flatIndex) => {
    let bucket = groups.find(g => g.group === item.group)
    if (!bucket) {
      bucket = { group: item.group, items: [] }
      groups.push(bucket)
    }
    bucket.items.push({ item, flatIndex })
  })

  return (
    <div
      className="cmd-palette-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="全局命令面板"
      onClick={close}
    >
      <div className="cmd-palette-shell" onClick={e => e.stopPropagation()}>
        <div className="cmd-palette-input-row">
          <Search size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            className="cmd-palette-input"
            placeholder="搜索笔记、正文片段、当前章节或输入指令…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex(i => (filteredItems.length ? (i + 1) % filteredItems.length : 0))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex(i => (filteredItems.length ? (i - 1 + filteredItems.length) % filteredItems.length : 0))
              } else if (event.key === 'Enter' && filteredItems[activeIndex]) {
                event.preventDefault()
                void filteredItems[activeIndex].run()
              }
            }}
          />
          <kbd className="cmd-palette-kbd">Esc</kbd>
        </div>

        <div className="cmd-palette-list" role="listbox" aria-label="命令与搜索结果">
          {filteredItems.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">没有匹配的笔记或快捷指令</p>
          ) : (
            groups.map(({ group, items }) => (
              <div key={group} className="mb-1.5 last:mb-0">
                <div className="cmd-palette-group-title">{GROUP_TITLES[group]}</div>
                {items.map(({ item, flatIndex }) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={flatIndex === activeIndex}
                    className={`cmd-palette-item${flatIndex === activeIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => void item.run()}
                  >
                    <span className="cmd-palette-item-main">
                      <span className="cmd-palette-item-icon">{item.icon}</span>
                      <span className="cmd-palette-item-text">
                        <span className="cmd-palette-item-label">{item.label}</span>
                        {item.subtitle && <span className="cmd-palette-item-sub">{item.subtitle}</span>}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="cmd-palette-footer">
          <span>↑↓ 移动 · Enter 执行 · Esc 关闭</span>
          <span>Ctrl+K / Cmd+K</span>
        </div>
      </div>
    </div>
  )
}
