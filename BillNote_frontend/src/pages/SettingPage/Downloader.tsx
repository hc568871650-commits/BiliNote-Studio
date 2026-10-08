import { Outlet, useParams } from 'react-router-dom'
import Options from '@/components/Form/DownloaderForm/Options.tsx'
import ProxyConfig from '@/components/Form/DownloaderForm/ProxyConfig.tsx'
const Downloader = () => {
  const { id } = useParams()
  return (
    <>{id ? <Outlet /> : <article className="settings-page">
      <header className="settings-page-header"><h1>视频下载</h1><p>管理各平台的下载凭据和全局代理。</p></header>
      <Options />
      <h2 className="settings-section-title">网络</h2>
      <ProxyConfig />
    </article>}</>
  )
}
export default Downloader
