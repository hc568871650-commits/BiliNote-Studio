import request from '@/utils/request' // 你项目里封装好的axios或者fetch
import type { AxiosRequestConfig } from 'axios'

export type UploadOptions = Pick<AxiosRequestConfig, 'signal' | 'timeout' | 'suppressToast' | 'onUploadProgress'>

export const uploadFile = (formData: FormData, options: UploadOptions = {}): Promise<{ url: string }> => {
  return request.post('/upload', formData, {
    timeout: 120000,
    ...options,
    // Let the browser supply the multipart boundary.
  }) as unknown as Promise<{ url: string }>
}
