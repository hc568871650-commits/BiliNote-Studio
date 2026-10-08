import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveSidebarTransition, type SidebarSnapshot, type WorkspaceView } from '../src/utils/sidebarTransition'

const input = (view: WorkspaceView, options = {}) => ({
  pathname: '/', search: '', key: 'home', view, createExpanded: false, readingExpanded: true, ...options,
})
const snapshot = (view: WorkspaceView, options = {}): SidebarSnapshot => resolveSidebarTransition(null, input(view, options)).snapshot
let checks = 0
function check(label: string, previous: SidebarSnapshot | null, next: ReturnType<typeof input>, expected: { expanded: boolean; animate: boolean | null; creating?: boolean }) {
  const result = resolveSidebarTransition(previous, next)
  assert.equal(result.expanded, expected.expanded, `${label}: expanded`)
  assert.equal(result.animate, expected.animate, `${label}: animate`)
  if (expected.creating !== undefined) assert.equal(result.creating, expected.creating, `${label}: creating`)
  checks++
  return result.snapshot
}

check('initial creation', null, input('create'), { expanded: false, animate: false })
check('initial reading with remembered open', null, input('read'), { expanded: true, animate: false })
check('initial route overrides stale reading', null, input('read', { search: '?view=create' }), { expanded: false, animate: false, creating: true })
check('reading open to creation', snapshot('read'), input('create'), { expanded: false, animate: true })
check('reading closed to creation', snapshot('read', { readingExpanded: false }), input('create', { readingExpanded: false }), { expanded: false, animate: false })
check('creation to remembered open reading', snapshot('create'), input('read'), { expanded: true, animate: true })
check('creation to remembered closed reading', snapshot('create', { readingExpanded: false }), input('read', { readingExpanded: false }), { expanded: false, animate: false })
const manuallyOpenCreate = { ...snapshot('create'), expanded: true }
check('manually opened creation to open reading', manuallyOpenCreate, input('read', { createExpanded: true }), { expanded: true, animate: false })
check('manually opened creation to closed reading', manuallyOpenCreate, input('read', { createExpanded: true, readingExpanded: false }), { expanded: false, animate: true })
check('creation to generation settings', snapshot('create'), input('configure'), { expanded: true, animate: true })
check('reading to generation settings preserves sidebar', snapshot('read'), input('configure'), { expanded: true, animate: false })
check('generation settings to reading preserves sidebar', snapshot('configure'), input('read'), { expanded: true, animate: false })
check('generation settings to new closes sidebar', snapshot('configure'), input('create'), { expanded: false, animate: true })
check('manual reading close preserves toggle animation', snapshot('read'), input('read', { readingExpanded: false }), { expanded: false, animate: null })
check('manual reading open preserves toggle animation', snapshot('read', { readingExpanded: false }), input('read'), { expanded: true, animate: null })
check('manual new close preserves toggle animation', manuallyOpenCreate, input('create'), { expanded: false, animate: null })
for (const pathname of ['/organizer', '/settings']) {
  const hidden = { ...snapshot('read'), pathname, key: pathname }
  const restoredCreate = check(`${pathname} to create never opens old sidebar`, hidden, input('read', { search: '?view=create', key: 'return' }), { expanded: false, animate: false, creating: true })
  check(`${pathname} restored create settles without second animation`, restoredCreate, input('create', { search: '?view=create', key: 'return' }), { expanded: false, animate: null })
  check(`${pathname} to read restores open without animation`, hidden, input('create', { search: '?view=read', key: 'return' }), { expanded: true, animate: false, creating: false })
}
const routedCreate = check('visible new create navigation closes even before parent synchronization', snapshot('read'), input('read', { search: '?view=create', key: 'new-create' }), { expanded: false, animate: true, creating: true })
check('route intent consumed so library can reopen', routedCreate, input('read', { search: '?view=create', key: 'new-create' }), { expanded: true, animate: true, creating: false })
check('visible read navigation opens before parent synchronization', snapshot('create'), input('create', { search: '?view=read', key: 'new-read' }), { expanded: true, animate: true, creating: false })
check('same create navigation resets manual create expansion', manuallyOpenCreate, input('create', { createExpanded: true, search: '?view=create', key: 'repeat-create' }), { expanded: false, animate: true })
check('no-note reading is still reading', snapshot('create'), input('read'), { expanded: true, animate: true, creating: false })

const css = readFileSync('src/layouts/workspace.css', 'utf8')
assert.match(css, /html\[data-reduced-motion=true\][^{]*\{\s*transition:\s*none\s*!important/)
assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*transition:\s*none\s*!important/)
console.log(`PASS: ${checks} sidebar route/view/toggle cases; application and OS reduced-motion CSS guards`)
