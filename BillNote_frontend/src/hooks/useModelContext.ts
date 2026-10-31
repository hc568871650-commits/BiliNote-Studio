import { useCallback, useEffect, useState } from 'react'
import { cachedModelContext, defaultModelContext, getModelContext, modelContextKey, type ModelContextBudget } from '@/services/modelContext'

export default function useModelContext(providerId = '', modelName = '') {
  const key = modelContextKey(providerId, modelName)
  const [state, setState] = useState<{ key: string; budget: ModelContextBudget; loading: boolean; error: string }>({
    key, budget: cachedModelContext(providerId, modelName) || defaultModelContext(providerId, modelName), loading: true, error: '',
  })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    const cached = cachedModelContext(providerId, modelName)
    setState({ key, budget: cached || defaultModelContext(providerId, modelName), loading: Boolean(providerId && modelName), error: '' })
    if (providerId && modelName) void getModelContext(providerId, modelName, revision > 0).then(budget => {
      if (active) setState({ key, budget, loading: false, error: '' })
    }).catch((error: { msg?: string; message?: string }) => {
      if (active) setState(previous => ({ ...previous, loading: false, error: error.msg || error.message || '上下文设置读取失败' }))
    })
    return () => { active = false }
  }, [key, providerId, modelName, revision])
  useEffect(() => {
    const update = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key) return
      const budget = cachedModelContext(providerId, modelName)
      if (budget) setState({ key, budget, loading: false, error: '' })
    }
    window.addEventListener('bilinote-model-context-updated', update)
    return () => window.removeEventListener('bilinote-model-context-updated', update)
  }, [key, providerId, modelName])
  const reload = useCallback(() => setRevision(value => value + 1), [])
  return { ...(state.key === key ? state : { key, budget: defaultModelContext(providerId, modelName), loading: Boolean(providerId && modelName), error: '' }), reload }
}
