import { create } from 'zustand'
import type { LibrarySearchPage } from '@/services/librarySearch'

interface SearchState {
  query: string
  scope: 'all' | 'folder'
  folderId: string
  page: LibrarySearchPage | null
  offset: number
  scrollTop: number
  selectedId: string | null
  error: string
  loading: boolean
  revision: number
  change: (values: Partial<Pick<SearchState, 'query' | 'scope' | 'folderId' | 'offset'>>) => void
}
// Keep the result page and its position when the reader/sidebar is remounted.
export const useLibrarySearchStore = create<SearchState>((set) => ({
  query: '', scope: 'all', folderId: 'default', page: null, offset: 0, scrollTop: 0,
  selectedId: null, error: '', loading: false, revision: 0,
  change: values => set(state => ({ ...values, page: null, offset: values.offset ?? 0,
    scrollTop: 0, error: '', loading: false, revision: state.revision + 1 })),
}))
