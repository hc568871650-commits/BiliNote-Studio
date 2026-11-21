import { useEffect } from 'react'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import DistillQueueToast from './DistillQueueToast'

/**
 * 全局蒸馏队列宿主：
 * 负责维护单一 SSE 连接生命周期并渲染右下角高透毛玻璃完成提醒浮卡。
 */
export default function DistillQueueHost() {
  useEffect(() => {
    return useDistillQueueStore.getState().connect()
  }, [])

  return <DistillQueueToast />
}
