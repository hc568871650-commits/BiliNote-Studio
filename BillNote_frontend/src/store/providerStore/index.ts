import { create } from 'zustand'
import type { IProvider } from '@/types'
import { addProvider, getProviderById, getProviderList, updateProviderById } from '@/services/model'

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
}
interface RawProvider { id: string; name: string; logo: string; api_key: string; base_url: string; type: string; enabled: number }
const normalize = (item: RawProvider): IProvider => ({ id: String(item.id), name: item.name, logo: item.logo, apiKey: item.api_key, baseUrl: item.base_url, type: item.type, enabled: item.enabled })

export const useProviderStore = create<ProviderStore>((set, get) => ({
  provider: [],
  setProvider: provider => set(state => ({ provider: state.provider.some(item => item.id === provider.id) ? state.provider.map(item => item.id === provider.id ? provider : item) : [...state.provider, provider] })),
  setAllProviders: provider => set({ provider }),
  getProviderById: id => get().provider.find(provider => String(provider.id) === String(id)),
  getProviderList: () => get().provider,
  fetchProviderList: async () => {
    const list = await getProviderList() as unknown as RawProvider[]
    set({ provider: list.map(normalize) })
  },
  loadProviderById: async id => normalize(await getProviderById(id) as unknown as RawProvider),
  addNewProvider: async provider => {
    const result = await addProvider({ ...provider, api_key: provider.apiKey || '', base_url: provider.baseUrl }) as unknown as string | { id: string }
    await get().fetchProviderList()
    const id = typeof result === 'string' ? result : result?.id
    if (!id) throw new Error('服务商已保存，但返回的标识为空，请刷新列表。')
    return String(id)
  },
  updateProvider: async provider => {
    const merged = { ...get().getProviderById(provider.id), ...provider }
    await updateProviderById({ ...merged, api_key: merged.apiKey, base_url: merged.baseUrl })
    await get().fetchProviderList()
  },
}))
