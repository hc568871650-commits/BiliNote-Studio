import { useEffect, useRef, useState } from 'react'
import PurposeModelPicker from './PurposeModelPicker'
import { capabilityErrorMessage, capabilitySubmissionRejected, cancelCapabilityJob, getCapabilityJob, recoverCapabilitySubmission,
  startCapabilityTest, type CapabilityJob, type CapabilitySubmission, type ModelCapabilityRecord } from '@/services/modelCapabilities'
import type { PurposeModelSelection } from '@/store/purposeModelStore'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import { visionCapabilityState } from '@/utils/visionCapability'
import './reading-vision-status.css'

interface Props {
  model: PurposeModelSelection | null
  protocol: ProviderProtocol
  capabilities?: ModelCapabilityRecord | null
  disabled?: boolean
  onModelChange: (model: PurposeModelSelection | null) => void
}
const terminal = (job: CapabilityJob) => ['completed', 'cancelled', 'failed'].includes(job.status)
interface ReadingProbeRun { identity: string; cancelled: boolean; id?: string; submission?: CapabilitySubmission }

export default function ReadingVisionStatus({ model, protocol, capabilities, disabled, onModelChange }: Props) {
  const [open, setOpen] = useState(false)
  const [job, setJob] = useState<CapabilityJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [checking, setChecking] = useState(false)
  const run = useRef<ReadingProbeRun | null>(null)
  const identity = JSON.stringify([model?.provider_id, model?.model_name, protocol])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const state = visionCapabilityState(capabilities)

  useEffect(() => {
    const invalidate = () => {
      const active = run.current
      run.current = null
      if (active) {
        active.cancelled = true
        if (active.id) void cancelCapabilityJob(active.id).catch(() => undefined)
      }
      setJob(null); setBusy(false); setError(''); setUnconfirmed(false); setChecking(false)
    }
    invalidate()
    window.addEventListener('user-save-provider', invalidate)
    return () => {
      window.removeEventListener('user-save-provider', invalidate)
      const active = run.current
      run.current = null
      if (active) {
        active.cancelled = true
        if (active.id) void cancelCapabilityJob(active.id).catch(() => undefined)
      }
    }
  }, [identity])

  useEffect(() => {
    if (!job || terminal(job)) return
    const active = run.current
    let live = true
    const timer = setTimeout(() => {
      void getCapabilityJob(job.id).then(result => {
        if (!live || !active || active !== run.current || active.identity !== currentIdentity.current) return
        setJob(result); setError('')
        if (terminal(result)) {
          setBusy(false); run.current = null
          window.dispatchEvent(new Event('bilinote-capabilities-updated'))
        }
      }).catch(failure => {
        if (live && active === run.current) setError(`${capabilityErrorMessage(failure)}；检测可能仍在进行。`)
      })
    }, 1200)
    return () => { live = false; clearTimeout(timer) }
  }, [job])

  const reconcile = async (active: ReadingProbeRun) => {
    if (!active.submission) return
    setChecking(true)
    try {
      const result = await recoverCapabilitySubmission(active.submission)
      if (run.current !== active || active.identity !== currentIdentity.current) return
      if (!result) { setError('提交状态仍未确认；原检测可能已执行，再次检测可能重复计费。'); return }
      active.id = result.id
      active.submission = undefined
      setUnconfirmed(false); setJob(result)
      setError(active.cancelled && !terminal(result) ? '已找到检测，取消尚未确认。' : '')
      if (terminal(result)) { setBusy(false); run.current = null; window.dispatchEvent(new Event('bilinote-capabilities-updated')) }
    } catch (failure) {
      if (run.current === active && active.identity === currentIdentity.current) setError(`核对失败：${capabilityErrorMessage(failure)}；提交状态仍未确认。`)
    } finally {
      if (run.current === active || currentIdentity.current === active.identity && !run.current) setChecking(false)
    }
  }

  const start = async () => {
    if (!model || disabled || run.current) return
    const active: ReadingProbeRun = { identity, cancelled: false }
    const body = { provider_id: model.provider_id, model_name: model.model_name, protocol, checks: ['vision'], probe_stream: true }
    const startedAt = Date.now()
    run.current = active
    setBusy(true); setError(''); setJob(null); setUnconfirmed(false)
    try {
      const result = await startCapabilityTest(body)
      active.id = result.id
      if (active.cancelled || run.current !== active || active.identity !== currentIdentity.current) {
        try {
          const cancelled = await cancelCapabilityJob(result.id)
          if (run.current === active) { setJob(cancelled); setBusy(!terminal(cancelled)); if (terminal(cancelled)) { run.current = null; window.dispatchEvent(new Event('bilinote-capabilities-updated')) } }
        } catch (failure) {
          if (run.current === active && active.identity === currentIdentity.current) {
            setJob(result); setBusy(!terminal(result)); setError(`取消未确认：${capabilityErrorMessage(failure)}`)
            if (terminal(result)) { run.current = null; window.dispatchEvent(new Event('bilinote-capabilities-updated')) }
          }
        }
        return
      }
      setJob(result)
      if (terminal(result)) { setBusy(false); run.current = null; window.dispatchEvent(new Event('bilinote-capabilities-updated')) }
    } catch (failure) {
      if (run.current !== active || active.identity !== currentIdentity.current) return
      if (capabilitySubmissionRejected(failure)) { run.current = null; setBusy(false); setError(capabilityErrorMessage(failure)); return }
      active.submission = { body, startedAt, failedAt: Date.now() }
      setUnconfirmed(true); setError('提交状态未确认，正在核对已有检测…')
      await reconcile(active)
    }
  }
  const cancel = async () => {
    const active = run.current
    if (!active) return
    active.cancelled = true
    if (!active.id) return
    try {
      const result = await cancelCapabilityJob(active.id)
      if (run.current === active) { setJob(result); setBusy(!terminal(result)); if (terminal(result)) { run.current = null; window.dispatchEvent(new Event('bilinote-capabilities-updated')) } }
    } catch (failure) { if (run.current === active) setError(`取消未确认：${capabilityErrorMessage(failure)}`) }
  }
  const refresh = async () => {
    const active = run.current
    if (!active) return
    if (active.submission) { await reconcile(active); return }
    if (!active.id) return
    try {
      const result = await getCapabilityJob(active.id)
      if (run.current === active) { setJob(result); setError(''); if (terminal(result)) { setBusy(false); run.current = null; window.dispatchEvent(new Event('bilinote-capabilities-updated')) } }
    } catch (failure) { if (run.current === active) setError(capabilityErrorMessage(failure)) }
  }
  const retryUnconfirmed = () => {
    if (!run.current?.submission || checking || disabled) return
    run.current = null
    void start()
  }

  return <div className="reading-vision-status" data-status={state.status}>
    <div className="reading-vision-row"><span title={state.detail}>{unconfirmed ? '看图：提交待核对' : busy ? '看图：检测中…' : state.label}</span><button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>检测 / 选择模型</button></div>
    {open && <div className="reading-vision-options">
      <PurposeModelPicker inline label="看图模型" value={model} onChange={onModelChange} disabled={disabled || busy} />
      <p>{state.detail}</p>
      <p>检测发送一张测试小图，最多 1 次请求，按服务商计费。</p>
      {unconfirmed ? <button type="button" disabled={checking || disabled} onClick={retryUnconfirmed}>仍要重新检测（可能重复计费）</button> : busy ? <button type="button" onClick={() => void cancel()}>取消检测</button> : <button type="button" disabled={!model || disabled} onClick={() => void start()}>确认检测看图能力</button>}
      {job?.status === 'cancelled' && <span role="status">检测已取消</span>}
      {error && <div role="alert">{error}{busy && <button type="button" disabled={checking} onClick={() => void refresh()}>{unconfirmed ? '核对提交状态' : '刷新进度'}</button>}</div>}
    </div>}
  </div>
}
