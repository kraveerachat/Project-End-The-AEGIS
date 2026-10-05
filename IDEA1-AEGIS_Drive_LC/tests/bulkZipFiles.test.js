// tests/bulkZipFiles.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 7
//
// Normal Files source (spec §10), two-phase per SC-1:
//   open()  — fetch (60 s source-idle timer around the headers), HTTP result, body present,
//             Content-Length required and equal to the listing size. Writes NOTHING to the ZIP.
//   pump()  — reader loop: idle timer only while awaiting read(), cleared on positive payload BEFORE
//             the archive write (a slow disk never spends the network idle budget), overlong check,
//             write. The CRC lives only in the writer (M-6).
//   cleanup — one idempotent routine: mark failed, clear timer, fetchCtrl.abort() immediately, then
//             reader.cancel() best-effort and NEVER awaited.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { createCRC32 } from 'hash-wasm'

import { runBulkZip, createFilesEntrySource } from '../src/lib/bulkZipDownload.js'
import { createZipStreamWriter } from '../src/lib/zipStreamWriter.js'

const quotaError = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
const flush = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)) }
const sha = (b) => createHash('sha256').update(b).digest('hex')

function bytesOf(n, seed = 1) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 13 + seed) & 0xff
  return b
}

/** A reader whose read() results the test releases one at a time. */
function scriptedReader({ cancelBehaviour = 'resolve', log } = {}) {
  const pending = []
  const queued = []
  const reader = {
    reads: 0,
    cancelCalls: [],
    released: false,
    read() {
      reader.reads += 1
      if (queued.length) return Promise.resolve(queued.shift())
      return new Promise((resolve) => pending.push(resolve))
    },
    cancel(reason) {
      log?.push('reader.cancel')
      reader.cancelCalls.push(reason)
      if (cancelBehaviour === 'never') return new Promise(() => {})
      if (cancelBehaviour === 'reject-late') return new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 5000))
      return Promise.resolve()
    },
    releaseLock() { reader.released = true },
    push(result) {
      if (pending.length) pending.shift()(result)
      else queued.push(result)
    },
    chunk(bytes) { reader.push({ done: false, value: bytes }) },
    end() { reader.push({ done: true, value: undefined }) },
  }
  return reader
}

/**
 * Fake transport. Each id maps to a script: `{ status, length, body: 'stream'|'scripted'|null, bytes }`.
 * The fetch honours its signal like a real fetch, and records every call.
 */
function makeTransport(scripts, { log } = {}) {
  const calls = []
  const fetchStream = (path, { signal } = {}) => {
    const id = decodeURIComponent(path.split('/')[3])
    const s = scripts[id]
    calls.push({ path, id, signal })
    log?.push(`fetch:${id}`)
    if (signal) signal.addEventListener('abort', () => log?.push(`fetchCtrl.abort:${id}`), { once: true })
    const respond = () => {
      if (s.network) return { ok: false, status: 0, headers: null, body: null, errorKind: 'network' }
      const status = s.status ?? 200
      if (status !== 200) {
        return { ok: false, status, headers: new Headers(), body: null, errorKind: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'server' }
      }
      const headers = new Headers()
      if (s.length !== undefined) headers.set('Content-Length', s.length)
      let body = null
      if (s.body === 'scripted') {
        body = { getReaderCalls: 0, getReader() { body.getReaderCalls += 1; return s.reader } }
      } else if (s.body !== null) {
        const bytes = s.bytes
        body = {
          getReaderCalls: 0,
          getReader() {
            body.getReaderCalls += 1
            const rs = new ReadableStream({ start(c) { if (bytes.length) { c.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2))); c.enqueue(bytes.subarray(Math.ceil(bytes.length / 2))) } c.close() } })
            return rs.getReader()
          },
        }
      }
      s.bodyObj = body
      return { ok: true, status: 200, headers, body, errorKind: null }
    }
    if (s.hold) {
      return new Promise((resolve) => {
        s.release = () => resolve(respond())
        signal?.addEventListener('abort', () => resolve({ ok: false, status: 0, headers: null, body: null, errorKind: 'network' }), { once: true })
      })
    }
    return Promise.resolve(respond())
  }
  return { fetchStream, calls }
}

