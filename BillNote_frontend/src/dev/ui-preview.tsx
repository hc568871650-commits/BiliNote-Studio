import { createRoot } from 'react-dom/client'
import request from '@/utils/request'
import RootLayout from '@/layouts/RootLayout'
import PreviewApp from './PreviewApp'
import { getPreviewTasks, previewAdapter, previewDefaultModels, resetPreviewData, PREVIEW_DEFAULTS_KEY } from './previewMock'
import '@/index.css'
import { graphPreview, graphPreviewAdapter, loadGraphPreview } from './graphPreviewAdapter'
import { setChatStreamTransport } from '@/services/chatStream'
import { previewChatStream } from './previewChatStream'

// This entry is never imported by main.tsx. All API requests use synthetic local data.
request.defaults.adapter = graphPreview ? graphPreviewAdapter : previewAdapter
setChatStreamTransport(graphPreview ? async () => { throw new Error('此环境只验证整理流程，请返回交互预览试用阅读聊天') } : previewChatStream)
const { useTaskStore } = await import('@/store/taskStore')
await useTaskStore.persist.rehydrate()
let tasks = getPreviewTasks()
let startupError = ''
if (graphPreview) {
  try { tasks = await loadGraphPreview() }
  catch (error) { startupError = error instanceof Error ? error.message : '独立测试服务连接失败'; tasks = [] }
}
const currentTaskId = useTaskStore.getState().currentTaskId
useTaskStore.setState({ tasks, currentTaskId: tasks.some(task => task.id === currentTaskId) ? currentTaskId : tasks.find(task => task.status === 'SUCCESS' && !task.archived_at)?.id || null })
const { usePurposeModelStore } = await import('@/store/purposeModelStore')
await usePurposeModelStore.persist.rehydrate()
if (!localStorage.getItem(PREVIEW_DEFAULTS_KEY)) {
  usePurposeModelStore.setState({ defaults: previewDefaultModels })
  localStorage.setItem(PREVIEW_DEFAULTS_KEY, '1')
}
const { useFolderStore } = await import('@/store/folderStore')
useFolderStore.getState().selectFolder(localStorage.getItem('bilinote-selected-folder') || 'all')
window.addEventListener('bilinote-preview-reset', () => {
  void resetPreviewData(async () => {
    const { useReadingAssistantStore } = await import('@/store/readingAssistantStore')
    await Promise.all([useReadingAssistantStore.persist.clearStorage(), useTaskStore.persist.clearStorage()])
  }).catch(error => { console.error('重置预览失败', error); window.alert('预览数据未能完全重置，请稍后重试。') })
})
createRoot(document.getElementById('root')!).render(<RootLayout>{startupError ? <main className="p-10"><h1 className="text-xl">整理助手测试服务尚未就绪</h1><p className="my-4">{startupError}</p><p className="my-4">此页面只连接独立的示例服务，不会转接正式安装。</p><button className="rounded border px-4 py-2" onClick={() => location.reload()}>重新连接</button><a className="ml-4 underline" href="/ui-preview.html#/organizer">返回交互模拟</a></main> : <PreviewApp />}</RootLayout>)

