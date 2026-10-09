// Server-only: inputs are committed lifecycle handles, never browser claims.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { CameraAccessError } from './cameraAccess.js'

const fail = () => new CameraAccessError(503, 'PRODUCER_AUTHORITY_UNAVAILABLE')

class ProducerSyncError extends CameraAccessError {
  constructor(retryable) {
    super(503, 'PRODUCER_AUTHORITY_UNAVAILABLE')
    this.name = 'ProducerSyncError'
    Object.defineProperty(this, 'retryable', {
      value: retryable === true,
      enumerable: false,
    })
  }
}

const syncFail = retryable => new ProducerSyncError(retryable)

export const isRetryableProducerSyncError = error =>
  error instanceof ProducerSyncError && error.retryable === true
const keyFor = secret => createHmac('sha256', secret).update('AEGIS-demand-grant-v1-key').digest()
const canonical = value => JSON.stringify(value, Object.keys(value).sort())
const integer = value => Number.isSafeInteger(value)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const monotonicMs = () => performance.now()
const MAX_PROBE_MS = 500
const MAX_ENGINE_OFFSET_MS = 900
const MAX_DB_OFFSET_MS = 500
const MAX_MONITOR_CLOCK_STEP_MS = 25
const DRIFT_GUARD_MS = 100 // Provisional: Production DB/Engine drift must be validated separately.
// The two wall/monotonic observation intervals can each tolerate one bounded
// sampling discrepancy. Do not spend the independent DB/Engine drift reserve.
const TOTAL_CLOCK_GUARD_MS = DRIFT_GUARD_MS + 2 * MAX_MONITOR_CLOCK_STEP_MS
const MAX_BOOT_TO_MINT_MS = 500
const MAX_DESTRUCTIVE_BOOT_AGE_MS = 30_000
const wallClockContinuous = (wallStart, wallEnd, monoStart, monoEnd) =>
  integer(wallStart) && integer(wallEnd) && finite(monoStart) && finite(monoEnd)
  && wallEnd >= wallStart && monoEnd >= monoStart
  && Math.abs((wallEnd - wallStart) - (monoEnd - monoStart)) <= MAX_MONITOR_CLOCK_STEP_MS
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
const b64 = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value

