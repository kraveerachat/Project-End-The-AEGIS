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


/* ── PR220-R2: reduced-decode lane — explicit projected reservation, max 1, upload deferral ── */
test('IDA-R2-1 an explicit high-res reservation is charged as given; only one high-res job runs; 256 MiB is respected', async () => {
  const gate = createImageDecodeAdmission({ limits })
  const hi = await gate.acquire({ lane: 'high-res', reservedBytes: 220 * MIB })
  assert.equal(hi.lane, 'high-res')
  assert.equal(hi.reservedBytes, 220 * MIB, 'projected reduced working set, not sourcePixels*4')
  let second = false
  const secondP = gate.acquire({ lane: 'high-res', reservedBytes: 10 * MIB }).then((t) => { second = true; return t })
  let normalIn = false
  const normalP = gate.acquire({ pixels: 12_000_000, inputBytes: 8 * MIB }).then((t) => { normalIn = true; return t })
  await Promise.resolve()
  assert.equal(second, false, 'HIGH_RES_MAX_CONCURRENCY=1')
  assert.equal(normalIn, false, 'a normal job cannot combine with the high-res reservation beyond 256 MiB')
  hi.release()
  const [t2, tn] = await Promise.all([secondP, normalP])
  assert.ok(gate.stats().reservedBytes <= limits.memoryCeilingBytes)
  t2.release(); tn.release()
})

test('IDA-R2-2 high-res admission waits while an interactive upload is active; normal previews continue', async () => {
  let uploading = true
  const gate = createImageDecodeAdmission({ limits, deferHighRes: () => uploading })
  let hiIn = false
  const hiP = gate.acquire({ lane: 'high-res', reservedBytes: 60 * MIB }).then((t) => { hiIn = true; return t })
  const normal = await gate.acquire({ pixels: 1_000_000, inputBytes: 1 })
  await Promise.resolve()
  assert.equal(hiIn, false, 'deferred while the upload runs')
  uploading = false
  gate.notifyMemoryChanged()
  const hi = await hiP
  assert.equal(hi.lane, 'high-res')
  hi.release(); normal.release()
})

test('IDA-R2-3 high-res and normal jobs combine only by OBSERVED normal-lane working set (native ≈ 3× the RGBA estimate)', async () => {
  const gate = createImageDecodeAdmission({ limits })
  // measured PR220-R2: a 16 MP normal decode peaks ≈ 200 MiB of browser process working set
  const normal16 = await gate.acquire({ pixels: 15_996_868, inputBytes: 5 * MIB })
  let hiIn = false
  const hiP = gate.acquire({ lane: 'high-res', reservedBytes: 70 * MIB }).then((t) => { hiIn = true; return t })
  await Promise.resolve()
  assert.equal(hiIn, false, 'high-res waits: observed normal (~3×) + high-res would exceed 256 MiB')
  normal16.release()
  const hi = await hiP
  let nIn = false
  const nP = gate.acquire({ pixels: 15_996_868, inputBytes: 5 * MIB }).then((t) => { nIn = true; return t })
  await Promise.resolve()
  assert.equal(nIn, false, 'a large normal job waits while the high-res job runs')
  const small = await gate.acquire({ pixels: 500_000, inputBytes: 200_000 })
  assert.equal(small.lane, 'normal', 'small tiles still flow beside a high-res decode')
  hi.release(); small.release()
  ;(await nP).release()
  // normal-only concurrency is unchanged (IDA-1): four 16 MP estimates still enter together
  const four = await Promise.all(Array.from({ length: 4 }, () => gate.acquire({ pixels: 15_000_000, inputBytes: 1 })))
  assert.equal(gate.stats().runningNormal, 4)
  four.forEach((t) => t.release())
})