function zipHarness({ writeHold = null, writeError = null } = {}) {
  const events = []
  const written = []
  let count = 0
  const writable = {
    async write(bytes) {
      const err = writeError?.(bytes)
      if (err) throw err
      if (writeHold) await writeHold(bytes)
      written.push({ pos: count, bytes: bytes.slice() })
      count += bytes.length
    },
    async close() { events.push('close') },
    async abort() { events.push('abort') },
  }
  const scope = {
    pickers: 0,
    showSaveFilePicker() { scope.pickers += 1; return Promise.resolve({ createWritable: async () => writable }) },
  }
  const hashStats = { hashedBytes: [], current: 0 }
  const createHasher = async () => {
    const h = await createCRC32()
    return {
      init() { hashStats.current = hashStats.hashedBytes.push(0) - 1; h.init() },
      update(b) { hashStats.hashedBytes[hashStats.current] += b.length; h.update(b) },
      digest(f) { return h.digest(f) },
    }
  }
  const output = () => {
    const out = new Uint8Array(count)
    for (const w of written) out.set(w.bytes, w.pos)
    return out
  }
  const headerPositions = () => {
    const o = output()
    const pos = []
    for (let i = 0; i + 4 <= o.length; i += 1) if (o[i] === 0x50 && o[i + 1] === 0x4b && o[i + 2] === 3 && o[i + 3] === 4) pos.push(i)
    return pos
  }
  return { events, scope, writable, createHasher, hashStats, output, headerPositions, count: () => count }
}

const filesPlan = (sizes) => Object.freeze({
  mode: 'zip', source: 'files', transport: 'fsa', suggestedName: 'AEGIS-Files-x.zip',
  entries: Object.freeze(sizes.map((size, i) => Object.freeze({ id: `f${i}`, name: `f${i}.bin`, size }))),
})

function runFiles({ plan, transport, zh, signal, idleMs, createWriter, wrapSource } = {}) {
  let source = createFilesEntrySource({ fetchStream: transport.fetchStream, ...(idleMs ? { idleMs } : {}) })
  if (wrapSource) source = wrapSource(source)
  return runBulkZip({
    plan, source, scope: zh.scope, busyRef: { current: false }, signal, isPurged: () => false,
    createHasher: zh.createHasher, ...(createWriter ? { createWriter } : {}),
  })
}

/* ── 7a open phase (I-3) ─────────────────────────────────────────── */

test('FILES-1 happy path: 5 streamed entries, correct paths, bytes and per-entry hashed counts', async () => {
  const sizes = [5, 0, 17, 1, 40]
  const scripts = Object.fromEntries(sizes.map((s, i) => [`f${i}`, { length: String(s), bytes: bytesOf(s, i) }]))
  const transport = makeTransport(scripts)
  const zh = zipHarness()
  const res = await runFiles({ plan: filesPlan(sizes), transport, zh })
  assert.equal(res.status, 'done')
  assert.deepEqual(transport.calls.map((c) => c.path), sizes.map((_, i) => `/api/files/f${i}/download`))
  assert.deepEqual(zh.hashStats.hashedBytes, sizes, 'the writer hashed exactly the declared bytes per entry')
  const out = zh.output()
  // walk local entries: header (30 + 6) + payload + 16-byte descriptor
  let p = 0
  sizes.forEach((s, i) => {
    assert.deepEqual([...out.subarray(p, p + 4)], [0x50, 0x4b, 3, 4])
    const start = p + 30 + 6
    assert.equal(sha(out.subarray(start, start + s)), sha(bytesOf(s, i)))
    p = start + s + 16
  })
  assert.deepEqual(zh.events, ['close'])
})

