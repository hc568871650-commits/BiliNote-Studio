/* eslint-disable react-refresh/only-export-components -- Isolated browser test entry. */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ReadingChatLayout from '../src/pages/HomePage/components/ReadingChatLayout'
import '../src/pages/HomePage/components/reading-assistant.css'

const mounts = { reader: 0, chat: 0 }
const wideColumns = Array.from({ length: 48 }, (_, index) => `字段${index + 1}`)
const layoutAnswer = [
  '### 布局样例（非模型输出）',
  '以下内容仅用于检查长答案、宽表格和代码的阅读布局。',
  ...Array.from({ length: 18 }, (_, index) => `第${index + 1}段：阅读笔记时，回答需要在聊天栏内自然换行。缩窄窗口、切换全屏或调整分栏，输入框应保持可见，历史内容继续在消息区域内滚动。这里使用固定文字验证排版，没有调用模型。`),
  '#### 宽表格样例',
  `| ${wideColumns.join(' | ')} |\n| ${wideColumns.map(() => '---').join(' | ')} |\n${Array.from({ length: 3 }, (_, row) => `| ${wideColumns.map((_, index) => `值${row + 1}_${index + 1}`).join(' | ')} |`).join('\n')}`,
  '#### 长代码样例',
  `\`\`\`json\n${Array.from({ length: 20 }, (_, index) => `{"layoutSample": ${index + 1}, "description": "${'wide_code_sample_'.repeat(24)}"}`).join('\n')}\n\`\`\``,
].join('\n\n')
function Reader({ note }: { note: string }) {
  useEffect(() => { mounts.reader++ }, [])
  return <div className="reading-note-column"><div data-reader-scroll style={{ height: '100%', overflow: 'auto' }}>{Array.from({ length: 100 }, (_, index) => <p key={index} style={{ height: 32 }}>{note} 正文 {index}</p>)}</div></div>
}
function Chat() {
  useEffect(() => { mounts.chat++ }, [])
  const [value, setValue] = useState('未发送草稿')
  return <div className="reading-chat">
    <header className="reading-chat-header"><strong>布局样例（非模型输出）</strong></header>
    <div className="reading-chat-messages" data-layout-message-scroll><article className="reading-message reading-message--assistant"><ReactMarkdown remarkPlugins={[remarkGfm]}>{layoutAnswer}</ReactMarkdown></article></div>
    <div className="reading-chat-composer"><textarea aria-label="聊天输入" value={value} onChange={event => setValue(event.target.value)} /><div className="reading-chat-actions"><span>布局测试</span></div></div>
  </div>
}
function App() {
  const [mode, setMode] = useState<'closed' | 'half' | 'full'>('half')
  const [note, setNote] = useState('笔记一')
  Object.assign(window, { __layoutHarness: { setMode, setNote, mounts } })
  return <><div style={{ height: 36 }}><button onClick={() => setMode('closed')}>关闭聊天</button><button onClick={() => setMode('half')}>并排</button><button onClick={() => setMode('full')}>全屏</button></div><div style={{ height: 'calc(100vh - 36px)' }}><ReadingChatLayout mode={mode} onCloseChat={() => setMode('closed')} reader={<Reader note={note} />} chat={<Chat />} /></div></>
}
createRoot(document.getElementById('root')!).render(<App />)
