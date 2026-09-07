// tests/sampler.test.js — AEGIS host telemetry agent · background sampler
//
// The sampler is the reason Drive never waits for a measurement window. Every
// source read, the clock, and the timer are injected, so these tests assert the
// state machine rather than racing a real five-second interval.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSampler } from '../src/sampler.js'

const PROC_STAT_1 = 'cpu  100 20 30 400 50 6 4 0 0 0\ncpu0 50 10 15 200 25 3 2 0 0 0\n'
const PROC_STAT_2 = 'cpu  200 20 30 500 50 6 4 0 0 0\ncpu0 100 10 15 250 25 3 2 0 0 0\n'
const MEMINFO = 'MemTotal:        8138332 kB\nMemFree:          312044 kB\nMemAvailable:    5061404 kB\n'
const UPTIME = '86400.55 172800.10\n'

/** A controllable source set: every reader resolves whatever the script says. */
function harness({ scripts = {}, startMs = 1_000_000 } = {}) {
  const state = {
    ms: startMs,
    procStat: PROC_STAT_1,
    memInfo: MEMINFO,
    rxBytes: '1000',
    txBytes: '2000',
    uptime: UPTIME,
    ...scripts,
  }
  const timers = { created: 0, cleared: 0, handle: null }

  const readerFor = (key) => async () => {
    const value = state[key]
    if (value instanceof Error) throw value
    return value
  }

  const sampler = createSampler({
    intervalMs: 5000,
    interfaceName: 'enp1s0',
    now: () => state.ms,
    readers: {
      procStat: readerFor('procStat'),
      memInfo: readerFor('memInfo'),
      networkRx: readerFor('rxBytes'),
      networkTx: readerFor('txBytes'),
      uptime: readerFor('uptime'),
    },
    setTimer: (fn, ms) => {
      timers.created += 1
      timers.handle = { fn, ms }
      return timers.handle
    },
    clearTimer: (handle) => {
      timers.cleared += 1
      assert.equal(handle, timers.handle, 'stop must clear the handle it created')
    },
  })

  return { sampler, state, timers }
}

// ── TELEM-SAMPLER-1 ───────────────────────────────────────────────────
test('TELEM-SAMPLER-1 first cycle publishes delta-free metrics only', async () => {
  const { sampler } = harness()
  assert.equal(sampler.snapshot(), null, 'no snapshot exists before the first cycle')

  await sampler.sampleOnce()
  const snapshot = sampler.snapshot()

  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.metrics.cpu.available, false, 'cpu needs two samples')
  assert.equal(snapshot.metrics.network.available, false, 'network needs two samples')
  assert.equal(snapshot.metrics.memory.available, true)
  assert.equal(snapshot.metrics.uptime.available, true)
  // Unavailable must carry no numbers at all — not even a zero.
  assert.deepEqual(Object.keys(snapshot.metrics.cpu), ['available'])
  assert.deepEqual(Object.keys(snapshot.metrics.network), ['available'])
})

// ── TELEM-SAMPLER-2 ───────────────────────────────────────────────────
test('TELEM-SAMPLER-2 second cycle produces measured cpu and network', async () => {
  const { sampler, state } = harness()
  await sampler.sampleOnce()

  state.ms += 5000
  state.procStat = PROC_STAT_2
  state.rxBytes = '6000'
  state.txBytes = '4500'
  await sampler.sampleOnce()

  const { cpu, network, memory, uptime } = sampler.snapshot().metrics
  // total delta 200, idle delta 100 -> 50% busy over a real 5s window.
  assert.equal(cpu.available, true)
  assert.equal(cpu.percent, 50)
  assert.equal(cpu.windowSeconds, 5)

  assert.equal(network.available, true)
  assert.equal(network.interface, 'enp1s0')
  assert.equal(network.rxBytesPerSec, 1000)
  assert.equal(network.txBytesPerSec, 500)
  assert.equal(network.windowSeconds, 5)

  assert.equal(memory.totalBytes, 8138332 * 1024)
  assert.equal(uptime.hostSeconds, 86400.55)
  assert.equal(sampler.snapshot().measuredAt, new Date(1_005_000).toISOString())
})