const openFailures = [
  ['missing Content-Length', { length: undefined, bytes: bytesOf(3) }, 'invalid-length'],
  ['"12a"', { length: '12a', bytes: bytesOf(3) }, 'invalid-length'],
  ['""', { length: '', bytes: bytesOf(3) }, 'invalid-length'],
  ['"-1"', { length: '-1', bytes: bytesOf(3) }, 'invalid-length'],
  ['unsafe', { length: '9007199254740993', bytes: bytesOf(3) }, 'invalid-length'],
  ['mismatch', { length: '4', bytes: bytesOf(3) }, 'size-mismatch'],
  ['null body', { length: '3', body: null }, 'stream-missing'],
  ['network', { network: true }, 'network'],
  ['401', { status: 401 }, 'unauthorized'],
  ['403', { status: 403 }, 'forbidden'],
  ['500', { status: 500 }, 'server'],
]

test('FILES-2 every open failure writes ZERO local-header bytes for that entry and never fetches the next', async () => {
  for (const [label, script, reason] of openFailures) {
    for (const failingIndex of [0, 1]) {
      const scripts = {
        f0: { length: '3', bytes: bytesOf(3) },
        f1: { length: '3', bytes: bytesOf(3) },
        f2: { length: '3', bytes: bytesOf(3) },
        [`f${failingIndex}`]: script,
      }
      const transport = makeTransport(scripts)
      const zh = zipHarness()
      const res = await runFiles({ plan: filesPlan([3, 3, 3]), transport, zh })
      assert.equal(res.status, 'failed', label)
      assert.equal(res.reason, reason, label)
      assert.equal(res.failedEntry.index, failingIndex, label)
      assert.equal(zh.headerPositions().length, failingIndex, `${label}: no local header for the failing entry`)
      if (failingIndex === 0) assert.equal(zh.count(), 0, label)
      else assert.equal(zh.count(), 30 + 6 + 3 + 16, `${label}: output ends right after entry 0's descriptor`)
      assert.ok(!transport.calls.some((c) => c.id === `f${failingIndex + 1}`), `${label}: next entry never fetched`)
      assert.deepEqual(zh.events, ['abort'], label)
      assert.equal(transport.calls.at(-1).signal.aborted, true, `${label}: fetch aborted by cleanup`)
    }
  }
})

test('FILES-3 Content-Length whitespace is trimmed and accepted', async () => {
  const transport = makeTransport({
    f0: { length: ' 3 ', bytes: bytesOf(3) }, f1: { length: '3', bytes: bytesOf(3) },
    f2: { length: '3', bytes: bytesOf(3) }, f3: { length: '3', bytes: bytesOf(3) },
  })
  const zh = zipHarness()
  assert.equal((await runFiles({ plan: filesPlan([3, 3, 3, 3]), transport, zh })).status, 'done')
})

test('FILES-4 the body is never buffered whole: no arrayBuffer anywhere in the source', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/lib/bulkZipDownload.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('arrayBuffer('))
})

/* ── 7b source-idle timer ────────────────────────────────────────── */

async function idleCase(t, { phase, steps }) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const log = []
  const reader = scriptedReader({ log })
  const scripts = {
    f0: phase === 'headers' ? { length: '10', body: 'scripted', reader, hold: true } : { length: '10', body: 'scripted', reader },
    f1: { length: '1', bytes: bytesOf(1) },
  }
  const transport = makeTransport(scripts, { log })
  const zh = zipHarness()
  const p = runFiles({ plan: filesPlan([10, 1]), transport, zh })
  await flush()
  await steps({ reader, tick: async (ms) => { t.mock.timers.tick(ms); await flush() }, zh, log })
  return { res: await p, transport, reader, zh, log, scripts }
}

