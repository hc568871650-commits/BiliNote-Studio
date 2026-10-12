import { useEffect, useState } from 'react'
import request from '@/utils/request'
import { capabilityErrorMessage } from '@/services/modelCapabilities'

interface Settings { enabled:boolean; base_url:string; api_key:string }
export default function WebSearchSettings() {
  const [value,setValue]=useState<Settings>({enabled:false,base_url:'',api_key:''})
  const [loading,setLoading]=useState(true)
  const [ready,setReady]=useState(false)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  useEffect(()=>{let active=true; void request.get('/web_search/settings',{suppressToast:true}).then(result=>{if(active){setValue(result as unknown as Settings);setReady(true)}}).catch(e=>{if(active)setMessage(capabilityErrorMessage(e))}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[])
  return <section className="settings-card settings-card-spaced"><div className="settings-row"><div><h2>外部联网检索</h2><p>为没有原生搜索的模型提供网络资料。使用你自己的 SearXNG 服务，需启用 JSON 格式；查询会发送到该地址。</p></div></div>
    <form autoComplete="off" onSubmit={event=>{event.preventDefault();setBusy(true);setMessage('');void request.put('/web_search/settings',{enabled:value.enabled,base_url:value.base_url,api_key:value.api_key},{suppressToast:true}).then(result=>{setValue(result as unknown as Settings);setMessage('已保存检索配置');window.dispatchEvent(new Event('bilinote-capabilities-updated'))}).catch(e=>setMessage(capabilityErrorMessage(e))).finally(()=>setBusy(false))}}>
      <fieldset disabled={loading||busy||!ready}>
        <div className="settings-field"><label><input type="checkbox" checked={value.enabled} onChange={e=>setValue({...value,enabled:e.target.checked})} style={{width:'auto',marginRight:8}} />启用外部检索</label></div>
        <div className="settings-field"><label htmlFor="search-service-url">检索服务地址</label><input id="search-service-url" name="external-search-endpoint" type="url" autoComplete="off" placeholder="https://search.example.com" value={value.base_url} onChange={e=>setValue({...value,base_url:e.target.value})} /></div>
        <div className="settings-field"><label htmlFor="search-service-key">访问令牌（可选）</label><input id="search-service-key" name="external-search-access-token" type="password" autoComplete="new-password" placeholder="服务需要 Bearer 令牌时填写" value={value.api_key} onChange={e=>setValue({...value,api_key:e.target.value})} /></div>
        <div className="settings-row"><button type="submit" className="settings-button">{busy?'保存中…':'保存检索配置'}</button><span role="status">{message}</span></div>
      </fieldset>
    </form>
  </section>
}
