import test from 'node:test'
import assert from 'node:assert/strict'

import { streamAvailableFromHeartbeat } from '../server/db/store.js'


test('fresh Engine advertises a stream while the physical camera is idle', () => {
  assert.equal(streamAvailableFromHeartbeat({
    streamUrl: 'http://edge-node:8077/stream.mjpg',
    ageMs: 5_000,
  }), true)
})

test('missing URL or stale Engine cannot be treated as stream-ready', () => {
  assert.equal(streamAvailableFromHeartbeat({ streamUrl: '', ageMs: 1_000 }), false)
  assert.equal(streamAvailableFromHeartbeat({
    streamUrl: 'http://edge-node:8077/stream.mjpg',
    ageMs: 45_001,
  }), false)
})