test('FILES-5a no response headers for 60 s → timeout; fetch aborted, nothing written, next never fetched', async (t) => {
  const { res, transport, zh } = await idleCase(t, { phase: 'headers', steps: async ({ tick }) => { await tick(59_999); await tick(1) } })
  assert.equal(res.reason, 'timeout')
  assert.equal(transport.calls[0].signal.aborted, true)
  assert.equal(zh.count(), 0)
  assert.equal(transport.calls.length, 1)
  assert.deepEqual(zh.events, ['abort'])
})

test('FILES-5b headers, then no positive payload for 60 s → timeout; reader cancelled', async (t) => {
  const { res, transport, reader, zh } = await idleCase(t, { phase: 'body', steps: async ({ tick }) => { await tick(60_000) } })
  assert.equal(res.reason, 'timeout')
  assert.equal(transport.calls[0].signal.aborted, true)
  assert.equal(reader.cancelCalls.length, 1)
  assert.equal(transport.calls.length, 1)
  assert.deepEqual(zh.events, ['abort'])
})

test('FILES-5c zero-length reads do not extend the deadline after the last positive chunk', async (t) => {
  const { res, reader, transport } = await idleCase(t, {
    phase: 'body',
    steps: async ({ reader: r, tick }) => {
      r.chunk(bytesOf(2))
      await flush()
      for (let i = 0; i < 5; i += 1) { await tick(11_000); r.chunk(new Uint8Array(0)); await flush() }
      await tick(5_000)
    },
  })
  assert.equal(res.reason, 'timeout')
  assert.equal(reader.cancelCalls.length, 1)
  assert.equal(transport.calls.length, 1)
})

test('FILES-5d control: 59 s → 1 byte → 59 s does not time out', async (t) => {
  const { res } = await idleCase(t, {
    phase: 'body',
    steps: async ({ reader: r, tick }) => {
      await tick(59_000)
      r.chunk(bytesOf(1))
      await flush()
      await tick(59_000)
      r.chunk(bytesOf(9))
      await flush()
      r.end()
    },
  })
  assert.equal(res.status, 'done')
})

test('FILES-6 SLOW-SINK: a 90 s held archive write never consumes the source-idle budget', async (t) => {
  for (const variant of ['next-chunk-at-59s', 'no-chunk-within-60s']) {
    t.mock.timers.reset()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const reader = scriptedReader()
    let releaseWrite
    let holdNext = false
    const zh = zipHarness({
      writeHold: (bytes) => {
        if (!holdNext || bytes.length !== 4) return null
        holdNext = false
        return new Promise((r) => { releaseWrite = r })
      },
    })
    const transport = makeTransport({ f0: { length: '8', body: 'scripted', reader }, f1: { length: '1', bytes: bytesOf(1) } })
    const p = runFiles({ plan: filesPlan([8, 1]), transport, zh })
    await flush()
    t.mock.timers.tick(30_000)
    holdNext = true
    reader.chunk(bytesOf(4))
    await flush()
    t.mock.timers.tick(90_000) // the archive write is held: no timeout may fire
    await flush()
    assert.equal(transport.calls[0].signal.aborted, false, `${variant}: no timeout during the held write`)
    releaseWrite()
    await flush()
    if (variant === 'next-chunk-at-59s') {
      t.mock.timers.tick(59_000)
      await flush()
      reader.chunk(bytesOf(4))
      await flush()
      reader.end()
      assert.equal((await p).status, 'done', variant)
    } else {
      t.mock.timers.tick(60_000)
      await flush()
      const res = await p
      assert.equal(res.reason, 'timeout', variant)
      assert.deepEqual(zh.events, ['abort'])
    }
  }
})

/* ── 7c cleanup order ────────────────────────────────────────────── */

