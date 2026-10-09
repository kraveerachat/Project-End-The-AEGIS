import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import * as diagnosticModule from '../server/auth/bootTimingDiagnostic.js'
import { readEngineBoot, isRetryableProducerSyncError } from '../server/auth/producerDemandGrant.js'
import { createBootTimingDiagnostic } from '../server/auth/bootTimingDiagnostic.js'

const secret = 'fixture-only-key'
function token(nonce) {
  const value = { engineBootId: Buffer.alloc(32, 4).toString('base64url'),
    nodeId: 'fixture-node', nonce, engineNowMs: 1_800_000_000_000 }
  const raw = Buffer.from(JSON.stringify(value, Object.keys(value).sort()))
  const key = createHmac('sha256', secret).update('AEGIS-demand-grant-v1-key').digest()
  return `${raw.toString('base64url')}.${createHmac('sha256', key)
    .update('aegis-producer-clock-v1\n').update(raw).digest('base64url')}`
}

test('opt-in Boot probe adds only an opaque diagnostic correlation header, not authority', async () => {
  const previous = process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC
  process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC = 'true'
  try {
    const result = await readEngineBoot({ url: 'http://fixture.test', nodeId: 'fixture-node', secret,
      wallClock: () => 1_800_000_000_000, monoClock: () => 10,
      fetchImpl: async (_url, options) => {
        assert.match(options.headers['X-Aegis-Boot-Diagnostic-Id'], /^[0-9a-f]{32}$/)
        assert.equal(options.headers['X-Detection-Engine-Key'], secret)
        assert.equal(options.redirect, 'error')
        return { ok: true, text: async () => token(options.headers['X-Aegis-Clock-Nonce']) }
      } })
    assert.equal(result.offsetLowerMs, 0)
    assert.equal(Object.hasOwn(result, 'diagnosticId'), false)
  } finally {
    if (previous === undefined) delete process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC
    else process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC = previous
  }
})

test('default-off Boot request has no diagnostic header and retains transport classification', async () => {
  delete process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC
  await assert.rejects(readEngineBoot({ url: 'http://fixture.test', nodeId: 'fixture-node', secret,
    fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(options.headers, 'X-Aegis-Boot-Diagnostic-Id'), false)
      throw new Error('SECRET transport detail')
    } }), error => isRetryableProducerSyncError(error))
})

test('fixed monotonic phases, redaction, record count and elapsed-time caps', () => {
  const records = [], scheduled = []
  let now = 10
  const diagnostic = createBootTimingDiagnostic({ enabled: () => true, clock: () => now,
    sink: record => records.push(record), defer: fn => fn(), schedule: fn => scheduled.push(fn) })
  const trace = diagnostic.begin()
  now = 14; trace.mark('headers')
  now = 20; trace.mark('body')
  trace.mark('SECRET')
  now = 50_010; trace.mark('validation'); trace.finish('accepted'); trace.finish('accepted')
  assert.deepEqual(records[0].phasesMs, { dispatch: 0, headers: 4, body: 10, validation: 10_000 })
  assert.equal(records[0].elapsedMs, 10_000)
  assert.deepEqual(Object.keys(records[0]).sort(), ['elapsedMs', 'event', 'id', 'loopLagMs',
    'loopLagSampleAgeMs', 'outcome', 'phasesMs', 'role'].sort())
  assert.equal(JSON.stringify(records).includes('SECRET'), false)
  for (let i = 0; i < 200; i++) diagnostic.begin().finish('accepted')
  assert.equal(records.length, 128)
  assert.equal(scheduled.length, 1)
})

