import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

test('shared listeners, restart deduplication, bounded sanitized diagnostics and cleanup', async () => {
  const callbacks = new Map()
  let subscribe
  let getSnapshot
  let copied = ''
  let invokes = 0
  let finishRestart
  let offCount = 0
  const context = {
    exports: {},
    window: { __TAURI_INTERNALS__: {} },
    navigator: { clipboard: { writeText: async text => { copied = text } } },
    require: name => {
      if (name === 'react') return {
        useSyncExternalStore: (sub, get) => { subscribe = sub; getSnapshot = get; return get() },
      }
      if (name === '@tauri-apps/api/event') return {
        listen: async (name, callback) => {
          assert.equal(callbacks.has(name), false, 'each event registers once')
          callbacks.set(name, callback)
          return () => { offCount++; callbacks.delete(name) }
        },
      }
      if (name === '@tauri-apps/api/core') return {
        invoke: async () => { invokes++; await new Promise(resolve => { finishRestart = resolve }) },
      }
      throw new Error(name)
    },
  }
  const source = fs.readFileSync(new URL('./useBackendEvents.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(output, context)
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const api = context.exports.useBackendEvents()
  const offA = subscribe(() => {})
  const offB = subscribe(() => {})
  await tick()
  assert.equal(callbacks.size, 5)
  assert.equal(getSnapshot().status, 'unknown', 'startup is not assumed healthy')
  callbacks.get('backend-message')({ payload: 'api_key="private-key" cookie=private-cookie; second=another-cookie' })
  callbacks.get('backend-error')({ payload: 'Bearer private-token https://user:pass@example.test' })
  await api.copyLogs()
  for (const secret of ['private-key', 'private-cookie', 'another-cookie', 'private-token', 'user:pass']) assert.equal(copied.includes(secret), false)
  for (let i = 0; i < 205; i++) callbacks.get('backend-message')({ payload: 'line ' + i })
  assert.equal(getSnapshot().logs.length, 200)
  const first = api.restart()
  const second = api.restart()
  await tick()
  assert.equal(invokes, 1, 'two UI consumers must invoke only one restart')
  assert.equal(getSnapshot().restarting, true)
  finishRestart()
  await Promise.all([first, second])
  assert.equal(getSnapshot().restarting, false)
  offA()
  assert.equal(offCount, 0, 'remaining consumer retains listeners')
  offB()
  assert.equal(offCount, 5)
  // Strict Mode-style disposal while async listener installation is pending.
  const offC = subscribe(() => {})
  offC()
  await tick()
  assert.equal(callbacks.size, 0)
})
