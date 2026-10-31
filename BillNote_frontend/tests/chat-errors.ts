import assert from 'node:assert/strict'
import request from '@/utils/request'
import { askQuestion, compactChat } from '@/services/chat'
import { useProviderStore } from '@/store/providerStore'

const payload = { task_id: 'fixture', provider_id: 'fixture', model_name: 'fixture', question: 'test', history: [], protocol: 'anthropic' as const }
async function main() {
  useProviderStore.setState({ provider: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://synthetic.invalid/v1', apiKey: '', type: 'custom', enabled: 1, logo: 'custom' }] })
  const details = { http_status: 502, upstream_code: 'timeout', request_id: 'fixture-req', occurred_at: '2026-10-06T00:00:00Z', kind: 'upstream_http', protocol: 'anthropic', detail: 'Upstream timeout' }
  request.defaults.adapter = async config => {
    assert.equal(JSON.parse(config.data).protocol, 'anthropic')
    return { data: { code: 500, msg: 'HTTP 502', data: { error_details: details } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  await assert.rejects(askQuestion(payload), (error: any) => error.data.error_details.http_status === 502 && error.data.error_details.request_id === 'fixture-req')
  await assert.rejects(compactChat({ ...payload, summary: '', keep_recent: 0 }), (error: any) => error.data.error_details.protocol === 'anthropic')
  request.defaults.adapter = async config => { throw { config, code: 'ECONNABORTED' } }
  await assert.rejects(askQuestion(payload), (error: any) => error.data.error_details.http_status === null && error.data.error_details.request_id === null && error.data.error_details.protocol === 'anthropic' && error.msg.includes('120 秒'))
  request.defaults.adapter = async config => { throw { config, code: 'ERR_NETWORK' } }
  await assert.rejects(askQuestion(payload), (error: any) => error.data === null && error.msg.includes('网络'))
  console.log('PASS: protocol wire fields, preserved upstream status/request ID, local timeout has no invented upstream status, network failure')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
