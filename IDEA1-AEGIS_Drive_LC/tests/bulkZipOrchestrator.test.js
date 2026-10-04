// tests/bulkZipOrchestrator.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 6
//
// runBulkZip is the one place that owns the security-critical ordering (spec §13, §16–§20):
//   picker (first await, inside the click) → hasher → pre-flight → effective plan → createWritable
//   → per entry: open → addEntry (first local-header byte) → pump → entry close
//   → finish → final signal/isPurged check → close()
// Any failure before close() begins = exactly one abort() attempt, never close(). After a successful
// open() the orchestrator owns the handle and disposes it exactly once on any failure (SC-1, Fix E).
// After pre-flight only the EFFECTIVE plan drives sizes, layout and progress (SC-4, Fix C/D).
import test from 'node:test'
import assert from 'node:assert/strict'

import { runBulkZip } from '../src/lib/bulkZipDownload.js'
import { createZipStreamWriter } from '../src/lib/zipStreamWriter.js'
import { zipLayout } from '../src/lib/bulkDownloadPlan.js'

const MiB = 1024 * 1024
const enc = new TextEncoder()

const quotaError = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** A frozen Files-shaped plan (entries already named and sized). */
function makePlan(payloads, { transport = 'fsa', names } = {}) {
  const entries = Object.freeze(payloads.map((p, i) => Object.freeze({ id: `f${i}`, name: names?.[i] ?? `file${i}.bin`, size: p.length })))
  return Object.freeze({
    mode: 'zip', source: 'files', transport, entries, suggestedName: 'AEGIS-Files-20261005-070809.zip',
    totalBytes: payloads.reduce((s, p) => s + p.length, 0),
  })
}

/** Event log shared by every fake, so ordering assertions read one list. */
function harness({
  pickerError = null, createWritableError = null, closeError = null, abortError: abortRejects = null,
  writeErrorAt = null, onWrite = null, closeHold = null,
} = {}) {
  const events = []
  const written = []
  let writes = 0
  const writable = {
    async write(bytes) {
      writes += 1
      if (writeErrorAt && writes === writeErrorAt.n) throw writeErrorAt.error
      written.push(bytes.slice())
      events.push(`write:${bytes.length}`)
      onWrite?.(bytes, writes)
    },
    async close() {
      events.push('close')
      if (closeHold) await closeHold
      if (closeError) throw closeError
    },
    async abort() {
      events.push('abort')
      if (abortRejects) throw abortRejects
    },
  }
  const scope = {
    pickerCalls: [],
    showSaveFilePicker(opts) {
      scope.pickerCalls.push(opts)
      events.push('picker')
      if (pickerError) return Promise.reject(pickerError)
      return Promise.resolve({
        async createWritable() {
          events.push('createWritable')
          if (createWritableError) throw createWritableError
          return writable
        },
      })
    },
  }
  const writerCalls = []
  const createWriter = (opts) => {
    writerCalls.push(opts)
    const w = createZipStreamWriter(opts)
    return {
      ...w,
      async begin() { events.push('hasher'); return w.begin() },
      async addEntry(e) { events.push(`addEntry:${e.name}:${e.size}`); return w.addEntry(e) },
      async finish() { events.push('finish'); return w.finish() },
    }
  }
  const output = () => {
    const total = written.reduce((s, b) => s + b.length, 0)
    const out = new Uint8Array(total)
    let p = 0
    for (const b of written) { out.set(b, p); p += b.length }
    return out
  }
  return { events, scope, writable, writerCalls, createWriter, output, writesCount: () => writes }
}

