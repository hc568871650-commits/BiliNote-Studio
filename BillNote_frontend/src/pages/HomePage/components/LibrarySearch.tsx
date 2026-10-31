import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Search, X, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { searchLibrary, type LibrarySearchHit } from '@/services/librarySearch'
import { useLibrarySearchStore } from '@/store/librarySearchStore'
import { DEFAULT_FOLDER_ID, ALL_FOLDER_ID, useFolderStore } from '@/store/folderStore'
import { openNoteSource } from '@/utils/openNoteSource'
import toast from 'react-hot-toast'
import ChoiceSelect from '@/components/ChoiceSelect'
import { plainExcerpt } from '@/utils/plainExcerpt'

function HitExcerpt({ hit }: { hit: LibrarySearchHit }) {
  const full = plainExcerpt(hit.excerpt || hit.text)
  const index = full.indexOf(hit.match_text)
  const start = Math.max(0, index - 35)
  const excerpt = full.slice(start, Math.max(start + 170, index + hit.match_text.length))
  const at = index - start
  return <span className="mt-1 break-words text-[11px] leading-relaxed text-muted-foreground" style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>
    {start > 0 && '…'}{index < 0 ? excerpt : <>{excerpt.slice(0, at)}<mark className="bg-primary/10 text-foreground">{hit.match_text}</mark>{excerpt.slice(at + hit.match_text.length)}</>}{start + excerpt.length < full.length && '…'}
  </span>
}

export default function LibrarySearch({ onSelect }: { onSelect: (id: string) => void }) {
  const state = useLibrarySearchStore()
  const folderId = useFolderStore(s => s.selectedFolderId)
  const folders = useFolderStore(s => s.folders)
  const viewport = useRef<HTMLDivElement>(null)
  const openEpoch = useRef(0)
  const [opening, setOpening] = useState<string | null>(null)
  const query = state.query.trim()
  const active = Boolean(query)
  const scopeName = folders.find(folder => folder.id === state.folderId)?.name || '默认文件夹'
  useEffect(() => () => { ++openEpoch.current }, [])

  useEffect(() => {
    if (!query || useLibrarySearchStore.getState().page) return
    const controller = new AbortController()
    const revision = state.revision
    const timer = window.setTimeout(() => {
      useLibrarySearchStore.setState({ loading: true, error: '' })
      void searchLibrary({ query, scope: state.scope, ...(state.scope === 'folder' ? { folder_id: state.folderId } : {}), offset: state.offset, limit: 20 }, controller.signal)
        .then(page => { if (!controller.signal.aborted && useLibrarySearchStore.getState().revision === revision) useLibrarySearchStore.setState({ page, loading: false }) })
        .catch(error => { if (!controller.signal.aborted && useLibrarySearchStore.getState().revision === revision) useLibrarySearchStore.setState({ loading: false, error: error?.msg || error?.message || '查找失败，请重试' }) })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, state.scope, state.folderId, state.offset, state.revision])
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = useLibrarySearchStore.getState().scrollTop
  }, [state.page])

  const open = async (hit: LibrarySearchHit) => {
    if (opening) return
    setOpening(hit.source_id)
    const epoch = openEpoch.current
    const revision = state.revision
    const valid = () => openEpoch.current === epoch && useLibrarySearchStore.getState().revision === revision
    try {
      const opened = await openNoteSource({ source_type: 'note', ...hit,
        ...(hit.match_kind === 'body' ? { search_match: { start: hit.match_start_utf16, end: hit.match_end_utf16, text: hit.match_text } } : { metadata_only: true }) }, valid)
      if (opened) { useLibrarySearchStore.setState({ selectedId: hit.note_id }); onSelect(hit.note_id) }
    } catch (error) {
      const item = error as { msg?: string; message?: string }
      if (valid()) toast.error(item.msg || item.message || '来源已删除或不可读取，请重新查找')
    } finally { setOpening(null) }
  }
  return <div className={active ? 'flex min-h-0 flex-1 flex-col gap-2' : 'shrink-0'} data-library-search>
    <div className="flex shrink-0 items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {/* type="text": WebView2 adds its own clear button to type="search", duplicating ours. */}
      <input type="text" role="searchbox" enterKeyHint="search" aria-label="全文查找" placeholder="查找标题或正文…" maxLength={500} className="select-text h-8 min-w-0 flex-1 bg-transparent text-xs outline-none" value={state.query} onChange={event => state.change({ query: event.target.value })} onKeyDown={event => { if (event.key === 'Escape' && state.query) state.change({ query: '' }) }} />
      {state.query && <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" title="清除查找（Esc）" aria-label="清除查找" onClick={() => state.change({ query: '' })}><X size={13} /></button>}
    </div>
    {active && <>
      <div className="flex shrink-0 items-center gap-2 text-xs">
        <ChoiceSelect label="查找范围" className="choice-compact" menuClassName="choice-menu-compact" value={state.scope} onChange={value => state.change({ scope: value as 'all' | 'folder', folderId: folderId === ALL_FOLDER_ID ? DEFAULT_FOLDER_ID : folderId })}
          options={[{ value: 'all', label: '全库（含归档）' }, { value: 'folder', label: `当前文件夹 · ${scopeName}` }]} displayValue={state.scope === 'folder' ? scopeName : '全库（含归档）'} />
        {state.error && <button type="button" className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => state.change({})}>重试</button>}
      </div>
      <div role="status" className="shrink-0 text-[11px] text-muted-foreground">
        {state.loading || (!state.page && !state.error) ? '查找中…' : state.error || `${state.page?.total || 0} 篇`}
        {Boolean(state.page?.warning_count) && <span className="block">{state.page!.warning_count} 篇不可读取，已跳过</span>}
      </div>
      <div ref={viewport} data-search-results className="min-h-0 flex-1 overflow-y-auto overscroll-contain" onScroll={event => useLibrarySearchStore.setState({ scrollTop: event.currentTarget.scrollTop })}>
        {state.page?.total === 0 && <p className="py-5 text-center text-xs text-muted-foreground">没有匹配的笔记</p>}
        {state.page?.results.map(hit => <button type="button" key={hit.source_id} data-search-hit={hit.note_id} aria-current={state.selectedId === hit.note_id ? 'true' : undefined} disabled={Boolean(opening)} onClick={() => void open(hit)} className={`mb-1 block w-full rounded-md px-2 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${state.selectedId === hit.note_id ? 'note-row-current' : ''}`}>
          <span className="block truncate text-xs font-medium">{opening === hit.source_id && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}{hit.title}</span>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">{hit.folder_name}{hit.archived ? ' · 已归档' : ''}{hit.match_kind === 'title' ? ' · 标题命中' : ''}</span>
          <HitExcerpt hit={hit} />
        </button>)}
      </div>
      {state.page && (state.offset > 0 || state.page.has_more) && <div className="flex shrink-0 items-center justify-between text-xs">
        <button type="button" disabled={!state.offset} aria-label="上一页查找结果" onClick={() => state.change({ offset: Math.max(0, state.offset - 20) })}><ChevronLeft size={16} /></button>
        <span>{state.offset + 1}–{state.offset + state.page.returned} / {state.page.total}</span>
        <button type="button" disabled={!state.page.has_more} aria-label="下一页查找结果" onClick={() => state.change({ offset: state.page!.next_offset! })}><ChevronRight size={16} /></button>
      </div>}
    </>}
  </div>
}
