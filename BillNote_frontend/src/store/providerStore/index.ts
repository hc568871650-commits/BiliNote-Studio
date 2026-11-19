import { create } from 'zustand'
import type { IProvider } from '@/types'
import { addProvider, deleteProviderById, getProviderById, getProviderList, updateProviderById } from '@/services/model'
import { useProviderProtocolStore, type ProviderProtocol } from '@/store/providerProtocolStore'

interface ProviderStore {
  provider: IProvider[]
  setProvider: (provider: IProvider) => void
  setAllProviders: (providers: IProvider[]) => void
  getProviderById: (id: string | number) => IProvider | undefined
  getProviderList: () => IProvider[]
  fetchProviderList: () => Promise<void>
  loadProviderById: (id: string) => Promise<IProvider>
  addNewProvider: (provider: Partial<IProvider>) => Promise<string>
  updateProvider: (provider: Partial<IProvider> & { id: string }) => Promise<void>
  deleteProvider: (id: string) => Promise<void>
}
interface RawProvider { id: string; name: string; logo: string; api_key: string; base_url: string; type: string; enabled: number; protocol?: ProviderProtocol }
const validProtocols = new Set<ProviderProtocol>(['openai-chat', 'openai-responses', 'anthropic', 'gemini'])
const normalizeProtocol = (value?: string): ProviderProtocol | undefined =>
  value && validProtocols.has(value as ProviderProtocol) ? (value as ProviderProtocol) : undefined
const normalize = (item: RawProvider): IProvider => ({
  id: String(item.id),
  name: item.name,
  logo: item.logo,
  apiKey: item.api_key,
  baseUrl: item.base_url,
  type: item.type,
  enabled: item.enabled,
  protocol: normalizeProtocol(item.protocol),
})
const syncProtocols = (items: IProvider[]) => {
  const setProtocol = useProviderProtocolStore.getState().setProtocol
  for (const item of items) {
    if (item.protocol) setProtocol(item.id, item.protocol)
  }
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
  provider: [],
  setProvider: provider => set(state => ({ provider: state.provider.some(item => item.id === provider.id) ? state.provider.map(item => item.id === provider.id ? provider : item) : [...state.provider, provider] })),
  setAllProviders: provider => set({ provider }),
  getProviderById: id => get().provider.find(provider => String(provider.id) === String(id)),
  getProviderList: () => get().provider,
  fetchProviderList: async () => {
    const list = await getProviderList() as unknown as RawProvider[]
    const normalized = list.map(normalize)
    syncProtocols(normalized)
    set({ provider: normalized })
  },
  loadProviderById: async id => {
    const item = normalize(await getProviderById(id) as unknown as RawProvider)
    if (item.protocol) useProviderProtocolStore.getState().setProtocol(item.id, item.protocol)
    return item
  },
  addNewProvider: async provider => {
    const result = await addProvider({
      ...provider,
      api_key: provider.apiKey || '',
      base_url: provider.baseUrl,
      protocol: provider.protocol,
    }) as unknown as string | { id: string }
    await get().fetchProviderList()
    const id = typeof result === 'string' ? result : result?.id
    if (!id) throw new Error('服务商已保存，但返回的标识为空，请刷新列表。')
    return String(id)
  },
  updateProvider: async provider => {
    const merged = { ...get().getProviderById(provider.id), ...provider }
    await updateProviderById({
      ...merged,
      api_key: merged.apiKey,
      base_url: merged.baseUrl,
      protocol: merged.protocol,
    })
    await get().fetchProviderList()
  },
  deleteProvider: async id => {
    await deleteProviderById(id)
    await get().fetchProviderList()
  },
}))
