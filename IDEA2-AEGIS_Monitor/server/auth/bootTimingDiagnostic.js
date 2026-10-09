// Observation only. Never import this module into an authority calculation.
import { randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'

const phases = new Set(['dispatch', 'headers', 'body', 'validation'])
const outcomes = new Set(['accepted', 'transport_failure', 'http_rejection',
  'body_failure', 'proof_rejection'])
const noop = Object.freeze({ id: null, mark() {}, finish() {} })
const bounded = value => Number.isFinite(value) && value >= 0
  ? Math.round(Math.min(value, 10_000) * 100) / 100 : null

export function createDiagnosticWriter({ workerFactory = () =>
  new Worker(new URL('./bootTimingWriter.js', import.meta.url)) } = {}) {
  let worker, used = 0, failed = false
  return record => {
    try {
      if (failed || used >= 128) return
      used++
      const line = JSON.stringify(record)
      if (Buffer.byteLength(line) > 2048) return
      if (!worker) {
        worker = workerFactory()
        worker.on('error', () => { failed = true })
        worker.on('exit', () => { failed = true })
        worker.unref()
      }
      worker.postMessage(line)
    } catch { failed = true }
  }
}
const writeDiagnostic = createDiagnosticWriter()

export function createBootTimingDiagnostic({ enabled = () => false,
  clock = () => performance.now(), sink = writeDiagnostic,
  defer = setImmediate, schedule = setTimeout } = {}) {
  let started, used = 0, lag = null, lagAt = null, sampling = false
  const alive = now => Number.isFinite(now) && now >= started && now - started < 300_000
  function sample() {
    if (sampling) return
    sampling = true
    function tick() {
      try {
        const due = clock() + 50
        const timer = schedule(() => {
          try {
            const now = clock()
            lag = bounded(now - due); lagAt = now
            if (alive(now) && used < 128) tick()
            else sampling = false
          } catch { sampling = false }
        }, 50)
        timer?.unref?.()
      } catch { sampling = false }
    }
    tick()
  }
  return Object.freeze({
    begin() {
      try {
        if (enabled() !== true || used >= 128) return noop
        const now = clock()
        if (started === undefined) started = now
        if (!alive(now)) return noop
        used++
        const id = randomBytes(16).toString('hex'), values = { dispatch: 0 }
        let done = false
        sample()
        return Object.freeze({ id,
          mark(phase) {
            try {
              if (!done && phases.has(phase) && !Object.hasOwn(values, phase)) {
                values[phase] = bounded(clock() - now)
              }
            } catch { /* diagnostics cannot change the application result */ }
          },
          finish(outcome) {
            try {
              if (done || !outcomes.has(outcome)) return
              done = true
              const end = clock()
              const record = Object.freeze({ event: 'boot_timing', role: 'monitor', id,
                outcome, elapsedMs: bounded(end - now), phasesMs: Object.freeze({ ...values }),
                loopLagMs: lag, loopLagSampleAgeMs: lagAt === null ? null : bounded(end - lagAt) })
              defer(() => { try { sink(record) } catch { /* best effort */ } })
            } catch { /* best effort */ }
          },
        })
      } catch { return noop }
    },
  })
}

export const monitorBootTiming = createBootTimingDiagnostic({
  enabled: () => process.env.AEGIS_BOOT_TIMING_DIAGNOSTIC === 'true',
})