test('FILES-7 STALLED-READER-CANCEL: fetch aborted before reader.cancel; a never-settling cancel cannot hang the archive', async () => {
  for (const cancelBehaviour of ['never', 'reject-late']) {
    const log = []
    const reader = scriptedReader({ cancelBehaviour, log })
    const transport = makeTransport({ f0: { length: '3', body: 'scripted', reader }, f1: { length: '1', bytes: bytesOf(1) } }, { log })
    const zh = zipHarness()
    const p = runFiles({ plan: filesPlan([3, 1]), transport, zh })
    await flush()
    reader.chunk(bytesOf(5)) // overlong
    const res = await p
    assert.equal(res.reason, 'overlong', cancelBehaviour)
    const iAbort = log.indexOf('fetchCtrl.abort:f0')
    const iCancel = log.indexOf('reader.cancel')
    assert.ok(iAbort >= 0 && iCancel > iAbort, `fetch abort precedes reader.cancel (${log.join(',')})`)
    assert.ok(!log.includes('fetch:f1'))
    assert.deepEqual(zh.events, ['abort'])
    assert.equal(zh.count(), 30 + 6, 'only entry 0 header — none of the overlong bytes were written')
  }
})

test('FILES-8 early EOF, archive write failure, quota, hasher failure', async () => {
  {
    const reader = scriptedReader()
    const transport = makeTransport({ f0: { length: '5', body: 'scripted', reader } })
    const zh = zipHarness()
    const p = runFiles({ plan: filesPlan([5]), transport, zh })
    await flush()
    reader.chunk(bytesOf(2))
    reader.end()
    assert.equal((await p).reason, 'early-eof')
    assert.equal(reader.cancelCalls.length, 1)
  }
  for (const [err, reason] of [[new Error('io'), 'write'], [quotaError(), 'localDiskFull']]) {
    const transport = makeTransport({ f0: { length: '6', bytes: bytesOf(6) }, f1: { length: '1', bytes: bytesOf(1) } })
    const zh = zipHarness({ writeError: (b) => (b.length === 3 ? err : null) })
    const res = await runFiles({ plan: filesPlan([6, 1]), transport, zh })
    assert.equal(res.reason, reason)
    assert.equal(transport.calls[0].signal.aborted, true)
    assert.equal(transport.calls.length, 1)
    assert.deepEqual(zh.events, ['abort'])
  }
  {
    const transport = makeTransport({ f0: { length: '6', bytes: bytesOf(6) } })
    const zh = zipHarness()
    zh.createHasher = async () => ({ init() {}, update() { throw new Error('hasher boom') }, digest() { return '0' } })
    const res = await runFiles({ plan: filesPlan([6]), transport, zh })
    assert.equal(res.reason, 'write')
  }
})

test('FILES-9 explicit Cancel mid-entry → cancelled; cleanup is idempotent', async () => {
  const ctrl = new AbortController()
  const log = []
  const reader = scriptedReader({ log })
  const transport = makeTransport({ f0: { length: '9', body: 'scripted', reader }, f1: { length: '1', bytes: bytesOf(1) } }, { log })
  const zh = zipHarness()
  const source = createFilesEntrySource({ fetchStream: transport.fetchStream })
  let opened
  const wrapped = { open: async (e, s) => { opened = await source.open(e, s); return opened } }
  const p = runBulkZip({ plan: filesPlan([9, 1]), source: wrapped, scope: zh.scope, busyRef: { current: false }, signal: ctrl.signal, isPurged: () => false, createHasher: zh.createHasher })
  await flush()
  reader.chunk(bytesOf(3))
  await flush()
  ctrl.abort()
  const res = await p
  assert.deepEqual(res, { status: 'cancelled' })
  opened.dispose('cancelled')
  opened.dispose('timeout')
  assert.equal(log.filter((l) => l === 'fetchCtrl.abort:f0').length, 1, 'aborted once')
  assert.equal(reader.cancelCalls.length, 1, 'cancelled once')
  assert.ok(!log.includes('fetch:f1'))
})

