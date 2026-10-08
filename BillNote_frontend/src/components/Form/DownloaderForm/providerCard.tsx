import { type ComponentType, type FC } from 'react'
import { useNavigate } from 'react-router-dom'
export interface IProviderCardProps {
  id: string
  providerName: string
  Icon: ComponentType
}
const ProviderCard: FC<IProviderCardProps> = ({ providerName, id }: IProviderCardProps) => {
  const navigate = useNavigate()
  const handleClick = () => {
    navigate(`/settings/download/${id}`)
  }

  return (
    <div className="settings-row">
      <div><h2>{providerName}</h2><p>设置用于访问与下载的 Cookie。</p>
      </div>
      <button type="button" className="settings-button" aria-label={`编辑 ${providerName} 下载凭据`} onClick={handleClick}>编辑</button>
    </div>
  )
}
export default ProviderCard
