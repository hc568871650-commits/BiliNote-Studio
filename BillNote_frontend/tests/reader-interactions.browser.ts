const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const paint = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) }

export async function runReaderInteractionChecks() {
  const only = new URLSearchParams(location.search).get('check')
  const viewport = document.querySelector<HTMLElement>('[data-testid="reader-viewport"]')!
  const topbar = document.querySelector<HTMLElement>('.workspace-topbar')!
  const outlineBtn = document.querySelector<HTMLButtonElement>('.reader-outline-button')!
  const backToTop = document.querySelector<HTMLButtonElement>('.reader-back-to-top')!
  const progress = () => document.querySelector<HTMLElement>('.reader-progress')?.textContent?.trim() || ''
  const results: string[] = []

  const reset = async () => {
    window.getSelection()?.removeAllRanges()
    if (outlineBtn.getAttribute('aria-pressed') === 'true') outlineBtn.click()
    viewport.scrollTo({ top: 0, behavior: 'auto' })
    await paint()
  }
  const check = async (name: string, action: () => Promise<boolean>) => {
    if (only && !name.includes(only)) return
    await reset()
    try { results.push(`${await action() ? 'PASS' : 'FAIL'} ${name}`) }
    catch (error) { results.push(`FAIL ${name}: ${String(error)}`) }
  }

  await check('单顶栏固定 48px 高度与工具栏语义', async () => {
    const toolbar = document.querySelector<HTMLElement>('[role="toolbar"]')
    return Math.abs(topbar.getBoundingClientRect().height - 48) <= 1 && Boolean(toolbar)
  })
  await check('向下滚动零顶栏跳动与进度更新', async () => {
    const beforeTop = viewport.getBoundingClientRect().top
    const beforeProgress = progress()
    viewport.scrollTop = 600
    await pause(80)
    const afterTop = viewport.getBoundingClientRect().top
    return Math.abs(afterTop - beforeTop) <= 0.5 && Math.abs(topbar.getBoundingClientRect().height - 48) <= 1 && progress() !== beforeProgress
  })
  await check('滚动后按需显示回到顶部圆钮并可回顶', async () => {
    for (let i = 0; i < 10 && backToTop.classList.contains('is-visible'); i++) await pause(30)
    const hiddenAtTop = !backToTop.classList.contains('is-visible')
    if (!hiddenAtTop) throw new Error(`顶部未隐藏: ${backToTop.className} scrollTop=${viewport.scrollTop}`)
    viewport.scrollTo({ top: 500, behavior: 'auto' })
    await paint()
    for (let i = 0; i < 15 && !document.querySelector('.reader-back-to-top')?.classList.contains('is-visible'); i++) await pause(30)
    const liveBackToTop = document.querySelector<HTMLButtonElement>('.reader-back-to-top')!
    const visibleAfterScroll = liveBackToTop.classList.contains('is-visible')
    if (!visibleAfterScroll) return false
    liveBackToTop.click()
    for (let i = 0; i < 30 && viewport.scrollTop > 2; i++) await pause(50)
    return viewport.scrollTop <= 2
  })
  await check('目录开关切换不挤压顶栏', async () => {
    const beforeHeight = topbar.getBoundingClientRect().height
    outlineBtn.click()
    await pause(280)
    const opened = outlineBtn.getAttribute('aria-pressed') === 'true'
    outlineBtn.click()
    await pause(280)
    return opened && outlineBtn.getAttribute('aria-pressed') === 'false' && Math.abs(topbar.getBoundingClientRect().height - beforeHeight) <= 0.5
  })
  await reset()
  return results
}
