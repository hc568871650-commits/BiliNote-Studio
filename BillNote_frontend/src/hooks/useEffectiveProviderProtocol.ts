import { useEffect } from 'react'
import { useProviderStore } from '@/store/providerStore'
import { useProviderProtocolStore } from '@/store/providerProtocolStore'
import { resolveProviderProtocol } from '@/utils/providerProfiles'

export function useEffectiveProviderProtocol(id?: string) {
  const preference = useProviderProtocolStore(state => state.protocols[id || ''])
  const provider = useProviderStore(state => state.provider.find(item => item.id === id))
  const fetchProviders = useProviderStore(state => state.fetchProviderList)
  useEffect(() => { if (id && !provider) void fetchProviders().catch(() => { /* Request layer reports failures. */ }) }, [id, provider, fetchProviders])
  return resolveProviderProtocol(provider?.baseUrl || '', preference)
}
