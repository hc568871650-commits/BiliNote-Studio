import { useEffect } from 'react'
import { modelSearchKey, useModelWebSearchStore } from '@/store/modelWebSearchStore'
import type { PurposeModelSelection } from '@/store/purposeModelStore'
import type { AISettings } from '@/utils/aiSettings'

export function useModelWebSearchSettings(model: PurposeModelSelection | null | undefined, settings: AISettings, ready = true, externalAvailable?: boolean): AISettings {
  const key = modelSearchKey(model?.provider_id, model?.model_name)
  const remembered = useModelWebSearchStore(state => key ? state.modes[key] : undefined)
  const defaultMode = externalAvailable === false ? 'native' : 'external'
  useEffect(() => {
    // An unresolved or failed capability request must not persist a false native
    // default. Existing model preferences always take precedence over availability.
    if (!ready || !key || !model || externalAvailable === undefined) return
    useModelWebSearchStore.getState().initializeMode(model.provider_id, model.model_name, defaultMode)
  }, [ready, key, model, defaultMode, externalAvailable])
  return { ...settings, web_search: true, web_search_mode: remembered ?? defaultMode }
}
