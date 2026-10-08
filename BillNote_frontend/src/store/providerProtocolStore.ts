import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'
export type Protocol = ProviderProtocol
export const providerProtocolOptions: { value: ProviderProtocol; label: string }[] = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions（默认）' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]
interface ProviderProtocolStore {
  protocols: Record<string, ProviderProtocol>
  setProtocol: (id: string, protocol: ProviderProtocol) => void
}
// Protocol preferences only; never persist provider URLs or credentials here.
export const useProviderProtocolStore = create<ProviderProtocolStore>()(persist(set => ({
  protocols: {},
  setProtocol: (id, protocol) => set(state => ({ protocols: { ...state.protocols, [id]: protocol } })),
}), { name: 'bilinote-provider-protocols-v1', partialize: state => ({ protocols: state.protocols }) }))
