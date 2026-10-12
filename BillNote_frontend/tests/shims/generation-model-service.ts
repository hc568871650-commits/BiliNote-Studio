export const modelCalls: number[] = []
type Model = { id: string; provider_id: string; model_name: string }
export const deferredModels: { resolve: (models: Model[]) => void; reject: (error: Error) => void }[] = []
export const fetchEnableModels = () => { modelCalls.push(Date.now()); return new Promise<Model[]>((resolve, reject) => deferredModels.push({ resolve, reject })) }
export const fetchModels = async () => ({ models: [] })
export const fetchEnableModelById = async () => []
export const addModel = async () => ({ code: 0 })
export const deleteModelById = async () => undefined