test('FILES-10 dispose() before pump(): the fetch is aborted and a body reader is never acquired', async () => {
  const transport = makeTransport({ f0: { length: '3', bytes: bytesOf(3) } })
  const source = createFilesEntrySource({ fetchStream: transport.fetchStream })
  const opened = await source.open({ id: 'f0', name: 'f0.bin', size: 3 }, new AbortController().signal)
  assert.equal(opened.ok, true)
  assert.equal(opened.size, 3)
  opened.dispose('cancelled')
  assert.equal(transport.calls[0].signal.aborted, true)
  const res = await opened.pump({ write() { throw new Error('must not write') } }, new AbortController().signal)
  assert.equal(res.ok, false)
})

/* ── 7d ADDENTRY-FAIL-DISPOSE (Fix E) ────────────────────────────── */

test('FILES-11 ADDENTRY-FAIL-DISPOSE: addEntry throws after open → dispose once, fetch aborted, reader never acquired', async () => {
  for (const variant of ['writer-throws', 'quota-on-header']) {
    const reader = scriptedReader()
    const scripts = { f0: { length: '2', bytes: bytesOf(2) }, f1: { length: '4', body: 'scripted', reader }, f2: { length: '1', bytes: bytesOf(1) } }
    const transport = makeTransport(scripts)
    let headers = 0
    const zh = zipHarness({
      writeError: variant === 'quota-on-header'
        ? (b) => (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 && ++headers === 2 ? quotaError() : null)
        : null,
    })
    const createWriter = (opts) => {
      const w = createZipStreamWriter(opts)
      return variant === 'writer-throws'
        ? { ...w, async addEntry(e) { if (e.name === 'f1.bin') throw new Error('boom'); return w.addEntry(e) } }
        : w
    }
    let disposeCalls = 0
    let abortedRightAfterDispose = null
    const wrapSource = (s) => ({
      open: async (e, sig) => {
        const o = await s.open(e, sig)
        if (!o.ok) return o
        return {
          ...o,
          dispose(reason) {
            disposeCalls += 1
            o.dispose(reason)
            abortedRightAfterDispose = transport.calls.at(-1).signal.aborted
          },
        }
      },
    })
    const res = await runFiles({ plan: filesPlan([2, 4, 1]), transport, zh, createWriter, wrapSource })
    assert.equal(res.status, 'failed', variant)
    assert.equal(res.reason, variant === 'writer-throws' ? 'write' : 'localDiskFull', variant)
    assert.equal(disposeCalls, 1, `${variant}: dispose exactly once`)
    assert.equal(abortedRightAfterDispose, true, `${variant}: fetch aborted synchronously by dispose`)
    assert.equal(scripts.f1.bodyObj.getReaderCalls, 0, `${variant}: no reader acquired`)
    assert.ok(!transport.calls.some((c) => c.id === 'f2'), `${variant}: next entry never fetched`)
    assert.deepEqual(zh.events, ['abort'], variant)
  }
})

test('FILES-12 a size mismatch reported by the orchestrator also disposes once with no reader acquired', async () => {
  const scripts = { f0: { length: '3', bytes: bytesOf(3) } }
  const transport = makeTransport(scripts)
  const zh = zipHarness()
  let disposeCalls = 0
  const wrapSource = (s) => ({
    open: async (e, sig) => {
      const o = await s.open(e, sig)
      return { ...o, size: 99, dispose(r) { disposeCalls += 1; o.dispose(r) } }
    },
  })
  const res = await runFiles({ plan: filesPlan([3]), transport, zh, wrapSource })
  assert.equal(res.reason, 'size-mismatch')
  assert.equal(disposeCalls, 1)
  assert.equal(transport.calls[0].signal.aborted, true)
  assert.equal(scripts.f0.bodyObj.getReaderCalls, 0)
})

/* ── Files stream memory retention (spec §15 / A11, acceptance blocker) ──
   A stop wait that stays subscribed to a long-lived promise keeps every settled read (and its chunk)
   reachable until the entry ends — memory then grows with bytes streamed. Each read's stop subscription
   must be detached as soon as that read settles. */

