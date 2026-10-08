import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BotMessageSquare, Captions, HardDriveDownload, Info, Activity, Search, Palette, Network, Settings2 } from 'lucide-react'
import MenuBar, { type IMenuProps } from './components/menuBar'

const groups: { name: string; items: IMenuProps[] }[] = [
  { name: '个人', items: [
    { id: 'general', name: '常规', icon: <Settings2 />, path: '/settings/general' },
    { id: 'purposes', name: 'AI 用途与模型', icon: <BotMessageSquare />, path: '/settings/purposes' },
    { id: 'appearance', name: '外观', icon: <Palette />, path: '/settings/appearance' },
  ] },
  { name: '服务配置', items: [
    { id: 'model', name: '模型服务商', icon: <Network />, path: '/settings/model' },
    { id: 'transcriber', name: '音频转写', icon: <Captions />, path: '/settings/transcriber' },
    { id: 'download', name: '视频下载', icon: <HardDriveDownload />, path: '/settings/download' },
  ] },
  { name: '应用', items: [
    { id: 'monitor', name: '运行状态', icon: <Activity />, path: '/settings/monitor' },
    { id: 'about', name: '关于', icon: <Info />, path: '/settings/about' },
  ] },
]

export default function Menu() {
  const [search, setSearch] = useState('')
  const visible = groups.map(group => ({ ...group, items: group.items.filter(item => (item.name + ({ general:'启动页面 快捷键 发送 草稿', appearance:'主题 颜色 强调色 字体 字号 动效 深色 浅色', purposes:'生成 阅读 整理 模型', model:'API Key 密钥 地址 连接 模型 服务商', transcriber:'音频 转录 下载模型 Whisper Groq', download:'视频 Cookie 代理 Proxy', monitor:'运行 内存 cpu 状态', about:'项目 开源 地址' }[item.id] || '')).toLowerCase().includes(search.trim().toLowerCase())) }))
  return <div className="settings-menu">
    <h1>设置</h1>
    <label className="settings-search"><Search size={16} /><input aria-label="搜索设置" placeholder="搜索设置" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="settings-menu-scroll">
      {visible.map(group => group.items.length > 0 && <section key={group.name}><h2>{group.name}</h2>{group.items.map(item => <MenuBar key={item.id} menuItem={item} />)}</section>)}
      {visible.every(group => !group.items.length) && <p className="settings-muted">没有匹配的设置</p>}
    </div>
    <Link className="settings-back" to="/">返回工作区</Link>
  </div>
}
