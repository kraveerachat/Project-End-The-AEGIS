import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  createUpstreamLifecycle,
  waitForDrainOrClose,
} from '../server/streamLifecycle.js'

test('browser close aborts fetch and explicitly cancels the upstream reader', async () => {
  let aborted = 0
  let cancelled = 0
  const lifecycle = createUpstreamLifecycle({ abort: () => { aborted += 1 } })
  lifecycle.attachReader({ cancel: async () => { cancelled += 1 } })

  lifecycle.abort()
  lifecycle.abort()
  await Promise.resolve()

  assert.equal(lifecycle.closed, true)
  assert.equal(aborted, 1)
  assert.equal(cancelled, 1)
})

test('backpressure wait resolves when the browser closes', async () => {
  const response = new EventEmitter()
  response.destroyed = false
  const lifecycle = createUpstreamLifecycle({ abort() {} })

  const waiting = waitForDrainOrClose(response, lifecycle)
  response.emit('close')
  await waiting

  assert.equal(response.listenerCount('drain'), 0)
  assert.equal(response.listenerCount('close'), 0)
})

function runRouteFixture(scenario) {
  const fixture = fileURLToPath(new URL('./fixtures/streamAbortCrashChild.mjs', import.meta.url))
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', fixture, scenario],
    { encoding: 'utf8', timeout: 15_000 },
  )

  assert.equal(child.error, undefined, child.error?.stack)
  assert.equal(child.signal, null, `child terminated by ${child.signal}\n${child.stderr}`)
  assert.equal(child.status, 0, `Monitor child exited ${child.status}\nSTDOUT:\n${child.stdout}\nSTDERR:\n${child.stderr}`)
  assert.match(child.stdout, /CANCEL_CALLS=1/)
  assert.match(child.stdout, /MONITOR_SURVIVED=YES/)
  return child
}

test('normal stream data flows and upstream cleanup remains single-owner', () => {
  const { stdout } = runRouteFixture('normal')
  assert.match(stdout, /BYTES_RECEIVED=[1-9]\d*/)
  assert.match(stdout, /READ_CALLS=2/)
})

test('idle watchdog contains asynchronous reader cancellation rejection without terminating Monitor', () => {
  const { stdout, stderr } = runRouteFixture('idle')
  assert.match(stdout, /READ_CALLS=2/)
  assert.match(stderr, /no data for 25ms/)
})

test('watchdog and browser response-close overlap remains idempotent', () => {
  const { stdout } = runRouteFixture('response-close-race')
  assert.match(stdout, /CLIENT_CLOSE_REQUESTED=YES/)
})

test('session revalidation and watchdog overlap contains cleanup rejection', () => {
  const { stdout } = runRouteFixture('revalidation-race')
  assert.match(stdout, /SESSION_RELOAD_CALLS=[1-9]\d*/)
})