function manyChunkTransport(chunks, chunkSize) {
  const total = chunks * chunkSize
  let served = 0
  const fetchStream = async () => ({
    ok: true, status: 200, errorKind: null, headers: new Headers({ 'Content-Length': String(total) }),
    body: new ReadableStream({
      pull(c) {
        if (served >= chunks) { c.close(); return }
        served += 1
        c.enqueue(new Uint8Array(chunkSize).fill(served & 0xff))
      },
    }, { highWaterMark: 0 }),
  })
  return { fetchStream, total, servedCount: () => served }
}

test('FILES-STOP-NO-RACE-RETENTION no settled read stays subscribed to a still-pending stop promise', async (t) => {
  const pending = new WeakSet()
  const watched = new WeakSet()
  const track = (p) => {
    if (!(p instanceof Promise) || watched.has(p)) return
    watched.add(p)
    pending.add(p)
    p.then(() => pending.delete(p), () => pending.delete(p))
  }
  const raceCalls = []
  const realRace = Promise.race.bind(Promise)
  t.mock.method(Promise, 'race', (iterable) => {
    const arr = [...iterable]
    arr.forEach(track)
    raceCalls.push(arr)
    return realRace(arr)
  })
  const CHUNKS = 64
  const tr = manyChunkTransport(CHUNKS, 1024)
  const zh = zipHarness()
  const res = await runFiles({ plan: filesPlan([tr.total]), transport: tr, zh })
  assert.equal(res.status, 'done')
  t.mock.restoreAll()
  const retained = raceCalls.filter((arr) => arr.some((p) => p instanceof Promise && pending.has(p)))
  assert.equal(retained.length, 0, `${retained.length} race subscription(s) still attached to a pending promise after success (one per read = O(bytes) retention)`)
})

/** A stop gate instrumented to count live per-wait subscriptions (wraps the module's real gate). */
async function instrumentedGateFactory() {
  const { createStopGate } = await import('../src/lib/bulkZipDownload.js')
  const stats = { maxActive: 0, gates: [] }
  const factory = () => {
    const g = createStopGate()
    stats.gates.push(g)
    return {
      stop: () => g.stop(),
      get stopped() { return g.stopped },
      get activeWaiters() { return g.activeWaiters },
      wait(p) {
        const w = g.wait(p)
        stats.maxActive = Math.max(stats.maxActive, g.activeWaiters)
        return w
      },
    }
  }
  return { factory, stats }
}

test('FILES-READ-WAITER-NO-RETENTION many successful chunks: at most one live stop waiter, zero after success', async () => {
  const { factory, stats } = await instrumentedGateFactory()
  const tr = manyChunkTransport(200, 512)
  const zh = zipHarness()
  const source = createFilesEntrySource({ fetchStream: tr.fetchStream, stopGate: factory })
  const res = await runBulkZip({ plan: filesPlan([tr.total]), source, scope: zh.scope, busyRef: { current: false }, isPurged: () => false, createHasher: zh.createHasher })
  assert.equal(res.status, 'done')
  assert.equal(stats.gates.length, 1)
  assert.ok(stats.maxActive <= 1, `max active waiters ${stats.maxActive}`)
  assert.equal(stats.gates[0].activeWaiters, 0, 'no waiter left after success')
  assert.equal(tr.servedCount(), 200)
})

