import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
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

test('concurrent cleanup sources stay idempotent and contain rejected reader cancellation', async () => {
  let aborted = 0
  let cancelled = 0
  let unhandled
  const onUnhandled = (reason) => { unhandled = reason }
  process.once('unhandledRejection', onUnhandled)
  try {
    const lifecycle = createUpstreamLifecycle({ abort: () => { aborted += 1 } })
    lifecycle.attachReader({
      cancel() {
        cancelled += 1
        return Promise.reject(new DOMException('already aborted', 'AbortError'))
      },
    })

    // Model the response-close and watchdog callbacks becoming runnable in
    // the same turn. Both invoke the same production cleanup boundary.
    await Promise.all([
      new Promise((resolve) => setImmediate(() => { lifecycle.abort(); resolve() })),
      new Promise((resolve) => setImmediate(() => { lifecycle.abort(); resolve() })),
    ])
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(aborted, 1)
    assert.equal(cancelled, 1)
    assert.equal(unhandled, undefined)
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
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

test('upstream abort wakes a connected backpressure wait without drain or close', async () => {
  const response = new EventEmitter()
  response.destroyed = false
  const controller = new AbortController()
  const lifecycle = createUpstreamLifecycle(controller)
  let cancelled = 0
  lifecycle.attachReader({ cancel: async () => { cancelled += 1 } })
  let settled = false
  const waiting = waitForDrainOrClose(response, lifecycle).then(() => { settled = true })
  try {
    lifecycle.abort()
    lifecycle.abort()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lifecycle.closed, true)
    assert.equal(response.destroyed, false)
    assert.equal(settled, true, 'abort must unblock cleanup even if the connected browser never drains')
    assert.equal(cancelled, 1)
    assert.equal(response.listenerCount('drain'), 0)
    assert.equal(response.listenerCount('close'), 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  } finally {
    // Only test cleanup emits close; it cannot satisfy the assertion above.
    response.emit('close')
    await waiting
  }
})

test('normal backpressure still waits for drain and removes the abort listener', async () => {
  const response = new EventEmitter()
  response.destroyed = false
  const controller = new AbortController()
  const lifecycle = createUpstreamLifecycle(controller)
  let settled = false
  const waiting = waitForDrainOrClose(response, lifecycle).then(() => { settled = true })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  response.emit('drain')
  await waiting
  assert.equal(lifecycle.closed, false)
  assert.equal(response.listenerCount('drain'), 0)
  assert.equal(response.listenerCount('close'), 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const nextWait = waitForDrainOrClose(response, lifecycle)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
    response.emit('drain')
    await nextWait
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
  lifecycle.abort()
})

test('abort before or during listener registration leaves no stranded wait or listeners', async () => {
  for (const duringRegistration of [false, true]) {
    const response = new EventEmitter()
    response.destroyed = false
    const controller = new AbortController()
    const lifecycle = createUpstreamLifecycle(controller)
    if (duringRegistration) {
      const once = response.once.bind(response)
      response.once = (event, callback) => {
        const result = once(event, callback)
        if (event === 'close') lifecycle.abort()
        return result
      }
    } else lifecycle.abort()
    let settled = false
    const waiting = waitForDrainOrClose(response, lifecycle).then(() => { settled = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, true)
      assert.equal(response.listenerCount('drain'), 0)
      assert.equal(response.listenerCount('close'), 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    } finally { response.emit('close'); await waiting }
  }
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

test('cold first stream byte survives the steady-state idle deadline', () => {
  const { stdout } = runRouteFixture('delayed-first-byte')
  assert.match(stdout, /BYTES_RECEIVED=[1-9]\d*/)
  assert.match(stdout, /READ_CALLS=2/)
})

test('no first stream byte closes at the bounded startup deadline', () => {
  const { stdout, stderr } = runRouteFixture('no-first-byte')
  assert.match(stdout, /BYTES_RECEIVED=0/)
  assert.match(stderr, /no first stream data for 120ms/)
})

test('idle watchdog contains asynchronous reader cancellation rejection without terminating Monitor', () => {
  const { stdout, stderr } = runRouteFixture('idle')
  assert.match(stdout, /READ_CALLS=2/)
  assert.match(stderr, /no data for 25ms/)
})

test('browser response-close cancels a pending read while the watchdog is armed', () => {
  const { stdout } = runRouteFixture('response-close-race')
  assert.match(stdout, /CLIENT_CLOSE_REQUESTED=YES/)
})

test('session revalidation and watchdog overlap contains cleanup rejection', () => {
  const { stdout } = runRouteFixture('revalidation-race')
  assert.match(stdout, /SESSION_RELOAD_CALLS=[1-9]\d*/)
})
