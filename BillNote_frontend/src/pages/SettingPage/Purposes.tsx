import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import PurposeModelPicker from '@/components/PurposeModelPicker'
import { usePurposeModelStore, type ModelPurpose } from '@/store/purposeModelStore'
import { isQuickEdition } from '@/utils/edition'
import WebSearchSettings from '@/components/WebSearchSettings'

const purposes: { key: ModelPurpose; name: string; description: string }[] = [
  { key: 'generation', name: '笔记生成', description: '' },
  { key: 'reading', name: '阅读问答', description: '' },
  { key: 'organizer', name: '资料库助手', description: '全库问答与笔记整理' },
]
export default function Purposes() {
  const defaults = usePurposeModelStore(state => state.defaults)
  const setDefault = usePurposeModelStore(state => state.setDefault)
  const [saved, setSaved] = useState<ModelPurpose | null>(null)
  return <article className="settings-page">
    <header className="settings-page-header"><h1>AI 用途与模型</h1></header>
    <h2 className="settings-section-title">默认模型</h2>
    <section className="settings-card">{purposes.filter(purpose => !isQuickEdition || purpose.key !== 'organizer').map(purpose => <div className="settings-row" key={purpose.key}><div><h2>{purpose.name}</h2>{purpose.description && <p>{purpose.description}</p>}{saved === purpose.key && <small className="settings-saved"><Check size={12} />已保存</small>}</div><PurposeModelPicker label={`${purpose.name}模型`} value={defaults[purpose.key]} onChange={selection => { setDefault(purpose.key, selection); setSaved(purpose.key) }} /></div>)}</section>
    <p className="settings-footnote">选择后自动保存；聊天中切换模型仅影响当前会话。</p>
    <Link className="settings-link" to="/settings/model">管理模型服务商 →</Link>
    <WebSearchSettings />
  </article>
}
