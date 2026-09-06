import test from 'node:test'
import assert from 'node:assert/strict'
import { heartbeatAvailability } from '../server/db/store.js'

test('fresh idle viewer-demand camera remains stream-requestable', () => {
  assert.deepEqual(
    heartbeatAvailability({
      ageMs: 5_000,
      streamUrl: 'http://172.18.0.1:18078/stream.mjpg',
      cameraConnected: false,
    }),
    {
      status: 'online',
      cameraConnected: false,
      hasStream: true,
    },
  )
})

test('degraded heartbeat can reconnect but does not pretend the camera is open', () => {
  assert.deepEqual(
    heartbeatAvailability({
      ageMs: 30_000,
      streamUrl: 'http://172.18.0.1:18078/stream.mjpg',
      cameraConnected: false,
    }),
    {
      status: 'degraded',
      cameraConnected: false,
      hasStream: true,
    },
  )
})

test('missing endpoint and stale heartbeat remain unavailable', () => {
  assert.equal(heartbeatAvailability({ ageMs: 5_000, streamUrl: null }).hasStream, false)
  assert.deepEqual(
    heartbeatAvailability({
      ageMs: 45_001,
      streamUrl: 'http://172.18.0.1:18078/stream.mjpg',
      cameraConnected: true,
    }),
    {
      status: 'lost',
      cameraConnected: true,
      hasStream: false,
    },
  )
})
