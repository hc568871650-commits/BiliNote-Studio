export interface ModelDisplayIdentity {
  provider_id?: string | number
  model_name: string
  display_name?: string | null
}

export function modelDisplayName(model: ModelDisplayIdentity): string {
  return model.display_name?.trim() || model.model_name
}

export function modelDisplayNameFor(
  models: readonly ModelDisplayIdentity[], providerId: string | number | undefined, modelName: string,
): string {
  const model = models.find(item => String(item.provider_id) === String(providerId) && item.model_name === modelName)
  return model ? modelDisplayName(model) : modelName
}
