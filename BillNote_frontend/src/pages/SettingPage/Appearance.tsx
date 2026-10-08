import { useTheme } from 'next-themes'
import { useState } from 'react'
import ChoiceSelect from '@/components/ChoiceSelect'
import { Switch } from '@/components/ui/switch'
import { useAccentStore } from '@/store/accentStore'
import { ThemeModePicker, AccentColorPicker } from '@/components/AppearanceControls'
import { useInterfaceStore } from '@/store/interfaceStore'

export default function Appearance() {
  const { resolvedTheme, setTheme } = useTheme()
  const setAccent = useAccentStore(state => state.setAccent)
  const preferences = useInterfaceStore()
  const [reset, setReset] = useState(false)
  return <article className="settings-page">
    <header className="settings-page-header"><h1>外观</h1></header>
    <h2 className="settings-section-title">视觉风格</h2>
    <section className="settings-card">
      <div className="settings-row"><div><h2>模式</h2><p>深色采用深灰底色，正文与重点信息使用两档文字亮度。</p></div><ThemeModePicker /></div>
    </section>
    <section className="settings-card settings-card-spaced">
      <div className="settings-row"><div><h2>强调色</h2><p>用于选中状态、主要操作、链接与思维导图。</p></div><AccentColorPicker /></div>
      <div className="settings-row"><div><h2>字体</h2><p>用于导航、设置与对话界面</p></div><ChoiceSelect label="界面字体" value={preferences.font} onChange={value => preferences.update({font:value as typeof preferences.font})} options={[{value:'system',label:'系统'},{value:'yahei',label:'微软雅黑'},{value:'segoe',label:'Segoe UI'}]} /></div>
      <div className="settings-row"><div><h2>背景</h2></div><span className="settings-color-value"><i className="surface-sample" />{resolvedTheme === 'dark' ? '#181818' : '#FAFAFA'}</span></div>
    </section>
    <div className="settings-advanced-heading"><h2>排版与动效</h2><button onClick={() => { preferences.resetAppearance(); setTheme('system'); setAccent('slate'); setReset(true) }}>重置外观</button></div>
    {reset && <p className="settings-footnote" role="status">已恢复默认外观。</p>}
    <section className="settings-card">
      <div className="settings-row"><div><h2>界面字号</h2><p>调整设置、导航和对话的基础字号</p></div><ChoiceSelect label="界面字号" value={String(preferences.fontSize)} onChange={value => preferences.update({fontSize:Number(value)})} options={[12,13,14,15,16,18].map(size => ({value:String(size),label:`${size} px`}))} /></div>
      <div className="settings-row"><div><h2>代码字号</h2><p>用于笔记和对话中的代码</p></div><ChoiceSelect label="代码字号" value={String(preferences.codeSize)} onChange={value => preferences.update({codeSize:Number(value)})} options={[11,12,13,14,15,16,18].map(size => ({value:String(size),label:`${size} px`}))} /></div>
      <div className="settings-row"><div><h2>减少动态效果</h2><p>减少菜单、按钮等界面过渡动画</p></div><Switch aria-label="减少动态效果" checked={preferences.reducedMotion} onCheckedChange={value => preferences.update({reducedMotion:value})} /></div>
    </section>
    <p className="settings-footnote">修改立即生效并自动保存。笔记正文字号仍可在阅读工具栏独立调整。</p>
  </article>
}