test('FILES-READ-WAITER-CANCEL stop wins a pending read: the wait settles once, its waiter is removed, fetch aborted, nothing later', async () => {
  const { factory, stats } = await instrumentedGateFactory()
  const log = []
  const reader = scriptedReader({ log, cancelBehaviour: 'never' })
  const transport = makeTransport({ f0: { length: '9', body: 'scripted', reader }, f1: { length: '1', bytes: bytesOf(1) } }, { log })
  const zh = zipHarness()
  const ctrl = new AbortController()
  const source = createFilesEntrySource({ fetchStream: transport.fetchStream, stopGate: factory })
  const p = runBulkZip({ plan: filesPlan([9, 1]), source, scope: zh.scope, busyRef: { current: false }, signal: ctrl.signal, isPurged: () => false, createHasher: zh.createHasher })
  await flush()
  reader.chunk(bytesOf(3))
  await flush()
  assert.equal(stats.gates[0].activeWaiters, 1, 'the pending read is the only subscribed waiter')
  ctrl.abort()
  const res = await p
  assert.deepEqual(res, { status: 'cancelled' })
  assert.equal(stats.gates[0].activeWaiters, 0, 'the winning stop removed the waiter')
  assert.equal(transport.calls[0].signal.aborted, true)
  assert.ok(log.indexOf('fetchCtrl.abort:f0') < log.indexOf('reader.cancel'))
  assert.ok(!log.includes('fetch:f1'), 'no later entry')
  reader.chunk(bytesOf(3)) // a late read result after stop must not throw or write
  await flush()
  assert.deepEqual(zh.events, ['abort'])
})

test('STOP-GATE-1 generic gate: value wins → waiter detached; stop wins → STOPPED once; late rejection is swallowed', async () => {
  const { createStopGate, STOPPED } = await import('../src/lib/bulkZipDownload.js')
  const g = createStopGate()
  assert.equal(await g.wait(Promise.resolve(7)), 7)
  assert.equal(g.activeWaiters, 0)
  let rejectLate
  const late = new Promise((_, rej) => { rejectLate = rej })
  const w = g.wait(late)
  assert.equal(g.activeWaiters, 1)
  g.stop()
  g.stop()
  assert.equal(await w, STOPPED)
  assert.equal(g.activeWaiters, 0)
  rejectLate(new Error('late'))
  await flush()
  assert.equal(await g.wait(Promise.resolve(1)), STOPPED, 'after stop, waits resolve STOPPED immediately')
  assert.equal(g.activeWaiters, 0)
  await assert.rejects(createStopGate().wait(Promise.reject(new Error('boom'))), /boom/)
})

test('FILES-CHUNK-NOT-RETAINED settled chunks become collectable while the entry is still streaming (forced GC)', async (t) => {
  const v8 = await import('node:v8')
  const vm = await import('node:vm')
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc')
  const registry = new FinalizationRegistry(() => { collected += 1 })
  let collected = 0
  const CHUNKS = 40
  let served = 0
  let releaseLast
  const holdLast = new Promise((r) => { releaseLast = r })
  const fetchStream = async () => ({
    ok: true, status: 200, errorKind: null, headers: new Headers({ 'Content-Length': String(CHUNKS * 4096) }),
    body: new ReadableStream({
      async pull(c) {
        if (served === CHUNKS - 1) await holdLast // keep the entry open after 39 settled reads
        if (served >= CHUNKS) { c.close(); return }
        served += 1
        const chunk = new Uint8Array(4096)
        registry.register(chunk, served)
        c.enqueue(chunk)
      },
    }, { highWaterMark: 0 }),
  })
  const zh = zipHarness()
  const source = createFilesEntrySource({ fetchStream })
  const run = runBulkZip({ plan: filesPlan([CHUNKS * 4096]), source, scope: zh.scope, busyRef: { current: false }, isPurged: () => false, createHasher: zh.createHasher })
  while (served < CHUNKS - 1) await flush(2)
  await flush(5)
  for (let i = 0; i < 6; i += 1) { gc(); await new Promise((r) => setTimeout(r, 10)) }
  const collectedMidEntry = collected
  releaseLast()
  assert.equal((await run).status, 'done')
  // the harness sink keeps written bytes as copies, so the source's own chunk objects must be collectable
  assert.ok(collectedMidEntry >= CHUNKS - 5, `only ${collectedMidEntry} of ${CHUNKS - 1} settled chunks were collectable mid-entry`)
})
