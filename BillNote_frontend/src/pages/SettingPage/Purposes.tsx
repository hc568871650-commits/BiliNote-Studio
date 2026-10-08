import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import PurposeModelPicker from '@/components/PurposeModelPicker'
import { usePurposeModelStore, type ModelPurpose } from '@/store/purposeModelStore'
import { isQuickEdition } from '@/utils/edition'

const purposes: { key: ModelPurpose; name: string; description: string }[] = [
  { key: 'generation', name: '笔记生成', description: '用于视频内容整理和笔记生成。' },
  { key: 'reading', name: '阅读问答', description: '用于常驻阅读对话和临时提问，两个会话彼此独立。' },
  { key: 'organizer', name: '整理与帮助', description: '用于笔记分类、逻辑文件夹、标签和归档操作。' },
]
export default function Purposes() {
  const defaults = usePurposeModelStore(state => state.defaults)
  const setDefault = usePurposeModelStore(state => state.setDefault)
  const [saved, setSaved] = useState<ModelPurpose | null>(null)
  return <article className="settings-page">
    <header className="settings-page-header"><h1>AI 用途与模型</h1><p>分别设置默认模型，可以使用同一模型，也可以为每个用途选择不同服务商。</p></header>
    <h2 className="settings-section-title">默认模型</h2>
    <section className="settings-card">{purposes.filter(purpose => !isQuickEdition || purpose.key !== 'organizer').map(purpose => <div className="settings-row" key={purpose.key}><div><h2>{purpose.name}</h2><p>{purpose.description}</p>{saved === purpose.key && <small className="settings-saved"><Check size={12} />已保存</small>}</div><PurposeModelPicker label={`${purpose.name}模型`} value={defaults[purpose.key]} onChange={selection => { setDefault(purpose.key, selection); setSaved(purpose.key) }} /></div>)}</section>
    <p className="settings-footnote">选择后自动保存。修改某个用途不会影响其他用途；聊天中的临时选择只影响当前会话。模型能力由具体模型决定，不限制品牌。</p>
    <Link className="settings-link" to="/settings/model">管理模型服务商与可用模型 →</Link>
  </article>
}
