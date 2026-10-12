import { useCallback, useEffect, useRef, useState } from 'react'
import { capabilityErrorMessage, getModelCapabilities, type ModelCapabilityRecord } from '@/services/modelCapabilities'
import type { ProviderProtocol } from '@/store/providerProtocolStore'

const requests = new Map<string, Promise<ModelCapabilityRecord>>()
let generation = 0
const load = (providerId: string, modelName: string, protocol: ProviderProtocol) => {
  const key = JSON.stringify([generation, providerId, modelName, protocol])
  const existing = requests.get(key)
  if (existing) return existing
  const promise = getModelCapabilities(providerId, modelName, protocol)
  requests.set(key, promise)
  void promise.finally(() => { if (requests.get(key) === promise) requests.delete(key) }).catch(() => undefined)
  return promise
}
const invalidate = () => { generation += 1; requests.clear() }
if (typeof window !== 'undefined') {
  window.addEventListener('user-save-provider', invalidate)
  window.addEventListener('bilinote-capabilities-updated', invalidate)
}

export function useModelCapabilities(providerId?: string, modelName?: string, protocol: ProviderProtocol = 'openai-chat') {
  const [capabilities, setCapabilities] = useState<ModelCapabilityRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++revision.current
    if (!providerId || !modelName) { setCapabilities(null); setLoading(false); setError(null); return }
    setLoading(true); setError(null)
    try {
      const result = await load(providerId, modelName, protocol)
      if (current === revision.current) setCapabilities(result)
    } catch (failure) {
      if (current === revision.current) { setCapabilities(null); setError(capabilityErrorMessage(failure)) }
    } finally { if (current === revision.current) setLoading(false) }
  }, [providerId, modelName, protocol])
  useEffect(() => {
    setCapabilities(null)
    void refresh()
    const update = () => { void refresh() }
    window.addEventListener('user-save-provider', update)
    window.addEventListener('bilinote-capabilities-updated', update)
    return () => {
      revision.current += 1
      window.removeEventListener('user-save-provider', update)
      window.removeEventListener('bilinote-capabilities-updated', update)
    }
  }, [refresh])
  return { capabilities, loading, error, refresh }
}