/** A scripted SC-1 source. `payloads[i]` is what pump writes; options inject failures. */
function makeSource(events, payloads, {
  openFail = {}, openSize = {}, pumpFail = {}, pumpSwallowWriteError = false, onOpen = null, preflight = null,
} = {}) {
  const disposes = []
  const pumps = []
  const source = {
    disposes, pumps,
    async open(entry) {
      const i = Number(String(entry.id ?? entry.nodeId).replace(/\D/g, ''))
      events.push(`open:${i}`)
      if (openFail[i]) return { ok: false, reason: openFail[i] }
      await onOpen?.(i)
      return {
        ok: true,
        size: openSize[i] ?? entry.size,
        async pump(entrySink) {
          pumps.push(i)
          events.push(`pump:${i}`)
          if (pumpFail[i]) return { ok: false, reason: pumpFail[i] }
          const bytes = payloads[i]
          try {
            if (bytes.length > 1) {
              await entrySink.write(bytes.subarray(0, 1))
              await entrySink.write(bytes.subarray(1))
            } else {
              await entrySink.write(bytes)
            }
          } catch (err) {
            if (pumpSwallowWriteError) return { ok: false, reason: 'failed' } // like downloadVaultV2
            throw err
          }
          return { ok: true }
        },
        dispose(reason) { disposes.push({ i, reason }); events.push(`dispose:${i}:${reason}`) },
      }
    },
  }
  if (preflight) source.preflight = async (plan, signal) => { events.push('preflight'); return preflight(plan, signal) }
  return source
}

const payloadsOf = (...sizes) => sizes.map((n, k) => {
  const b = new Uint8Array(n)
  for (let j = 0; j < n; j += 1) b[j] = (j * 7 + k) & 0xff
  return b
})

async function run(opts) {
  return runBulkZip({ isPurged: () => false, ...opts })
}

/* ── picker-first and transfer busy ──────────────────────────────── */

