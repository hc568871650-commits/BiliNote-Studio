import assert from 'node:assert/strict'
import { startBackendCheck, probeBackendHealth } from '../src/hooks/backendStartup'

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function harness(probe: (signal: AbortSignal) => Promise<boolean>) {
  let time = 0
  let serial = 0
  let ready = 0
  let pending = 0
  const errors: string[] = []
  const timers = new Map<number, { at: number; callback: () => void }>()
  const check = startBackendCheck({
    probe,
    onReady: () => ready++, onPending: () => pending++, onFailed: error => errors.push(error),
    now: () => time,
    schedule: ((callback: () => void, delay: number) => {
      timers.set(++serial, { at: time + delay, callback })
      return serial
    }) as unknown as typeof setTimeout,
    unschedule: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout,
  })
  const advance = async (target: number) => {
    await flush()
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      time = next[1].at
      timers.delete(next[0])
      next[1].callback()
      await flush()
    }
    time = target
  }
  return { check, advance, timers, errors, state: () => ({ ready, pending }) }
}

// Validate the business payload, not merely an HTTP 200 or ready event.
for (const [body, status, expected] of [['{"code":0}', 200, true], ['{"code":1}', 200, false], ['invalid', 200, false], ['{"code":0}', 503, false]] as const) {
  const result = await probeBackendHealth('http://fixture/api/', new AbortController().signal, (async (url, init) => {
    assert.equal(url, 'http://fixture/api/sys_check')
    assert.equal(init?.cache, 'no-store')
    return new Response(body, { status })
  }) as typeof fetch)
  assert.equal(result, expected)
}

// A missed desktop event or web startup discovers readiness on the faster poll.
let calls = 0
const fast = harness(async () => ++calls === 3)
await fast.advance(999)
assert.equal(fast.state().ready, 0)
await fast.advance(1000)
assert.equal(fast.state().ready, 1)
assert.equal(calls, 3)
assert.equal(fast.timers.size, 0)

const deadline = harness(async () => false)
await deadline.advance(15000)
assert.deepEqual([...deadline.timers.values()].map(timer => timer.at).sort((a, b) => a - b), [17000, 60000])
await deadline.advance(59999)
assert.equal(deadline.errors.length, 0)
await deadline.advance(60000)
assert.match(deadline.errors[0], /60s/)
assert.equal(deadline.timers.size, 0)

// Hints prompt a probe without bypassing validation or overlapping a current request.
let resolveProbe: (ready: boolean) => void = () => {}
let hintCalls = 0
const hinted = harness(() => {
  hintCalls++
  return new Promise(resolve => { resolveProbe = resolve })
})
hinted.check.checkNow()
hinted.check.checkNow()
assert.equal(hintCalls, 1)
assert.equal(hinted.state().ready, 0)
resolveProbe(false)
await hinted.advance(0)
assert.equal(hintCalls, 2)
assert.equal(hinted.state().ready, 0)
resolveProbe(true)
await flush()
assert.equal(hinted.state().ready, 1)

// Unmount/retry aborts the old probe; a late success cannot change state.
let oldSignal: AbortSignal | undefined
const cancelled = harness(signal => {
  oldSignal = signal
  return new Promise(resolve => { resolveProbe = resolve })
})
cancelled.check.stop()
assert.equal(oldSignal?.aborted, true)
resolveProbe(true)
await flush()
assert.equal(cancelled.state().ready, 0)
assert.equal(cancelled.timers.size, 0)
const retried = harness(async () => true)
await flush()
assert.equal(retried.state().ready, 1)

// A hung probe is aborted at 5s and the 60s deadline still settles failure.
let hungSignal: AbortSignal | undefined
const hung = harness(signal => { hungSignal = signal; return new Promise(() => {}) })
await hung.advance(4999)
assert.equal(hungSignal?.aborted, false)
await hung.advance(5000)
assert.equal(hungSignal?.aborted, true)
await hung.advance(60000)
assert.equal(hung.errors.length, 1)
assert.equal(hung.timers.size, 0)

let wakeCalls = 0
const wake = harness(async () => ++wakeCalls > 1)
await flush()
wake.check.checkNow()
await flush()
assert.equal(wake.state().ready, 1)
assert.equal(wakeCalls, 2)
assert.equal(wake.timers.size, 0)
wake.check.fail('late termination')
assert.equal(wake.errors.length, 0)

const terminated = harness(async () => false)
terminated.check.fail('后端进程已退出')
await flush()
terminated.check.checkNow()
assert.deepEqual(terminated.errors, ['后端进程已退出'])
assert.equal(terminated.state().pending, 0)
assert.equal(terminated.timers.size, 0)
console.log('backend startup: health payload, fast polling, 60s deadline, events, retry, abort and termination passed')
