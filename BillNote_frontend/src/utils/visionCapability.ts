import type { ModelCapabilityRecord } from '@/services/modelCapabilities'

export function visionCapabilityState(record: ModelCapabilityRecord | null | undefined) {
  if (record?.stale) return { status: 'unverified', label: '看图：需重新验证', detail: '服务商配置或检测方式已变化。' }
  const feature = record?.features.vision
  if (!feature || feature.status === 'skipped') return { status: 'unverified', label: '看图：未验证', detail: '可以直接提问，也可先用小图检测。' }
  const labels = { passed: '看图：已验证', unsupported: '看图：明确不支持', failed: '看图：暂时异常', inconclusive: '看图：证据不足' }
  return { status: feature.status, label: labels[feature.status], detail: feature.evidence }
}