test('ORCH-1 exactly one picker, requested before runBulkZip returns, with the ZIP type', async () => {
  const h = harness()
  const payloads = payloadsOf(3, 4, 5, 6)
  const plan = makePlan(payloads)
  const p = run({ plan, source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.equal(h.scope.pickerCalls.length, 1, 'picker requested synchronously')
  assert.deepEqual(h.events, ['picker'])
  assert.deepEqual(h.scope.pickerCalls[0], {
    suggestedName: plan.suggestedName,
    types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
  })
  const res = await p
  assert.equal(res.status, 'done')
  assert.equal(h.scope.pickerCalls.length, 1)
})

test('ORCH-2 transfer busy: refused synchronously when held; claimed before the picker; released on every outcome', async () => {
  const payloads = payloadsOf(1, 1, 1, 1)
  const plan = makePlan(payloads)
  {
    const h = harness()
    const res = await run({ plan, source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: true }, createWriter: h.createWriter })
    assert.deepEqual(res, { status: 'busy' })
    assert.equal(h.scope.pickerCalls.length, 0)
  }
  for (const variant of ['done', 'failed', 'cancelled']) {
    const h = harness({ pickerError: variant === 'cancelled' ? abortError() : null })
    const busyRef = { current: false }
    const seen = []
    const orig = h.scope.showSaveFilePicker
    h.scope.showSaveFilePicker = (o) => { seen.push(busyRef.current); return orig(o) }
    const res = await run({
      plan, source: makeSource(h.events, payloads, { openFail: variant === 'failed' ? { 1: 'network' } : {} }),
      scope: h.scope, busyRef, createWriter: h.createWriter,
    })
    assert.equal(res.status, variant)
    assert.deepEqual(seen, [true], 'busy claimed before the picker call')
    assert.equal(busyRef.current, false, `released after ${variant}`)
  }
  {
    const h = harness()
    const busyRef = { current: false }
    const first = run({ plan, source: makeSource(h.events, payloads), scope: h.scope, busyRef, createWriter: h.createWriter })
    const second = await run({ plan, source: makeSource(h.events, payloads), scope: h.scope, busyRef, createWriter: h.createWriter })
    assert.deepEqual(second, { status: 'busy' })
    assert.equal((await first).status, 'done')
    assert.equal(h.scope.pickerCalls.length, 1, 'single-flight')
  }
})

test('ORCH-3 order: picker → hasher → preflight → createWritable → [open → addEntry → pump]* → finish → close', async () => {
  const h = harness()
  const payloads = payloadsOf(2, 0, 3, 1)
  const plan = makePlan(payloads)
  const source = makeSource(h.events, payloads, { preflight: (p) => ({ ok: true, effectivePlan: p }) })
  const res = await run({ plan, source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.equal(res.status, 'done')
  const order = h.events.filter((e) => !e.startsWith('write:'))
  assert.deepEqual(order, [
    'picker', 'hasher', 'preflight', 'createWritable',
    'open:0', 'addEntry:file0.bin:2', 'pump:0',
    'open:1', 'addEntry:file1.bin:0', 'pump:1',
    'open:2', 'addEntry:file2.bin:3', 'pump:2',
    'open:3', 'addEntry:file3.bin:1', 'pump:3',
    'finish', 'close',
  ])
  assert.deepEqual(source.disposes, [], 'a successful entry is never disposed')
  assert.ok(!h.events.includes('abort'))
})

/* ── SC-1 order and handle ownership (Fix E) ─────────────────────── */

test('ORCH-4 open failure: no local header for that entry, no next open, one abort, no close', async () => {
  const h = harness()
  const payloads = payloadsOf(3, 3, 3, 3)
  const plan = makePlan(payloads)
  const source = makeSource(h.events, payloads, { openFail: { 1: 'network' } })
  const res = await run({ plan, source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'network')
  assert.deepEqual(res.failedEntry, { index: 1, name: 'file1.bin' })
  assert.ok(!h.events.some((e) => e.startsWith('addEntry:file1')))
  assert.ok(!h.events.includes('open:2'))
  assert.equal(h.events.filter((e) => e === 'abort').length, 1)
  assert.ok(!h.events.includes('close'))
  assert.deepEqual(source.disposes, [], 'open failed, so there is no handle to dispose')
})

test('ORCH-5 opened.size !== entry.size: dispose(size-mismatch) once, no addEntry, failure', async () => {
  const h = harness()
  const payloads = payloadsOf(3, 3, 3, 3)
  const source = makeSource(h.events, payloads, { openSize: { 2: 4 } })
  const res = await run({ plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'size-mismatch')
  assert.deepEqual(source.disposes, [{ i: 2, reason: 'size-mismatch' }])
  assert.ok(!h.events.some((e) => e.startsWith('addEntry:file2')))
  assert.ok(!source.pumps.includes(2))
  assert.equal(h.events.filter((e) => e === 'abort').length, 1)
  assert.ok(!h.events.includes('close'))
})

test('ORCH-6 writer.addEntry throws after a successful open: dispose once, no pump, one abort, no next open', async () => {
  // variant A: the writer itself throws
  {
    const h = harness()
    const payloads = payloadsOf(3, 3, 3, 3)
    const source = makeSource(h.events, payloads)
    const createWriter = (opts) => {
      const w = h.createWriter(opts)
      return { ...w, async addEntry(e) { if (e.name === 'file1.bin') throw new Error('boom'); return w.addEntry(e) } }
    }
    const res = await run({ plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter })
    assert.equal(res.status, 'failed')
    assert.equal(res.reason, 'write')
    assert.deepEqual(source.disposes, [{ i: 1, reason: 'write' }])
    assert.ok(!source.pumps.includes(1))
    assert.ok(!h.events.includes('open:2'))
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(!h.events.includes('close'))
  }
  // variant B: the archive rejects entry 1's local-header write with QuotaExceededError
  {
    let headerWrites = 0
    const h = harness()
    const payloads = payloadsOf(3, 3, 3, 3)
    const orig = h.writable.write
    h.writable.write = async (bytes) => {
      const isHeader = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
      if (isHeader && ++headerWrites === 2) throw quotaError()
      return orig.call(h.writable, bytes)
    }
    const source = makeSource(h.events, payloads)
    const res = await run({ plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
    assert.equal(res.status, 'failed')
    assert.equal(res.reason, 'localDiskFull')
    assert.deepEqual(source.disposes, [{ i: 1, reason: 'localDiskFull' }])
    assert.ok(!source.pumps.includes(1))
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(!h.events.includes('close'))
  }
})

test('ORCH-7 Cancel or lock between open and pump: dispose(cancelled) once, no addEntry/pump, abort, cancelled', async () => {
  for (const kind of ['cancel', 'lock']) {
    const h = harness()
    const payloads = payloadsOf(3, 3, 3, 3)
    const ctrl = new AbortController()
    let purged = false
    const source = makeSource(h.events, payloads, {
      onOpen: (i) => { if (i === 1) { if (kind === 'cancel') ctrl.abort(); else purged = true } },
    })
    const res = await runBulkZip({
      plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter,
      signal: ctrl.signal, isPurged: () => purged,
    })
    assert.equal(res.status, 'cancelled', kind)
    assert.deepEqual(source.disposes, [{ i: 1, reason: 'cancelled' }])
    assert.ok(!h.events.some((e) => e.startsWith('addEntry:file1')))
    assert.ok(!source.pumps.includes(1))
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(!h.events.includes('close'))
  }
})

test('ORCH-8 pump returns ok:false: dispose once, one abort, no close, reason and failed entry reported', async () => {
  const h = harness()
  const payloads = payloadsOf(3, 3, 3, 3)
  const source = makeSource(h.events, payloads, { pumpFail: { 2: 'early-eof' } })
  const res = await run({ plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.deepEqual(res, { status: 'failed', reason: 'early-eof', failedEntry: { index: 2, name: 'file2.bin' } })
  assert.deepEqual(source.disposes, [{ i: 2, reason: 'early-eof' }])
  assert.equal(h.events.filter((e) => e === 'abort').length, 1)
  assert.ok(!h.events.includes('close'))
  assert.ok(!h.events.includes('open:3'))
})

/* ── SC-4 effective plan (Fix C/D) ───────────────────────────────── */

function sentinelPlan(transport = 'fsa') {
  // provisional size is the sentinel 7; the authenticated (effective) size is 5
  const entries = Object.freeze([0, 1, 2, 3].map((i) => Object.freeze({ nodeId: `n${i}`, name: `v${i}.bin`, size: 7, blob: Object.freeze({ id: `B${i}` }) })))
  return Object.freeze({ mode: 'zip', source: 'vault', transport, entries, suggestedName: 'AEGIS-Vault-export-20261005-070809.zip', totalBytes: 28 })
}
const effectiveOf = (plan, size = 5) => Object.freeze({
  ...plan,
  entries: Object.freeze(plan.entries.map((e) => Object.freeze({ nodeId: e.nodeId, name: e.name, blob: e.blob, size }))),
})

test('ORCH-9 after pre-flight only the effective sizes reach layout, addEntry, open check, progress and the physical total', async () => {
  const h = harness()
  const plan = sentinelPlan()
  const payloads = payloadsOf(5, 5, 5, 5)
  const layoutCalls = []
  const computeLayout = (entries, o) => { layoutCalls.push(entries); return zipLayout(entries, o) }
  const progress = []
  let effective
  const source = makeSource(h.events, payloads, {
    preflight: (p) => { effective = effectiveOf(p); return { ok: true, effectivePlan: effective } },
  })
  const res = await run({
    plan, source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter, computeLayout,
    onProgress: (s) => progress.push(s),
  })
  assert.equal(res.status, 'done')
  assert.ok(layoutCalls.length >= 1)
  for (const c of layoutCalls) assert.equal(c, effective.entries, 'layout only ever sees the effective entries')
  const adds = h.events.filter((e) => e.startsWith('addEntry:'))
  assert.equal(adds.length, 4)
  for (const a of adds) assert.ok(a.endsWith(':5'), a)
  assert.ok(!adds.some((a) => a.endsWith(':7')), 'the provisional sentinel never reaches addEntry')
  for (const s of progress.filter((x) => x.stage !== 'preparing')) assert.equal(s.totalBytes, 20)
  assert.equal(h.output().length, zipLayout(effective.entries).total)
  assert.ok(Object.isFrozen(plan))
  assert.ok(plan.entries.every((e) => e.size === 7), 'the original plan is unchanged')
})

test('ORCH-10 an open() reporting the provisional sentinel fails with size-mismatch', async () => {
  const h = harness()
  const plan = sentinelPlan()
  const payloads = payloadsOf(5, 5, 5, 5)
  const source = makeSource(h.events, payloads, {
    preflight: (p) => ({ ok: true, effectivePlan: effectiveOf(p) }),
    openSize: { 0: 7 },
  })
  const res = await run({ plan, source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.equal(res.reason, 'size-mismatch')
  assert.deepEqual(source.disposes, [{ i: 0, reason: 'size-mismatch' }])
})

test('ORCH-11 pre-flight failure or an entry-count change: no createWritable, nothing written', async () => {
  for (const [label, preflight, reason] of [
    ['integrity', () => ({ ok: false, reason: 'integrity', index: 2 }), 'integrity'],
    ['wrong-key', () => ({ ok: false, reason: 'wrong-key', index: 0 }), 'wrong-key'],
    ['count', (p) => ({ ok: true, effectivePlan: Object.freeze({ ...p, entries: Object.freeze(p.entries.slice(1)) }) }), 'integrity'],
  ]) {
    const h = harness()
    const plan = sentinelPlan()
    const source = makeSource(h.events, payloadsOf(5, 5, 5, 5), { preflight })
    const res = await run({ plan, source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
    assert.equal(res.status, 'failed', label)
    assert.equal(res.reason, reason, label)
    assert.ok(!h.events.includes('createWritable'), label)
    assert.ok(!h.events.some((e) => e.startsWith('open:')), label)
    assert.equal(h.writesCount(), 0)
    if (label === 'integrity') assert.deepEqual(res.failedEntry, { index: 2, name: 'v2.bin' })
  }
})

test('ORCH-12 buffered path: the 64 MiB cap is re-checked on the effective layout (provisional fits, effective does not)', async () => {
  const h = harness()
  const plan = sentinelPlan('buffered')
  const bufferedWrites = []
  const source = makeSource(h.events, payloadsOf(5, 5, 5, 5), {
    preflight: (p) => ({ ok: true, effectivePlan: effectiveOf(p, 17 * MiB) }),
  })
  const res = await run({
    plan, source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter,
    createBufferedSink: () => ({ kind: 'buffered', async write(b) { bufferedWrites.push(b) }, async close() { return [] }, async abort() {} }),
  })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'too-large')
  assert.equal(h.scope.pickerCalls.length, 0, 'no picker on the buffered path')
  assert.equal(bufferedWrites.length, 0)
  assert.ok(!h.events.some((e) => e.startsWith('open:')))
})

test('ORCH-13 without preflight (Files) the effective plan IS the original plan', async () => {
  const h = harness()
  const payloads = payloadsOf(1, 2, 3, 4)
  const plan = makePlan(payloads)
  const layoutCalls = []
  const res = await run({
    plan, source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter,
    computeLayout: (entries, o) => { layoutCalls.push(entries); return zipLayout(entries, o) },
  })
  assert.equal(res.status, 'done')
  assert.ok(layoutCalls.length >= 1)
  for (const c of layoutCalls) assert.equal(c, plan.entries)
})

/* ── picker and destination failures ─────────────────────────────── */

test('ORCH-14 picker AbortError = cancelled with nothing opened; other picker error = picker; createWritable throw = destination', async () => {
  const payloads = payloadsOf(1, 1, 1, 1)
  {
    const h = harness({ pickerError: abortError() })
    const res = await run({ plan: makePlan(payloads), source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
    assert.deepEqual(res, { status: 'cancelled' })
    assert.deepEqual(h.events, ['picker'])
  }
  {
    const h = harness({ pickerError: new Error('SecurityError') })
    const res = await run({ plan: makePlan(payloads), source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
    assert.deepEqual(res, { status: 'failed', reason: 'picker' })
    assert.deepEqual(h.events, ['picker'])
  }
  {
    const h = harness({ createWritableError: new Error('denied') })
    const res = await run({ plan: makePlan(payloads), source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
    assert.deepEqual(res, { status: 'failed', reason: 'destination' })
    assert.ok(!h.events.some((e) => e.startsWith('open:')))
  }
})

/* ── state machine: fail-closed finalisation ─────────────────────── */

test('ORCH-15 Cancel mid-entry or a lock between entries / before close = one abort, never close', async () => {
  // Cancel during entry 2's pump
  {
    const h = harness()
    const payloads = payloadsOf(3, 3, 3, 3)
    const ctrl = new AbortController()
    const source = makeSource(h.events, payloads, { pumpFail: {} })
    const origOpen = source.open
    source.open = async (entry, signal) => {
      const o = await origOpen(entry, signal)
      if (entry.id === 'f2') {
        return { ...o, async pump(es) { ctrl.abort(); return { ok: false, reason: 'cancelled' } } }
      }
      return o
    }
    const res = await runBulkZip({ plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter, signal: ctrl.signal, isPurged: () => false })
    assert.deepEqual(res, { status: 'cancelled' })
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(!h.events.includes('close'))
    assert.ok(!h.events.includes('open:3'))
  }
  // lock observed between entries (no signal observer)
  {
    const h = harness()
    const payloads = payloadsOf(3, 3, 3, 3)
    let purged = false
    const source = makeSource(h.events, payloads)
    const origOpen = source.open
    source.open = async (e, s) => { const o = await origOpen(e, s); return { ...o, async pump(es, sig) { const r = await o.pump(es, sig); if (e.id === 'f1') purged = true; return r } } }
    const res = await runBulkZip({ plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter, isPurged: () => purged })
    assert.equal(res.status, 'cancelled')
    assert.ok(!h.events.includes('open:2'))
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(!h.events.includes('close'))
  }
  // lock after the last entry, just before close
  {
    const h = harness()
    const payloads = payloadsOf(3, 3, 3, 3)
    let purged = false
    const createWriter = (opts) => { const w = h.createWriter(opts); return { ...w, async finish() { await w.finish(); purged = true } } }
    const res = await runBulkZip({ plan: makePlan(payloads), source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter, isPurged: () => purged })
    assert.equal(res.status, 'cancelled')
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(!h.events.includes('close'))
  }
})

test('ORCH-16 final-write race: an abort after the last descriptor but before close() aborts, never closes', async () => {
  const ctrl = new AbortController()
  const h = harness({ onWrite: (bytes) => { if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 5 && bytes[3] === 6) ctrl.abort() } })
  const payloads = payloadsOf(3, 3, 3, 3)
  const res = await runBulkZip({ plan: makePlan(payloads), source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter, signal: ctrl.signal, isPurged: () => false })
  assert.equal(res.status, 'cancelled')
  assert.equal(h.events.filter((e) => e === 'abort').length, 1)
  assert.ok(!h.events.includes('close'))
})

test('ORCH-17 close() rejection: at most one abort, finalizeFailed (quota → localDiskFull), never success', async () => {
  for (const [err, reason] of [[new Error('io'), 'finalizeFailed'], [quotaError(), 'localDiskFull']]) {
    const h = harness({ closeError: err })
    const payloads = payloadsOf(1, 1, 1, 1)
    const res = await run({ plan: makePlan(payloads), source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
    assert.deepEqual(res, { status: 'failed', reason })
    assert.equal(h.events.filter((e) => e === 'close').length, 1)
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(h.events.indexOf('abort') > h.events.indexOf('close'))
  }
})

test('ORCH-18 QuotaExceededError on a payload write = localDiskFull, abort, no close — even when the source swallows it', async () => {
  for (const swallow of [false, true]) {
    // writes: 1 header e0, 2–3 payload e0, 4 descriptor e0, 5 header e1, 6 first payload write of e1
    const h = harness({ writeErrorAt: { n: 6, error: quotaError() } })
    const payloads = payloadsOf(3, 3, 3, 3)
    const source = makeSource(h.events, payloads, { pumpSwallowWriteError: swallow })
    const res = await run({ plan: makePlan(payloads), source, scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
    assert.equal(res.status, 'failed')
    assert.equal(res.reason, 'localDiskFull', `swallow=${swallow}`)
    assert.equal(h.events.filter((e) => e === 'abort').length, 1)
    assert.ok(!h.events.includes('close'))
  }
})

test('ORCH-19 an abort() rejection is swallowed', async () => {
  const h = harness({ abortError: new Error('abort failed') })
  const payloads = payloadsOf(3, 3, 3, 3)
  const res = await run({ plan: makePlan(payloads), source: makeSource(h.events, payloads, { openFail: { 0: 'server' } }), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'server')
})

/* ── progress ────────────────────────────────────────────────────── */

test('ORCH-20 progress: nothing before the picker returns; preparing → archiving → finalizing; ≤ 99.9 until close resolves, then 100', async () => {
  let releaseClose
  const closeHold = new Promise((r) => { releaseClose = r })
  const h = harness({ closeHold })
  const payloads = payloadsOf(100, 0, 50, 250)
  const progress = []
  const ctrl = new AbortController()
  const p = runBulkZip({
    plan: makePlan(payloads, { names: ['a.bin', 'b.bin', 'c.bin', 'd.bin'] }), source: makeSource(h.events, payloads),
    scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter, signal: ctrl.signal, isPurged: () => false,
    onProgress: (s) => progress.push(s),
  })
  assert.equal(progress.length, 0, 'no progress before the picker returns')
  while (!h.events.includes('close')) await new Promise((r) => setTimeout(r, 0))
  const last = progress.at(-1)
  assert.equal(last.stage, 'finalizing')
  assert.ok(last.percent <= 99.9)
  ctrl.abort() // Cancel once close() has begun is a no-op
  releaseClose()
  const res = await p
  assert.equal(res.status, 'done')
  assert.ok(!h.events.includes('abort'))
  const stages = [...new Set(progress.map((s) => s.stage))]
  assert.deepEqual(stages, ['preparing', 'archiving', 'finalizing', 'done'])
  const archiving = progress.filter((s) => s.stage === 'archiving')
  assert.deepEqual([...new Set(archiving.map((s) => `${s.index}/${s.count}:${s.name}`))], ['1/4:a.bin', '2/4:b.bin', '3/4:c.bin', '4/4:d.bin'])
  for (const s of progress.filter((x) => x.stage !== 'preparing')) assert.equal(s.totalBytes, 400)
  let prev = -1
  for (const s of progress) {
    assert.ok(s.percent >= prev, 'never decreasing')
    prev = s.percent
    if (s.stage !== 'done') assert.ok(s.percent <= 99.9)
  }
  assert.equal(progress.at(-1).percent, 100)
  assert.equal(progress.at(-1).transferredBytes, 400)
  const mid = archiving.find((s) => s.transferredBytes === 101)
  assert.equal(mid.percent, Math.floor((101 / 400) * 1000) / 10)
})

test('ORCH-21 a zero-byte total shows 0 and then 100', async () => {
  const h = harness()
  const payloads = payloadsOf(0, 0, 0, 0)
  const progress = []
  const res = await run({ plan: makePlan(payloads), source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter, onProgress: (s) => progress.push(s) })
  assert.equal(res.status, 'done')
  assert.ok(progress.filter((s) => s.stage !== 'done').every((s) => s.percent === 0))
  assert.equal(progress.at(-1).percent, 100)
})

/* ── production offset (C-1, behavioural) ────────────────────────── */

test('ORCH-22 production never passes startOffset: PK\\x03\\x04 at byte 0 and the physical size equals zipLayout(effective).total', async () => {
  const h = harness()
  const payloads = payloadsOf(10, 20, 0, 5)
  const plan = makePlan(payloads, { names: ['รายงาน.txt', 'b', 'c', '🙂.bin'] })
  const res = await run({ plan, source: makeSource(h.events, payloads), scope: h.scope, busyRef: { current: false }, createWriter: h.createWriter })
  assert.equal(res.status, 'done')
  assert.equal(h.writerCalls.length, 1)
  assert.equal(Object.hasOwn(h.writerCalls[0], 'startOffset'), false)
  const out = h.output()
  assert.deepEqual([...out.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  assert.equal(out.length, zipLayout(plan.entries).total)
  assert.equal(new TextDecoder().decode(out.subarray(30, 30 + enc.encode('รายงาน.txt').length)), 'รายงาน.txt')
})
