import { useEffect } from 'react'
import { toast } from 'react-hot-toast'
import { useInterfaceStore } from '@/store/interfaceStore'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import { useTaskStore } from '@/store/taskStore'
import { generateNote, type GenerateNotePayload } from '@/services/note'
import { extractShareInput } from '@/utils/sourceUrl'

export const isTauriDesktop = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function readSystemClipboardText(): Promise<string> {
  if (isTauriDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const nativeText = await invoke<string>('read_clipboard_text')
      if (nativeText?.trim()) return nativeText
    } catch {
      // Fall back to Web Clipboard API when available.
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  }
  return ''
}

export async function submitQuickCaptureText(rawText: string): Promise<boolean> {
  const sourceText = rawText.trim() || (await readSystemClipboardText()).trim()
  if (!sourceText) {
    toast.error('剪贴板为空，请先复制受支持的链接')
    return false
  }
  const parsed = extractShareInput(sourceText)
  if (!parsed.url || !parsed.platform) {
    toast.error('剪贴板未检测到受支持的视频、播客或网页链接')
    return false
  }
  const model = usePurposeModelStore.getState().defaults.generation
  if (!model?.provider_id || !model?.model_name) {
    toast.error('请先在「设置 → 模型与 API」配置默认生成模型')
    return false
  }

  const outputLanguage = useInterfaceStore.getState().outputLanguage || 'zh-CN'
  const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `qc-${Date.now()}`
  const payload: GenerateNotePayload = {
    video_url: parsed.url,
    platform: parsed.platform,
    quality: 'medium',
    model_name: model.model_name,
    provider_id: model.provider_id,
    format: ['link'],
    style: 'knowledge',
    grid_size: [],
    link: true,
    screenshot: false,
    video_understand: false,
    video_understanding: false,
    output_language: outputLanguage,
    request_id: requestId,
  }

  try {
    const res = await generateNote(payload, { suppressToast: true })
    if (res?.task_id) {
      useTaskStore.getState().addPendingTask(res.task_id, parsed.platform, payload)
      toast.success(`已加入后台蒸馏队列（${parsed.platform}）`)
      return true
    }
  } catch (err) {
    const msg = (err as { msg?: string; message?: string })?.msg || (err as Error)?.message || '提交蒸馏失败'
    toast.error(`快捷捕获失败：${msg}`)
  }
  return false
}

export function useQuickCapture(initialized: boolean) {
  const enabled = useInterfaceStore(state => state.quickCaptureEnabled)
  const shortcut = useInterfaceStore(state => state.quickCaptureShortcut || 'Alt+Shift+B')

  useEffect(() => {
    if (!initialized || !isTauriDesktop()) return
    let active = true
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<boolean>('configure_quick_capture_hotkey', { enabled, shortcut }))
      .catch(err => {
        if (active && enabled) {
          toast.error(typeof err === 'string' ? err : '全局快捷键注册失败，可能已被其他软件占用')
        }
      })
    return () => { active = false }
  }, [initialized, enabled, shortcut])

  useEffect(() => {
    if (!initialized || !isTauriDesktop()) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen<{ text?: string; source?: string }>('quick-capture', event => {
        void submitQuickCaptureText(event.payload?.text || '')
      })
      if (cancelled) stop()
      else unlisten = stop
    }).catch(() => undefined)
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [initialized])
}
