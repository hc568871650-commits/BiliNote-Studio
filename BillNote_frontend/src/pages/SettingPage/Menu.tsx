import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Captions, Cpu, HardDrive, HardDriveDownload, Info, Activity, Search, Palette, Settings2 } from 'lucide-react'
import MenuBar, { type IMenuProps } from './components/menuBar'

const groups: { name: string; items: IMenuProps[] }[] = [
  { name: '个人', items: [
    { id: 'general', name: '常规', icon: <Settings2 strokeWidth={1.6} />, path: '/settings/general' },
    { id: 'model', name: '模型与 API', icon: <Cpu strokeWidth={1.6} />, path: '/settings/model' },
    { id: 'appearance', name: '外观', icon: <Palette strokeWidth={1.6} />, path: '/settings/appearance' },
  ] },
  { name: '媒体与下载', items: [
    { id: 'transcriber', name: '音频转写', icon: <Captions strokeWidth={1.6} />, path: '/settings/transcriber' },
    { id: 'download', name: '视频下载', icon: <HardDriveDownload strokeWidth={1.6} />, path: '/settings/download' },
  ] },
  { name: '应用', items: [
    { id: 'storage', name: '存储与维护', icon: <HardDrive strokeWidth={1.6} />, path: '/settings/storage' },
    { id: 'monitor', name: '运行状态', icon: <Activity strokeWidth={1.6} />, path: '/settings/monitor' },
    { id: 'about', name: '关于', icon: <Info strokeWidth={1.6} />, path: '/settings/about' },
  ] },
]

export default function Menu() {
  const [search, setSearch] = useState('')
  const visible = groups.map(group => ({ ...group, items: group.items.filter(item => (item.name + ({ general:'启动页面 快捷键 发送 草稿 语言 缓存 捕获', appearance:'主题 颜色 强调色 字体 字号 动效 深色 浅色', model:'生成 阅读 整理 模型 API Key 密钥 地址 连接 服务商 联网 搜索 上下文 容量 协议', transcriber:'音频 转录 下载模型 Whisper Groq', download:'视频 Cookie 代理 Proxy', storage:'存储 空间 清理 缓存 备份 恢复 zip', monitor:'运行 内存 cpu 状态', about:'项目 许可 协议 版权 地址 更新 版本' }[item.id] || '')).toLowerCase().includes(search.trim().toLowerCase())) }))
  return <div className="settings-menu">
    <h1>设置</h1>
    <label className="settings-search"><Search size={15} strokeWidth={1.6} /><input aria-label="搜索设置" placeholder="搜索设置" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="settings-menu-scroll">
      {visible.map(group => group.items.length > 0 && <section key={group.name}><h2>{group.name}</h2>{group.items.map(item => <MenuBar key={item.id} menuItem={item} />)}</section>)}
      {visible.every(group => !group.items.length) && <p className="settings-muted">没有匹配的设置</p>}
    </div>
    <Link className="settings-back" to="/">返回工作区</Link>
  </div>
}
