import { useProviderStore } from '@/store/providerStore'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import { resolveProviderProtocol } from '@/utils/providerProfiles'

// Wait for a real provider URL before sending, including a cold-start first request.
export async function withProviderProtocol<T extends { provider_id: string; protocol?: ProviderProtocol }>(payload: T) {
  const store = useProviderStore.getState()
  const provider = store.getProviderById(payload.provider_id) || await store.loadProviderById(payload.provider_id)
  return { ...payload, protocol: resolveProviderProtocol(provider.baseUrl, payload.protocol) }
}
