import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  fetchModels,
  addModel,
  fetchEnableModels,
  fetchEnableModelById,
  deleteModelById
} from '@/services/model'

interface IModel {
  id: string
  created: number
  object: string
  owned_by: string
  permission: string
  root: string
}

interface IModelListItem {
  id: string
  provider_id: string
  model_name: string
  created_at?: string
}

interface ModelStore {
  models: IModel[]
  modelList: IModelListItem[]
  loading: boolean
  selectedModel: string
  enabledLoading: boolean
  enabledError: string

  loadModels: (providerId: string) => Promise<void>
  loadModelsById: (providerId: string) => Promise<IModelListItem[]>
  loadEnabledModels: (options?: { force?: boolean }) => Promise<void>
  addNewModel: (providerId: string, modelId: string) => Promise<void>
  deleteModel: (modelId: number) => Promise<void>
  setSelectedModel: (modelId: string) => void
  clearModels: () => void
}

let enabledRequest: Promise<void> | null = null
let enabledLoadedAt = 0

export const useModelStore = create<ModelStore>()(
  devtools((set, get) => ({
    models: [],
    modelList: [],
    loading: false,
    selectedModel: '',
    enabledLoading: false,
    enabledError: '',

    //  获取所有可用模型 (全局可用模型列表)
    loadEnabledModels: async (options = {}) => {
      if (enabledRequest) return enabledRequest
      if (!options.force && enabledLoadedAt && Date.now() - enabledLoadedAt < 30000 && get().modelList.length) return
      enabledRequest = (async () => {
        set({ enabledLoading: true, enabledError: '' })
        try {
          const list = await fetchEnableModels({ silent: true })
          enabledLoadedAt = Date.now()
          set({ modelList: list })
        } catch {
          set({ enabledError: '模型列表暂时未能更新，可重试加载' })
        } finally {
          set({ enabledLoading: false })
          enabledRequest = null
        }
      })()
      return enabledRequest
    },

    //  通过 provider 获取该供应商的模型列表
    loadModels: async (providerId: string) => {
      try {
        set({ loading: true })
        const res = await fetchModels(providerId)

        let models: IModel[] = []

        // 兼容 SyncPage 分页对象与普通数组两种格式
        if (Array.isArray(res.models)) {
          models = res.models
        } else if (res.models?.data && Array.isArray(res.models.data)) {
          models = res.models.data
        }

        set({ models })
      } catch (error) {
        set({ models: [] })
        console.error('加载模型列表失败', error)
      } finally {
        set({ loading: false })
      }
    },

    //  单独获取某个供应商下已启用模型
    loadModelsById: async (providerId: string) => {
      try {
        const models = await fetchEnableModelById(providerId)
        console.log('获取供应商模型成功:', models)
        return models
      } catch (error) {
        console.error('加载供应商模型失败', error)
        return []
      }
    },

    //  新增模型逻辑
    addNewModel: async (providerId: string, modelId: string) => {
      try {
        const res = await addModel({ provider_id: providerId, model_name: modelId })
        enabledLoadedAt = 0

        if (res.code === 0) {
          console.log('新增模型成功:', modelId)
          set((state) => ({
            models: [
              ...state.models,
              {
                id: modelId,
                created: Date.now(),
                object: 'model',
                owned_by: '',
                permission: '',
                root: '',
              },
            ],
          }))
        } else {
          console.error('新增模型失败', res.msg)
        }
      } catch (error) {
        console.error('添加模型出错', error)
      }
    },

    //  删除模型
    deleteModel: async (modelId: number) => {
      try {
        await deleteModelById(modelId)
        enabledLoadedAt = 0
        //  删除后更新本地状态（可选）
        set((state) => ({
          models: state.models.filter((model) => model.id !== modelId.toString())
        }))
      } catch (error) {
        console.error('删除模型失败', error)
      }
    },

    //  切换选中模型
    setSelectedModel: (modelId: string) => set({ selectedModel: modelId }),

    //  清空
    clearModels: () => { enabledLoadedAt = 0; set({ models: [], selectedModel: '', modelList: [] }) },
  }))
)