export function verifyBootClock({ token, secret, nonce, nodeId, startMs, endMs,
  startMonoMs, endMonoMs }) {
  try {
    if (typeof token !== 'string' || token.length > 2048 || !secret) throw fail()
    const parts = token.split('.')
    if (parts.length !== 2) throw fail()
    const [body, signature] = parts
    const raw = Buffer.from(body, 'base64url'), mac = Buffer.from(signature, 'base64url')
    const expected = createHmac('sha256', keyFor(secret)).update('aegis-producer-clock-v1\n').update(raw).digest()
    if (raw.toString('base64url') !== body || mac.toString('base64url') !== signature
      || mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw fail()
    const value = JSON.parse(raw)
    if (canonical(value) !== raw.toString() || Object.keys(value).length !== 4
      || value.nonce !== nonce || value.nodeId !== nodeId || !b64(value.engineBootId)
      || !integer(value.engineNowMs)
      || !wallClockContinuous(startMs, endMs, startMonoMs, endMonoMs)
      || endMonoMs - startMonoMs > MAX_PROBE_MS) throw fail()
    // The signed sample occurred between send and receive; no RTT/2 assumption.
    const offsetLowerMs = value.engineNowMs - endMs
    const offsetUpperMs = value.engineNowMs - startMs
    if (!integer(offsetLowerMs) || !integer(offsetUpperMs)
      || offsetLowerMs < -MAX_ENGINE_OFFSET_MS || offsetUpperMs > MAX_ENGINE_OFFSET_MS) throw fail()
    return Object.freeze({ bootId: value.engineBootId, offsetLowerMs, offsetUpperMs,
      observedAtMs: endMs, observedAtMonoMs: endMonoMs })
  } catch { throw fail() }
}

export function mintDemandGrant({ handle, boot, secret, nowMs = Date.now(),
  nowMonoMs = monotonicMs(), action }) {
  try {
    if (!secret || !b64(boot?.bootId) || !['attach', 'refresh', 'revoke', 'retire'].includes(action)
      || !integer(nowMs) || !finite(nowMonoMs)
      || !integer(boot.offsetLowerMs) || !integer(boot.offsetUpperMs)
      || boot.offsetLowerMs < -MAX_ENGINE_OFFSET_MS || boot.offsetUpperMs > MAX_ENGINE_OFFSET_MS
      || boot.offsetUpperMs < boot.offsetLowerMs
      || !wallClockContinuous(boot.observedAtMs, nowMs, boot.observedAtMonoMs, nowMonoMs)
      || nowMonoMs - boot.observedAtMonoMs > MAX_DESTRUCTIVE_BOOT_AGE_MS
      || !id(handle.producerGeneration) || !id(String(handle.userId))
      || !b64(handle.demandOwnerId) || !/^v1:[0-9a-f]{64}$/.test(handle.sessionBindingHash)
      || !/^CAM-[0-9]{1,60}$/.test(handle.logicalCameraId)
      || typeof handle.nodeId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(handle.nodeId)) throw fail()
    const physical = Number(handle.physicalCameraId)
    if (!integer(physical) || physical < 1 || String(physical) !== String(handle.physicalCameraId)) throw fail()
    let expiry
    if (action === 'attach' || action === 'refresh') {
      const { leaseExpiresAtMs, dbNowMs, dbObservationStartMs: start,
        dbObservationEndMs: end, dbObservationStartMonoMs: startMono,
        dbObservationEndMonoMs: endMono } = handle
      if (![leaseExpiresAtMs, dbNowMs].every(integer)
        || !wallClockContinuous(start, end, startMono, endMono)
        || !wallClockContinuous(start, nowMs, startMono, nowMonoMs)
        || nowMs < end || nowMs - end > MAX_DB_OFFSET_MS
        || nowMonoMs - boot.observedAtMonoMs > MAX_BOOT_TO_MINT_MS
        || leaseExpiresAtMs > dbNowMs + 30_000
        || Math.max(Math.abs(dbNowMs - start), Math.abs(dbNowMs - end)) > MAX_DB_OFFSET_MS) throw fail()
      // A historical DB observation cannot bound the DB/Monitor offset at
      // the signed Engine sample: DB and Engine may move together after it.
      // Conditional safety requires |DB-Monitor| <= 500ms throughout signed
      // observation through mint, and <= 100ms DB/Engine relative divergence
      // from that observation through lease expiry. Reserve those full bounds
      // plus two 25ms Monitor observation discrepancies. Production needs
      // independent evidence for these deployment clock-discipline premises.
      expiry = Math.min(
        leaseExpiresAtMs + boot.offsetLowerMs - MAX_DB_OFFSET_MS - TOTAL_CLOCK_GUARD_MS,
        nowMs + boot.offsetLowerMs + 29_000 - TOTAL_CLOCK_GUARD_MS,
      )
      if (!integer(expiry) || expiry <= nowMs + boot.offsetUpperMs + TOTAL_CLOCK_GUARD_MS) throw fail()
    } else {
      // Destructive control cannot grant capture authority; it remains boot-bound.
      expiry = nowMs + boot.offsetLowerMs + 29_000 - TOTAL_CLOCK_GUARD_MS
    }
    if (!integer(expiry) || expiry <= nowMs + boot.offsetUpperMs + TOTAL_CLOCK_GUARD_MS) throw fail()
    const claims = { v: 1, action, jti: randomBytes(32).toString('base64url'),
      demandOwnerId: handle.demandOwnerId, producerGeneration: handle.producerGeneration,
      logicalCameraId: handle.logicalCameraId, nodeId: handle.nodeId,
      physicalCameraId: physical, engineBootId: boot.bootId, userId: String(handle.userId),
      sessionBindingHash: handle.sessionBindingHash, expiresAtMs: expiry }
    const raw = Buffer.from(canonical(claims))
    const mac = createHmac('sha256', keyFor(secret)).update('aegis-producer-demand-v1\n').update(raw).digest()
    return `${raw.toString('base64url')}.${mac.toString('base64url')}`
  } catch { throw fail() }
}

export async function readEngineBoot({ url, nodeId, secret, signal, fetchImpl = fetch,
  wallClock = Date.now, monoClock = monotonicMs }) {
  const nonce = randomBytes(32).toString('hex')
  const startMs = wallClock()
  const startMonoMs = monoClock()
  let response
  try {
    response = await fetchImpl(new URL('/producer/boot', url), {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500),
      headers: { 'X-Detection-Engine-Key': secret, 'X-Aegis-Clock-Nonce': nonce },
    })
  } catch {
    // Transport failure or the bounded 500ms probe timeout may be transient.
    // The caller still has to revalidate DB authority before retrying.
    throw syncFail(true)
  }

  if (!response.ok) {
    // Engine-side 4xx is an authority rejection and must not be retried.
    // Only a server-side 5xx may be treated as transient.
    throw syncFail(Number(response.status) >= 500)
  }

  let token
  try {
    token = await response.text()
  } catch {
    throw syncFail(true)
  }

  try {
    const endMonoMs = monoClock()
    const endMs = wallClock()
    return verifyBootClock({ token, secret, nonce, nodeId, startMs, endMs,
      startMonoMs, endMonoMs })
  } catch {
    // Invalid signature/node/nonce/clock evidence is never accepted via retry.
    throw syncFail(false)
  }
}

export async function sendDemandControl({ url, handle, boot, secret, action, signal, fetchImpl = fetch }) {
  let token
  try {
    token = mintDemandGrant({ handle, boot, secret, action })
  } catch {
    // A DB observation can age out of its 500ms mint window. A caller may
    // retry only after obtaining a fresh authorization-sensitive DB renewal.
    throw syncFail(true)
  }

  let response
  try {
    response = await fetchImpl(new URL('/producer/control', url), {
      method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500),
      headers: { 'X-Detection-Engine-Key': secret, 'X-Aegis-Demand-Grant': token },
    })
  } catch {
    throw syncFail(true)
  }

  if (!response.ok) {
    // 403/409 and every other 4xx remain immediate authority failures.
    // Only Engine 5xx is eligible for the bounded caller retry.
    throw syncFail(Number(response.status) >= 500)
  }
}