test('duration cap, default-off and diagnostic clock/sink/scheduler failure isolation', () => {
  const records = []
  let now = 0
  const d = createBootTimingDiagnostic({ enabled: () => true, clock: () => now,
    sink: r => records.push(r), defer: f => f(), schedule: () => null })
  d.begin().finish('accepted')
  now = 300_000; assert.equal(d.begin().id, null)
  assert.equal(createBootTimingDiagnostic().begin().id, null)
  const broken = () => { throw Error('SECRET') }
  for (const options of [{ enabled: broken }, { enabled: () => true, clock: broken },
    { enabled: () => true, sink: broken, defer: f => f(), schedule: broken },
    { enabled: () => true, defer: broken, schedule: broken }]) {
    const trace = createBootTimingDiagnostic(options).begin()
    assert.doesNotThrow(() => { trace.mark('body'); trace.finish('accepted') })
  }
})

test('loop lag is bounded scheduling evidence, not SSH or browser latency', () => {
  const records = [], callbacks = []
  let now = 0
  const d = createBootTimingDiagnostic({ enabled: () => true, clock: () => now,
    sink: r => records.push(r), defer: f => f(), schedule: f => callbacks.push(f) })
  const trace = d.begin()
  now = 62; callbacks.shift()()
  now = 64; trace.finish('accepted')
  assert.equal(records[0].loopLagMs, 12)
  assert.equal(records[0].loopLagSampleAgeMs, 2)
})

test('slow diagnostic output is off the application loop, bounded and failure isolated', { timeout: 5000 }, async () => {
  assert.equal(typeof diagnosticModule.createDiagnosticWriter, 'function')
  let worker
  const writer = diagnosticModule.createDiagnosticWriter({ workerFactory: () => {
    worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', () => {
      parentPort.postMessage('started');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      parentPort.postMessage('written');
    });`, { eval: true })
    return worker
  } })
  const workerReady = []
  // Actual worker is slow, but submitting bounded output must return normally.
  for (let i = 0; i < 200; i++) writer({ event: 'boot_timing', role: 'monitor', id: 'a'.repeat(32) })
  await new Promise(resolve => setImmediate(() => { workerReady.push('application-ran'); resolve() }))
  assert.deepEqual(workerReady, ['application-ran'])
  await new Promise(resolve => worker.once('message', resolve))
  const before = performance.now()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(performance.now() - before < 500)
  await worker.terminate()
  const broken = diagnosticModule.createDiagnosticWriter({ workerFactory: () => { throw Error('SECRET') } })
  assert.doesNotThrow(() => broken({ event: 'boot_timing' }))
})

test('enabled diagnostic does not accept invalid proofs or alter retry classification', async () => {
  process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC = 'true'
  try {
    for (const [response, retryable] of [[{ ok: true, text: async () => 'SECRET-invalid-proof' }, false],
      [{ ok: false, status: 403 }, false], [{ ok: false, status: 503 }, true],
      [{ ok: true, text: async () => { throw Error('SECRET') } }, true]]) {
      await assert.rejects(readEngineBoot({ url: 'http://fixture.test', nodeId: 'fixture-node', secret,
        fetchImpl: async () => response }), error =>
        isRetryableProducerSyncError(error) === retryable)
    }
  } finally { delete process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC }
})

test('output queue drops over-count, oversized records and failed workers without retry', () => {
  const sent = [], listeners = {}
  let created = 0
  const writer = diagnosticModule.createDiagnosticWriter({ workerFactory: () => {
    created++
    return { on: (event, callback) => { listeners[event] = callback }, unref() {},
      postMessage: line => sent.push(line) }
  } })
  for (let i = 0; i < 200; i++) writer({ event: 'boot_timing' })
  assert.equal(sent.length, 128)
  assert.equal(created, 1)
  const bounded = diagnosticModule.createDiagnosticWriter({ workerFactory: () => {
    return { on: (event, callback) => { listeners[event] = callback }, unref() {},
      postMessage: line => sent.push(line) }
  } })
  bounded({ oversized: 'x'.repeat(2049) })
  assert.equal(sent.length, 128)
  bounded({ event: 'boot_timing' })
  assert.equal(sent.length, 129)
  listeners.error(Error('SECRET'))
  bounded({ event: 'boot_timing' })
  assert.equal(sent.length, 129)
})
