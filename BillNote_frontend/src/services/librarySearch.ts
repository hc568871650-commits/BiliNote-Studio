import request from '@/utils/request'

export interface LibrarySearchHit {
  note_id: string
  title: string
  archived: boolean
  folder_id: string
  folder_name: string
  version_id: string
  source_id: string
  section_id: string
  section_title: string
  text: string
  excerpt: string
  match_kind: 'title' | 'body'
  match_text: string
  match_start_utf16: number
  match_end_utf16: number
}
export interface LibrarySearchPage {
  results: LibrarySearchHit[]
  total: number
  returned: number
  has_more: boolean
  next_offset: number | null
  warning_count: number
}
export const searchLibrary = (params: { query: string; scope: 'all' | 'folder'; folder_id?: string; offset: number; limit: number }, signal: AbortSignal) =>
  request.get('/library/search', { params, signal, suppressToast: true, timeout: 30000 }) as unknown as Promise<LibrarySearchPage>
