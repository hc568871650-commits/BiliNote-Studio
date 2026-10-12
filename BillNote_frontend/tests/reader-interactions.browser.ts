import { useInterfaceStore } from '@/store/interfaceStore'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const paint = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) }
export async function runReaderInteractionChecks() {
  const only = new URLSearchParams(location.search).get('check')
  const viewport = document.querySelector<HTMLElement>('[data-testid="reader-viewport"]')!
  const toggle = document.querySelector<HTMLButtonElement>('.reader-collapse-toggle')!
  // Markdown can replace its nodes when the parent/header rerenders; always reacquire.
  const paragraph = () => viewport.querySelector<HTMLElement>('.markdown-body > p')!
  const results: string[] = []
  const compact = () => toggle.getAttribute('aria-expanded') === 'false'
  const wheel = () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }))
  const scroll = async () => { viewport.scrollTop += 160; await paint() }
  const reset = async () => {
    window.getSelection()?.removeAllRanges()
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    if (compact()) toggle.click()
    viewport.dispatchEvent(new Event('note-chapter-jump'))
    viewport.scrollTop = 300
    await pause(320)
  }
  const check = async (name: string, action: () => Promise<boolean>) => {
    if (only && !name.includes(only)) return
    await reset()
    try { results.push(`${await action() ? 'PASS' : 'FAIL'} ${name}`) }
    catch (error) { results.push(`FAIL ${name}: ${String(error)}`) }
  }
  await check('普通向下滚动收起', async () => { await pause(2050); wheel(); await scroll(); return compact() })
  await check('目录跳转后立即手动滚动', async () => { wheel(); await scroll(); return compact() })
  await check('拖动滚动条超过1.5秒', async () => {
    const rect = viewport.getBoundingClientRect()
    viewport.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: rect.right - 2, clientY: rect.top + 60, bubbles: true }))
    await pause(1700); await scroll()
    const passed = compact()
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    return passed
  })
  await check('保留文字选区后滚动', async () => {
    await pause(2050)
    const range = document.createRange(); range.selectNodeContents(paragraph())
    window.getSelection()?.addRange(range)
    wheel(); await scroll()
    return compact()
  })
  await check('拖动选字不触发收起', async () => {
    await pause(2050)
    paragraph().dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, bubbles: true }))
    await scroll()
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    return !compact()
  })
  await check('程序目录滚动保持展开', async () => { await scroll(); return !compact() })
  await check('键盘向下滚动', async () => {
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    await scroll(); return compact()
  })
  await check('触摸向下滚动', async () => {
    viewport.dispatchEvent(new Event('touchmove', { bubbles: true }))
    await scroll(); return compact()
  })
  await check('收起动画中间帧及阅读锚点', async () => {
    const header = document.querySelector<HTMLElement>('.workspace-note-header-motion')
    if (!header) return false
    const beforeHeight = header.getBoundingClientRect().height
    const beforeY = paragraph().getBoundingClientRect().top
    toggle.click(); await pause(90)
    const middleHeight = header.getBoundingClientRect().height
    await pause(300)
    return middleHeight > 0 && middleHeight < beforeHeight && header.getBoundingClientRect().height === 0 && Math.abs(paragraph().getBoundingClientRect().top - beforeY) <= 2
  })
  await check('展开动画保留阅读锚点', async () => {
    toggle.click(); await pause(330)
    const beforeY = paragraph().getBoundingClientRect().top
    toggle.click(); await pause(330)
    return !compact() && Math.abs(paragraph().getBoundingClientRect().top - beforeY) <= 2
  })
  await check('动画快速反向切换', async () => {
    const beforeY = paragraph().getBoundingClientRect().top
    toggle.click(); await pause(70); toggle.click(); await pause(40)
    toggle.click(); await pause(50); toggle.click(); await pause(330)
    return !compact() && Math.abs(paragraph().getBoundingClientRect().top - beforeY) <= 2
  })
  await check('动画期间继续手动滚动', async () => {
    const beforeY = paragraph().getBoundingClientRect().top
    toggle.click(); await pause(70)
    wheel(); await scroll()
    await pause(330)
    const shift = paragraph().getBoundingClientRect().top - beforeY
    if (Math.abs(shift + 160) > 2) throw new Error(`正文移动 ${shift.toFixed(2)}px，预期 -160px`)
    return compact()
  })
  const beforeReducedMotion = useInterfaceStore.getState().reducedMotion
  useInterfaceStore.setState({ reducedMotion: true })
  await check('减少动态效果直接收起', async () => {
    toggle.click(); await paint()
    const header = document.querySelector<HTMLElement>('.workspace-note-header-motion')
    return !!header && header.getBoundingClientRect().height === 0
  })
  useInterfaceStore.setState({ reducedMotion: beforeReducedMotion })
  await reset()
  return results
}
