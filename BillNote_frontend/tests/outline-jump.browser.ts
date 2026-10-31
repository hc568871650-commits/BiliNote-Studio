const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Exercise real ReaderPane/ReadingOutline with the existing synthetic long note. */
export async function runOutlineJumpChecks() {
  const viewport = document.querySelector<HTMLElement>('[data-testid="reader-viewport"]')!
  const toggle = document.querySelector<HTMLButtonElement>('.reader-outline-button')!
  if (toggle.getAttribute('aria-pressed') !== 'true') { toggle.click(); await pause(240) }
  const nav = document.querySelector<HTMLElement>('.reading-outline-list')!
  const groups = [...nav.querySelectorAll<HTMLElement>('.reading-outline-group')]
  const results: string[] = []
  const sampleJump = async (button: HTMLButtonElement, pinned = false) => {
    const target = button.title
    const group = button.closest<HTMLElement>('.reading-outline-group')!
    const header = group.querySelector<HTMLElement>('.reading-outline-group-title')!
    let wrongSelection = '', lostSticky = false, clipped = false, frames = 0
    const started = performance.now()
    button.click()
    // Samples include React's first committed frame and the entire smooth scroll.
    do {
      await new Promise(requestAnimationFrame)
      const selected = nav.querySelector<HTMLElement>('[aria-current="location"]')?.title
      if (selected !== target) wrongSelection = selected || '(none)'
      if (getComputedStyle(header).position !== 'sticky') lostSticky = true
      const rect = header.getBoundingClientRect(), bounds = nav.getBoundingClientRect()
      if (pinned && rect.top < bounds.top - 1) clipped = true
      frames++
    } while (performance.now() - started < 1600)
    return { target, wrongSelection, lostSticky, clipped, frames }
  }
  const targetGroup = groups[Math.min(4, groups.length - 1)]
  const titleButton = targetGroup.querySelector<HTMLButtonElement>('.reading-outline-group-title .reading-outline-link')!
  const crossing = await sampleJump(titleButton)
  results.push(`${!crossing.wrongSelection && !crossing.lostSticky ? 'PASS' : 'FAIL'} 跨组跳转只高亮目标，无途中反复展开：${JSON.stringify(crossing)}`)
  const toggleGroup = targetGroup.querySelector<HTMLButtonElement>('.reading-outline-toggle')!
  // Pin it explicitly, then place the group header at the navigation's top edge.
  if (toggleGroup.getAttribute('aria-expanded') === 'true') { toggleGroup.click(); await pause(240) }
  toggleGroup.click(); await pause(240)
  const links = [...targetGroup.querySelectorAll<HTMLButtonElement>('.reading-outline-children .reading-outline-link')]
  nav.scrollTop += targetGroup.getBoundingClientRect().top - nav.getBoundingClientRect().top + 40
  for (const index of [2, 3, 2]) {
    const result = await sampleJump(links[index], true)
    results.push(`${!result.wrongSelection && !result.lostSticky && !result.clipped ? 'PASS' : 'FAIL'} 同组上下点击顶部标题完整：${JSON.stringify(result)}`)
  }
  // A manual gesture must immediately release the clicked-heading lock.
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }))
  viewport.scrollTop = Math.max(0, viewport.scrollTop - 400)
  await pause(240)
  results.push(`${nav.querySelector<HTMLElement>('[aria-current="location"]')?.title !== links[2].title ? 'PASS' : 'FAIL'} 手动滚动恢复正文当前位置高亮`)
  return results
}
