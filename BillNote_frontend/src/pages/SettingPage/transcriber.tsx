import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import ChoiceSelect from '@/components/ChoiceSelect'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { AlertTriangle, CheckCircle2, Download, Loader2, XCircle, Plus, Trash2, Eye, EyeOff } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { Link } from 'react-router-dom'
import { hasLocalWhisper, quickTranscriberTypes } from '@/utils/edition'
import { fetchTranscriptionModelsByProvider } from '@/services/model'
import { buildTranscriberUpdate, loadTranscriberDraft, type TranscriberDraft } from '@/utils/transcriberSettings'
import './transcriber.css'
import {
  getTranscriberConfig,
  updateTranscriberConfig,
  getModelsStatus,
  downloadModel,
  addWhisperModel,
  deleteWhisperModel,
  TranscriberConfig,
  ModelStatus,
  GroqConnection,
} from '@/services/transcriber'

const isWhisperType = (type: string) =>
  type === 'fast-whisper' || type === 'mlx-whisper'
// Drafts, including credentials, stay in memory only; each engine keeps its own values.
let transcriberDraft: TranscriberDraft | null = null

export default function Transcriber() {
  const [config, setConfig] = useState<TranscriberConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null)
  const [deleteKeyNotice, setDeleteKeyNotice] = useState(false)
  const [selectedType, setSelectedType] = useState('')
  const [fastModel, setFastModel] = useState(transcriberDraft?.fastModel || '')
  const [mlxModel, setMlxModel] = useState(transcriberDraft?.mlxModel || '')
  const selectedModelSize = selectedType === 'mlx-whisper' ? mlxModel : fastModel
  const setSelectedModelSize = selectedType === 'mlx-whisper' ? setMlxModel : setFastModel
  const [groqModel, setGroqModel] = useState(transcriberDraft?.groqModel || 'whisper-large-v3-turbo')
  const [groqConnection, setGroqConnection] = useState<GroqConnection>(transcriberDraft?.connection || { base_url: 'https://api.groq.com/openai/v1', api_key: '', enabled: true })
  const [showKey, setShowKey] = useState(false)
  const [registeredAudioModels, setRegisteredAudioModels] = useState<string[]>([])
  const [modelStatuses, setModelStatuses] = useState<ModelStatus[]>([])
  const [mlxModelStatuses, setMlxModelStatuses] = useState<ModelStatus[]>([])
  const [, setMlxAvailable] = useState(false)
  // 自定义模型表单
  const [newModelName, setNewModelName] = useState(transcriberDraft?.newName || '')
  const [newModelTarget, setNewModelTarget] = useState(transcriberDraft?.newTarget || '')
  const [addingModel, setAddingModel] = useState(false)
  // 已提示过的下载失败 key（whisper 用 model_size，mlx 用 mlx-{size}）。
  // null 表示尚未首次加载——首次加载只建立基线、不对历史失败弹窗。
  const prevFailedRef = useRef<Set<string> | null>(null)

  // 重新拉取配置（不重置用户当前的选择），用于增删自定义模型后刷新下拉与列表
  const reloadConfig = useCallback(async () => {
    try {
      setConfig(await getTranscriberConfig())
    } catch {
      // 静默
    }
  }, [])

  const fetchModelsStatus = useCallback(async () => {
    if (!hasLocalWhisper) return
    try {
      const data = await getModelsStatus()
      setModelStatuses(data.whisper)
      setMlxModelStatuses(data.mlx_whisper)
      setMlxAvailable(data.mlx_available)

      // 下载失败主动提示：只对「本次新出现的失败」弹一次，避免轮询期间反复弹窗
      const failedNow = new Map<string, ModelStatus>()
      data.whisper.forEach(m => m.failed && failedNow.set(m.model_size, m))
      data.mlx_whisper.forEach(m => m.failed && failedNow.set(`mlx-${m.model_size}`, m))
      if (prevFailedRef.current === null) {
        // 首次加载：建立基线，不对进入页面前就已失败的项弹窗（仍会在列表里红字展示）
        prevFailedRef.current = new Set(failedNow.keys())
      } else {
        failedNow.forEach((m, key) => {
          if (!prevFailedRef.current!.has(key)) {
            const detail = m.error ? `：${m.error.slice(0, 120)}` : ''
            toast.error(`模型 ${m.model_size} 下载失败${detail}`, { duration: 6000 })
          }
        })
        prevFailedRef.current = new Set(failedNow.keys())
      }
    } catch {
      // 静默失败，不阻塞主流程
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getTranscriberConfig()
        setConfig(data)
        const available = data.available_types.filter(type => hasLocalWhisper || quickTranscriberTypes.includes(type.value))
        const draft = loadTranscriberDraft(data, transcriberDraft)
        const preferred = draft.type
        setSelectedType(!hasLocalWhisper && !available.some(type => type.value === preferred) ? available[0]?.value || '' : preferred)
        setFastModel(draft.fastModel)
        setMlxModel(draft.mlxModel)
        setGroqModel(draft.groqModel)
        setGroqConnection(draft.connection)
      } catch {
        toast.error('获取转写器配置失败')
      } finally {
        setLoading(false)
      }
    }
    load()
    fetchModelsStatus()
    void fetchTranscriptionModelsByProvider('groq').then(audioModels => setRegisteredAudioModels(audioModels.map(model => model.model_name))).catch(() => { /* Existing registrations are optional; connection failures are reported by request. */ })
  }, [fetchModelsStatus])
  useEffect(() => {
    if (selectedType) transcriberDraft = { type: selectedType, fastModel, mlxModel, groqModel, connection: groqConnection, newName: newModelName, newTarget: newModelTarget }
  }, [selectedType, fastModel, mlxModel, groqModel, groqConnection, newModelName, newModelTarget])

  // 有下载中的模型时自动轮询状态
  useEffect(() => {
    const hasDownloading =
      modelStatuses.some(m => m.downloading) || mlxModelStatuses.some(m => m.downloading)
    if (!hasDownloading) return

    const timer = setInterval(fetchModelsStatus, 3000)
    return () => clearInterval(timer)
  }, [modelStatuses, mlxModelStatuses, fetchModelsStatus])

  const handleSave = async (confirmed = false, keyDeletionConfirmed = false) => {
    if (!selectedType || (!hasLocalWhisper && !quickTranscriberTypes.includes(selectedType))) return
    if (selectedType === 'groq') {
      try {
        const url = new URL(groqConnection.base_url.trim())
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      } catch { toast.error('请输入有效的 Groq HTTP API 地址'); return }
      if (!groqModel.trim()) { toast.error('请输入 Groq 转写模型名称'); return }
      if (!keyDeletionConfirmed && config?.groq_connection?.api_key && !groqConnection.api_key.trim()) {
        setDeleteKeyNotice(true)
        return
      }
    }
    // 切到本地 whisper 引擎且选了未下载的模型时，提前 confirm，避免用户保存后到首次任务才发现要下 GB 级模型
    if (!confirmed && isWhisperType(selectedType)) {
      const pool = selectedType === 'mlx-whisper' ? mlxModelStatuses : modelStatuses
      const target = pool.find(m => m.model_size === selectedModelSize)
      if (target && !target.downloaded && !target.downloading) {
        const sizeHint: Record<string, string> = {
          'tiny': '~75MB',
          'base': '~150MB',
          'small': '~500MB',
          'medium': '~1.5GB',
          'large-v3': '~3GB',
          'large-v3-turbo': '~1.6GB',
        }
        setDownloadNotice(`选择 ${selectedType} / ${selectedModelSize} 后，首次转写时会下载该模型（${sizeHint[selectedModelSize] || '体积未知'}）。网络较差时容易中断；也可以选择在线转写引擎。`)
        return
      }
    }

    setSaving(true)
    try {
      const payload = buildTranscriberUpdate({ type: selectedType, fastModel, mlxModel, groqModel, connection: groqConnection, newName: newModelName, newTarget: newModelTarget })
      await updateTranscriberConfig(payload)
      setDownloadNotice(null)
      setDeleteKeyNotice(false)
      if (selectedType === 'groq') await reloadConfig()
      toast.success('转写器配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDownload = async (modelSize: string, transcriberType: string) => {
    try {
      await downloadModel({ model_size: modelSize, transcriber_type: transcriberType })
      toast.success(`模型 ${modelSize} 开始下载`)
      // 立即刷新状态
      setTimeout(fetchModelsStatus, 1000)
    } catch {
      toast.error('下载请求失败')
    }
  }

  const handleAddCustomModel = async () => {
    const name = newModelName.trim()
    const target = newModelTarget.trim()
    if (!name || !target) {
      toast.error('请填写模型名称和 HF repo_id / 本地路径')
      return
    }
    setAddingModel(true)
    try {
      await addWhisperModel({ name, target })
      toast.success(`已添加自定义模型 ${name}`)
      setNewModelName('')
      setNewModelTarget('')
      await reloadConfig()
      await fetchModelsStatus()
    } catch {
      // 后端的具体错误（如重名）已由请求拦截器 toast，这里不重复提示
    } finally {
      setAddingModel(false)
    }
  }

  const handleDeleteCustomModel = async (name: string) => {
    try {
      await deleteWhisperModel(name)
      toast.success(`已删除自定义模型 ${name}`)
      // 删的正好是当前选中的，回退到 tiny，避免选中一个不存在的名称
      if (fastModel === name) setFastModel('tiny')
      await reloadConfig()
      await fetchModelsStatus()
    } catch {
      // 拦截器已提示
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!config) {
    return <div className="p-6 text-center text-muted-foreground">无法加载配置</div>
  }

  const currentModels = selectedType === 'mlx-whisper' ? mlxModelStatuses : modelStatuses

  return (
    <article className="settings-page transcriber-settings">
      <header className="settings-page-header">
        <h1>音频转写</h1>
      </header>

      {/* 转写引擎选择 */}
      <section className="settings-card transcriber-connection">
          <div className="transcriber-field transcriber-engine">
            <label>转写引擎</label>
            <ChoiceSelect label="转写器类型" value={selectedType} onChange={setSelectedType} disabled={saving} options={config.available_types.filter(type => hasLocalWhisper || quickTranscriberTypes.includes(type.value)).map(type => ({ value: type.value, label: type.label }))} />
            {selectedType === 'groq' && <label className="transcriber-enabled" title="关闭后无法用于新的转写任务"><input type="checkbox" disabled={saving} checked={groqConnection.enabled} onChange={event => setGroqConnection({ ...groqConnection, enabled: event.target.checked })} />启用连接</label>}
          </div>

          {hasLocalWhisper && isWhisperType(selectedType) && (
            <div className="transcriber-field">
              <label title="较大的模型通常更准确，但更慢且占用更多显存">Whisper 模型</label>
              <ChoiceSelect label="Whisper 模型大小" disabled={saving} value={selectedModelSize} onChange={setSelectedModelSize} options={config.whisper_model_sizes.map(size => {
                    const status = currentModels.find(m => m.model_size === size)
                    return { value: size, label: <span className="flex items-center gap-2">
                          {size}
                          {status?.downloaded && (
                            <CheckCircle2 className="h-3 w-3 text-green-500" />
                          )}
                        </span> }
                  })} />
            </div>
          )}

          {hasLocalWhisper && selectedType === 'mlx-whisper' && !config.mlx_whisper_available && (
            <Alert variant="warning" className="settings-transcriber-notice">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                MLX Whisper 当前不可用。需要 macOS 平台并安装{' '}
                <code className="rounded bg-muted px-1">pip install mlx_whisper</code>，
                安装后重启后端生效。
              </AlertDescription>
            </Alert>
          )}
          {selectedType === 'groq' && <>
            <div className="transcriber-field"><label htmlFor="groq-transcription-url">API 地址</label><Input id="groq-transcription-url" disabled={saving} value={groqConnection.base_url} onChange={event => setGroqConnection({ ...groqConnection, base_url: event.target.value })} placeholder="https://api.groq.com/openai/v1" /></div>
            <div className="transcriber-field"><label htmlFor="groq-transcription-key">API 密钥</label><div className="transcriber-key"><Input id="groq-transcription-key" disabled={saving} type={showKey ? 'text' : 'password'} autoComplete="off" value={groqConnection.api_key} onChange={event => setGroqConnection({ ...groqConnection, api_key: event.target.value })} placeholder="输入 API 密钥" /><button type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><small className="transcriber-field-note">保留掩码沿用密钥；清空并保存会删除。</small></div>
            <div className="transcriber-field"><label htmlFor="groq-transcription-model">转写模型</label><Input id="groq-transcription-model" list="groq-transcription-models" disabled={saving} value={groqModel} onChange={event => setGroqModel(event.target.value)} placeholder="选择或输入模型名称" title="选择已有模型，或输入服务商支持的实际语音模型名称" /><datalist id="groq-transcription-models">{[...new Set(['whisper-large-v3-turbo', 'whisper-large-v3', ...registeredAudioModels])].filter(Boolean).map(name => <option key={name} value={name} />)}</datalist></div>
          </>}
          {['bcut', 'kuaishou'].includes(selectedType) && <p className="transcriber-hint">无需密钥。保存后通过{selectedType === 'bcut' ? '必剪' : '快手'}在线转写，需要联网。</p>}

      </section>
      <div className="settings-actions transcriber-save"><button type="button" className="settings-button is-primary" onClick={() => void handleSave()} disabled={saving || !selectedType || (selectedType === 'groq' && !groqModel.trim()) || (selectedType === 'mlx-whisper' && !config.mlx_whisper_available)}>{saving ? '保存中…' : '保存配置'}</button><span>对新任务生效</span></div>

      <details className="transcriber-help"><summary>配置与测试说明</summary><div>
        <p>切换引擎不自动保存，各引擎草稿保留在本次会话中；只保存当前引擎的配置。</p>
        {!hasLocalWhisper && <p>此版本暂不包含本地 Whisper，在线转写需要联网。Groq 的费用与额度以服务商为准。</p>}
        <p>先保存，再用 30–60 秒语音清晰的短视频创建新任务，在「原文参照」核对文字和时间戳。旧任务可能命中字幕缓存；保存配置或下载模型不代表真实转写成功，失败时查看任务错误。</p>
        <p>测试会产生真实任务，在线转写可能消耗 API 额度，笔记生成也会调用所选 AI 模型。</p>
        <Link className="settings-link" to="/?view=create">创建短视频任务 →</Link>
      </div></details>

      {/* Whisper 模型管理 */}
      {hasLocalWhisper && isWhisperType(selectedType) && currentModels.length > 0 && (
        <section>
          <h2 className="settings-section-title">模型管理 · {selectedType === 'mlx-whisper' ? 'MLX Whisper' : 'Faster Whisper'}</h2>
            <div className="settings-card">
              {currentModels.map(model => (
                <div
                  key={model.model_size}
                  className="settings-transcriber-model"
                >
                  <div className="settings-row">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{model.model_size}</span>
                      {model.downloaded ? (
                        <Badge variant="outline">
                          已下载
                        </Badge>
                      ) : model.downloading ? (
                        <Badge variant="secondary" className="flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          下载中
                        </Badge>
                      ) : model.failed ? (
                        <Badge variant="destructive" className="flex items-center gap-1" title={model.error}>
                          <XCircle className="h-3 w-3" />
                          下载失败
                        </Badge>
                      ) : (
                        <Badge variant="outline">未下载</Badge>
                      )}
                    </div>
                    {!model.downloaded && !model.downloading && (
                      <button
                        type="button"
                        className="settings-button"
                        onClick={() => handleDownload(model.model_size, selectedType)}
                      >
                        <Download className="mr-1 h-4 w-4" />
                        {model.failed ? '重试' : '下载'}
                      </button>
                    )}
                  </div>
                  {model.failed && model.error && (
                    <p className="mt-2 break-all text-xs text-red-500" title={model.error}>
                      {model.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
        </section>
      )}

      {/* 自定义 Whisper 模型（仅 fast-whisper：名称不符合内置 Systran 约定的模型在此登记映射） */}
      {hasLocalWhisper && selectedType === 'fast-whisper' && (
        <section>
          <h2 className="settings-section-title">自定义模型</h2>
          <div className="settings-card">
            <details className="transcriber-help transcriber-custom-help"><summary>模型路径说明</summary><div>
                填 <strong>HF repo_id</strong>（如{' '}
                <code className="rounded bg-muted px-1">Systran/faster-whisper-large-v3</code>
                ，会自动下载）或<strong>本地模型目录</strong>（如{' '}
                <code className="rounded bg-muted px-1">/app/backend/models/my-whisper</code>
                ，目录内需含 <code className="rounded bg-muted px-1">model.bin</code>，下载会跳过）。
                添加后即可在上方「Whisper 模型」中选用。Docker 部署请把模型目录挂载进容器（见 README 的{' '}
                <code className="rounded bg-muted px-1">models</code> 卷）。
            </div></details>

            {config.whisper_custom_models &&
            Object.keys(config.whisper_custom_models).length > 0 ? (
              <div>
                {Object.entries(config.whisper_custom_models).map(([name, target]) => {
                  const status = modelStatuses.find(m => m.model_size === name)
                  return (
                    <div
                      key={name}
                      className="settings-row"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          {name}
                          {status?.downloaded && (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                          )}
                          {status?.downloading && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          {status?.failed && (
                            <XCircle className="h-3.5 w-3.5 text-red-500" />
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground" title={target}>
                          {target}
                        </div>
                        {status?.failed && status?.error && (
                          <div className="truncate text-xs text-red-500" title={status.error}>
                            {status.error}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label={`删除自定义模型 ${name}`}
                        className="settings-button"
                        onClick={() => handleDeleteCustomModel(name)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="settings-row"><p className="settings-muted">还没有自定义模型</p></div>
            )}

            <div className="settings-field">
              <label htmlFor="transcriber-model-name">模型名称</label>
              <Input
                id="transcriber-model-name"
                placeholder="模型名称（自定义，如 my-large-v3）"
                value={newModelName}
                onChange={e => setNewModelName(e.target.value)}
              />
              <label htmlFor="transcriber-model-target">HF repo_id 或本地路径</label>
              <Input
                id="transcriber-model-target"
                placeholder="HF repo_id 或本地路径"
                value={newModelTarget}
                onChange={e => setNewModelTarget(e.target.value)}
              />
              <div className="settings-actions"><button type="button" className="settings-button" onClick={handleAddCustomModel} disabled={addingModel}>
                {addingModel ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-4 w-4" />
                )}
                添加
              </button></div>
            </div>
          </div>
        </section>
      )}
      <Dialog open={Boolean(downloadNotice)} onOpenChange={open => { if (!open && !saving) setDownloadNotice(null) }}>
        <DialogContent showCloseButton={!saving}>
          <DialogHeader><DialogTitle>保存本地转写模型配置？</DialogTitle><DialogDescription>{downloadNotice}</DialogDescription></DialogHeader>
          <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setDownloadNotice(null)}>取消</Button><Button type="button" disabled={saving} onClick={() => void handleSave(true)}>{saving ? '保存中…' : '确认保存'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteKeyNotice} onOpenChange={open => { if (!saving) setDeleteKeyNotice(open) }}>
        <DialogContent showCloseButton={!saving}>
          <DialogHeader><DialogTitle>删除 Groq 密钥？</DialogTitle><DialogDescription>保存后会删除已有密钥。使用 Groq 转写前需要重新填写密钥。</DialogDescription></DialogHeader>
          <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setDeleteKeyNotice(false)}>取消</Button><Button type="button" variant="destructive" disabled={saving} onClick={() => void handleSave(false, true)}>{saving ? '保存中…' : '删除并保存'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}
