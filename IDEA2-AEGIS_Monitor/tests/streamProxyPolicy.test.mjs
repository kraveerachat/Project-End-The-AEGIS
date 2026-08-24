import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STREAM_FIRST_BYTE_MS,
  STREAM_IDLE_MS,
  cancelStreamReaderQuietly,
  streamWatchdogDelay,
} from '../server/streamProxyPolicy.js'

test('cold AI startup gets a longer first-byte window than a live-stream stall', () => {
  assert.equal(streamWatchdogDelay(false), STREAM_FIRST_BYTE_MS)
  assert.equal(streamWatchdogDelay(true), STREAM_IDLE_MS)
  assert.ok(STREAM_FIRST_BYTE_MS > STREAM_IDLE_MS)
})

test('reader cancellation absorbs asynchronous AbortError rejections', async () => {
  const abortError = new DOMException('operation aborted', 'AbortError')
  const reader = { cancel: async () => { throw abortError } }

  await assert.doesNotReject(cancelStreamReaderQuietly(reader))
})
