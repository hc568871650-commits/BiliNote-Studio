import request from '@/utils/request' // 你项目里封装好的axios或者fetch
import type { AxiosRequestConfig } from 'axios'

export type UploadOptions = Pick<AxiosRequestConfig, 'signal' | 'timeout' | 'suppressToast' | 'onUploadProgress'>

export interface UploadFileResponse {
  url: string
  filename?: string
  is_subtitle?: boolean
  is_document?: boolean
}

export const uploadFile = (formData: FormData, options: UploadOptions = {}): Promise<UploadFileResponse> => {
  return request.post('/upload', formData, {
    timeout: 120000,
    ...options,
    // Let the browser supply the multipart boundary.
  }) as unknown as Promise<UploadFileResponse>
}
