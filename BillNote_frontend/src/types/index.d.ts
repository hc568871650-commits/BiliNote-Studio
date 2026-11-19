export interface IProvider {
  id: string
  name: string
  logo: string
  type: string
  apiKey: string
  baseUrl: string
  enabled: number
  protocol?: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini'
}
export interface IResponse<T> {
  code: number
  data:T
  msg: string
}