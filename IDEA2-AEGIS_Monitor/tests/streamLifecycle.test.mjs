import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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
