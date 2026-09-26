import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageDecodeAdmission, estimateImageDecodeReservation } from '../src/lib/vaultImageDecodeAdmission.js'

const MIB = 1_048_576
const limits = {
  imageNormalMaxDecodedPixels: 16_000_000,
  imageHighResMaxDecodedPixels: 32_000_000,
  imageHighResMaxConcurrentJobs: 1,
  maxConcurrentJobs: 4,
  memoryCeilingBytes: 256 * MIB,
  posterMaxEdge: 512,
}

test('IDA-1 four normal jobs enter concurrently while high-resolution jobs are serialized', async () => {
  const gate = createImageDecodeAdmission({ limits })
  const normal = await Promise.all(Array.from({ length: 4 }, (_, i) => gate.acquire({ pixels: 1_000_000, inputBytes: 10 + i })))
  assert.deepEqual(gate.stats(), { runningNormal: 4, runningHighRes: 0, queued: 0, reservedBytes: normal.reduce((n, token) => n + token.reservedBytes, 0) })

  normal.forEach((token) => token.release())
  const first = await gate.acquire({ pixels: 25_958_400, inputBytes: 1_000_000 })
  let secondEntered = false
  const secondPromise = gate.acquire({ pixels: 25_958_400, inputBytes: 1_000_000 }).then((token) => { secondEntered = true; return token })
  await Promise.resolve()
  assert.equal(first.lane, 'high-res')
  assert.equal(secondEntered, false)
  assert.equal(gate.stats().queued, 1)
  first.release()
  const second = await secondPromise
  assert.equal(secondEntered, true)
  assert.equal(second.lane, 'high-res')
  second.release()
})

test('IDA-2 reservations include input, RGBA and bounded poster allowance; live preview memory gates admission', async () => {
  let live = 150 * MIB
  const gate = createImageDecodeAdmission({ limits, liveMemoryBytes: () => live })
  const expected = estimateImageDecodeReservation({ pixels: 25_958_400, inputBytes: 8 * MIB, posterMaxEdge: 512 })
  assert.equal(expected, 8 * MIB + 25_958_400 * 4 + 512 * 512 * 4)

  let entered = false
  const waiting = gate.acquire({ pixels: 25_958_400, inputBytes: 8 * MIB }).then((token) => { entered = true; return token })
  await Promise.resolve()
  assert.equal(entered, false, 'live previews plus reservation exceed 256 MiB')
  assert.equal(gate.stats().queued, 1)
  live = 0
  gate.notifyMemoryChanged()
  const token = await waiting
  assert.equal(token.reservedBytes, expected)
  token.release()
})

test('IDA-3 abort removes a queued waiter; releaseAll clears reservations and rejects late waiters', async () => {
  const gate = createImageDecodeAdmission({ limits })
  const running = await gate.acquire({ pixels: 25_958_400, inputBytes: 1 })
  const ctrl = new AbortController()
  const waiting = gate.acquire({ pixels: 25_958_400, inputBytes: 1, signal: ctrl.signal })
  ctrl.abort()
  await assert.rejects(waiting, (error) => error?.name === 'AbortError')
  assert.equal(gate.stats().queued, 0)

  const late = gate.acquire({ pixels: 25_958_400, inputBytes: 1 })
  await gate.releaseAll()
  await assert.rejects(late, (error) => error?.name === 'AbortError')
  assert.deepEqual(gate.stats(), { runningNormal: 0, runningHighRes: 0, queued: 0, reservedBytes: 0 })
  running.release()
})