// ── TELEM-SAMPLER-3 ───────────────────────────────────────────────────
test('TELEM-SAMPLER-3 one failing source never fabricates zero for it', async () => {
  const { sampler, state } = harness()
  await sampler.sampleOnce()

  state.ms += 5000
  state.procStat = PROC_STAT_2
  state.rxBytes = '6000'
  state.txBytes = '4500'
  state.memInfo = new Error('EACCES')
  await sampler.sampleOnce()

  const { cpu, memory } = sampler.snapshot().metrics
  assert.equal(memory.available, false)
  assert.deepEqual(Object.keys(memory), ['available'])
  assert.equal(cpu.available, true, 'a memory failure must not disable cpu')
  assert.equal(cpu.percent, 50)
})

// ── TELEM-SAMPLER-4 ───────────────────────────────────────────────────
test('TELEM-SAMPLER-4 malformed source content yields a truthful unavailable', async () => {
  const { sampler, state } = harness({ scripts: { procStat: 'garbage', rxBytes: 'not-a-number' } })
  await sampler.sampleOnce()
  state.ms += 5000
  await sampler.sampleOnce()

  const { cpu, network, uptime } = sampler.snapshot().metrics
  assert.equal(cpu.available, false)
  assert.equal(network.available, false)
  assert.equal(uptime.available, true, 'a sound source stays available')
})

// ── TELEM-SAMPLER-5 ───────────────────────────────────────────────────
test('TELEM-SAMPLER-5 sampler survives a cycle where every source fails', async () => {
  const { sampler, state } = harness()
  await sampler.sampleOnce()
  state.ms += 5000
  state.procStat = PROC_STAT_2
  state.rxBytes = '6000'
  state.txBytes = '4500'
  await sampler.sampleOnce()
  const good = sampler.snapshot()
  assert.equal(good.metrics.cpu.available, true)

  for (const key of ['procStat', 'memInfo', 'rxBytes', 'txBytes', 'uptime']) {
    state[key] = new Error('EIO')
  }
  state.ms += 5000
  await assert.doesNotReject(() => sampler.sampleOnce())

  const degraded = sampler.snapshot()
  assert.equal(degraded.metrics.cpu.available, false)
  assert.equal(degraded.metrics.memory.available, false)
  assert.equal(degraded.metrics.uptime.available, false)
  assert.notEqual(degraded.measuredAt, good.measuredAt, 'a failed cycle still timestamps honestly')

  // ...and the next healthy cycle recovers without a restart.
  state.procStat = PROC_STAT_1
  state.memInfo = MEMINFO
  state.rxBytes = '1000'
  state.txBytes = '2000'
  state.uptime = UPTIME
  state.ms += 5000
  await sampler.sampleOnce()
  state.ms += 5000
  state.procStat = PROC_STAT_2
  state.rxBytes = '6000'
  state.txBytes = '4500'
  await sampler.sampleOnce()
  assert.equal(sampler.snapshot().metrics.cpu.available, true)
})

// ── TELEM-SAMPLER-6 ───────────────────────────────────────────────────
test('TELEM-SAMPLER-6 stop clears the timer and is idempotent', async () => {
  const { sampler, timers } = harness()
  sampler.start()
  assert.equal(timers.created, 1)

  sampler.stop()
  assert.equal(timers.cleared, 1)
  sampler.stop()
  assert.equal(timers.cleared, 1, 'stopping twice must not clear an absent timer')

  sampler.start()
  assert.equal(timers.created, 2, 'a stopped sampler can be restarted')
  sampler.stop()
})

test('TELEM-SAMPLER-6 start does not stack duplicate timers', () => {
  const { sampler, timers } = harness()
  sampler.start()
  sampler.start()
  assert.equal(timers.created, 1, 'start must be idempotent while running')
  sampler.stop()
})
