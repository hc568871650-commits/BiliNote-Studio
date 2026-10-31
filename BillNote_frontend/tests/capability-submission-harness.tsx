import React from 'react'
import { createRoot } from 'react-dom/client'
import ReadingVisionStatus from '../src/components/ReadingVisionStatus'
import ModelCapabilitiesPanel from '../src/components/ModelCapabilitiesPanel'
import request from '../src/utils/request'
import { useProviderStore } from '../src/store/providerStore'
import { findCapabilitySubmission, type CapabilityJob, type CapabilityTestRequest } from '../src/services/modelCapabilities'

const model = { provider_id: 'fixture-provider', model_name: 'fixture-model' }
const root = createRoot(document.getElementById('root')!)
const audit = {
  mode: 'unknown', kind: 'reading', calls: [] as { method?: string; url?: string; body: unknown }[],
  active: [] as CapabilityJob[], history: [] as CapabilityJob[], last: null as CapabilityJob | null,
  cancelFailures: 0, pendingPost: null as (() => void) | null, pendingReads: [] as (() => void)[], holdReads: false,
  render(kind = 'reading', provider = model.provider_id) {
    audit.kind = kind
    root.render(kind === 'reading'
      ? <ReadingVisionStatus model={{ ...model, provider_id: provider }} protocol="openai-chat" capabilities={null} onModelChange={() => {}} />
      : <ModelCapabilitiesPanel providerId={provider} models={[model]} protocol="openai-chat" />)
  },
  finish() {
    if (!audit.last) throw Error('No fixture job')
    audit.last = { ...audit.last, status: 'completed', completed: audit.last.total }
    audit.active = []; audit.history = [audit.last]
  },
  matcher: findCapabilitySubmission,
}
Object.assign(window, { visionSubmissionAudit: audit })
useProviderStore.setState({ provider: [model.provider_id, 'other-provider'].map(id => ({
  id, name: id, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', enabled: 1, type: 'custom',
})) })
request.defaults.adapter = async config => {
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data || {}
  audit.calls.push({ method: config.method, url: config.url, body })
  const wrapped = (data: unknown) => ({ data: { code: 0, data }, status: 200, statusText: 'OK', headers: {}, config })
  if (config.url === '/model_list') return wrapped([{ ...model, id: 'one' }])
  if (config.url === '/model_capabilities') {
    if (audit.holdReads) await new Promise<void>(resolve => audit.pendingReads.push(resolve))
    return wrapped({ ...config.params, candidates: ['none'], available_efforts: ['auto', 'none'], stale: false,
      features: {}, external_search_available: false, history: audit.history })
  }
  if (config.url === '/model_capabilities/tests' && config.method === 'get') {
    if (audit.holdReads) await new Promise<void>(resolve => audit.pendingReads.push(resolve))
    return wrapped(audit.active)
  }
  if (config.url === '/model_capabilities/tests' && config.method === 'post') {
    if (audit.mode === 'rejected') return { ...wrapped(null), data: { code: 1, msg: '请选择有效模型', data: { error_details: { kind: 'validation', http_status: null } } } }
    const job: CapabilityJob = { ...(body as CapabilityTestRequest), id: 'fixture-' + audit.calls.filter(call => call.method === 'post' && call.url === '/model_capabilities/tests').length,
      status: 'running', created_at: new Date().toISOString(), total: body.checks.length, completed: 0, results: {} }
    audit.last = job
    if (audit.mode === 'late-cancel') {
      audit.active = [job]
      await new Promise<void>(resolve => { audit.pendingPost = resolve })
      return wrapped(job)
    }
    if (audit.mode === 'lost-active') audit.active = [job]
    if (audit.mode === 'lost-history') { audit.last = { ...job, status: 'completed', completed: job.total }; audit.history = [audit.last] }
    if (audit.mode === 'success') { audit.active = [job]; return wrapped(job) }
    throw Error('Injected lost POST response')
  }
  if (config.url?.endsWith('/cancel')) {
    if (audit.cancelFailures > 0) { audit.cancelFailures--; throw Error('Injected cancel connection failure') }
    if (!audit.last) throw Error('Missing fixture job')
    audit.last = { ...audit.last, status: 'cancelled' }; audit.active = []; audit.history = [audit.last]
    return wrapped(audit.last)
  }
  if (config.url?.startsWith('/model_capabilities/tests/')) return wrapped(audit.last)
  throw Error('Unexpected fixture API ' + config.url)
}
audit.render()
