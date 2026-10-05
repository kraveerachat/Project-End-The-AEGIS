// Server-only: inputs are committed lifecycle handles, never browser claims.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { CameraAccessError } from './cameraAccess.js'

const fail = () => new CameraAccessError(503, 'PRODUCER_AUTHORITY_UNAVAILABLE')
const keyFor = secret => createHmac('sha256', secret).update('AEGIS-demand-grant-v1-key').digest()
const canonical = value => JSON.stringify(value, Object.keys(value).sort())
const integer = value => Number.isSafeInteger(value)
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
const b64 = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value

export function verifyBootClock({ token, secret, nonce, nodeId, startMs, endMs }) {
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
      || !integer(value.engineNowMs) || !integer(startMs) || !integer(endMs) || endMs < startMs) throw fail()
    // Worst endpoint distance bounds offset plus network/processing uncertainty.
    const uncertaintyMs = Math.max(Math.abs(value.engineNowMs - startMs), Math.abs(value.engineNowMs - endMs))
    if (uncertaintyMs > 500) throw fail()
    return { bootId: value.engineBootId, uncertaintyMs }
  } catch { throw fail() }
}

export function mintDemandGrant({ handle, bootId, secret, nowMs = Date.now(), clockUncertaintyMs, action }) {
  try {
    if (!secret || !b64(bootId) || !['attach', 'refresh', 'revoke', 'retire'].includes(action)
      || !integer(nowMs) || !integer(clockUncertaintyMs) || clockUncertaintyMs < 0 || clockUncertaintyMs > 500
      || !id(handle.producerGeneration) || !id(String(handle.userId))
      || !b64(handle.demandOwnerId) || !/^v1:[0-9a-f]{64}$/.test(handle.sessionBindingHash)
      || !/^CAM-[0-9]{1,60}$/.test(handle.logicalCameraId)
      || typeof handle.nodeId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(handle.nodeId)) throw fail()
    const physical = Number(handle.physicalCameraId)
    if (!integer(physical) || physical < 1 || String(physical) !== String(handle.physicalCameraId)) throw fail()
    let expiry
    if (action === 'attach' || action === 'refresh') {
      const { leaseExpiresAtMs, dbNowMs, dbObservationStartMs: start, dbObservationEndMs: end } = handle
      if (![leaseExpiresAtMs, dbNowMs, start, end].every(integer) || end < start || nowMs < end
        || nowMs - end > 500 || leaseExpiresAtMs > dbNowMs + 30_000
        || Math.max(Math.abs(dbNowMs - start), Math.abs(dbNowMs - end)) > 500) throw fail()
      // 500 ms DB offset + measured Engine uncertainty + 100 ms drift budget.
      // Subtraction only: no grace can extend DB authorization. Both clocks
      // must remain disciplined; production host proof is a separate gate.
      expiry = leaseExpiresAtMs - 500 - clockUncertaintyMs - 100
      if (expiry <= nowMs || expiry > nowMs + 30_000) throw fail()
    } else {
      // Destructive control cannot grant capture authority; it remains boot-bound.
      expiry = nowMs + 29_000
    }
    const claims = { v: 1, action, jti: randomBytes(32).toString('base64url'),
      demandOwnerId: handle.demandOwnerId, producerGeneration: handle.producerGeneration,
      logicalCameraId: handle.logicalCameraId, nodeId: handle.nodeId,
      physicalCameraId: physical, engineBootId: bootId, userId: String(handle.userId),
      sessionBindingHash: handle.sessionBindingHash, expiresAtMs: expiry }
    const raw = Buffer.from(canonical(claims))
    const mac = createHmac('sha256', keyFor(secret)).update('aegis-producer-demand-v1\n').update(raw).digest()
    return `${raw.toString('base64url')}.${mac.toString('base64url')}`
  } catch { throw fail() }
}

export async function readEngineBoot({ url, nodeId, secret, signal, fetchImpl = fetch }) {
  try {
    const nonce = randomBytes(32).toString('hex')
    const startMs = Date.now()
    const response = await fetchImpl(new URL('/producer/boot', url), {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500),
      headers: { 'X-Detection-Engine-Key': secret, 'X-Aegis-Clock-Nonce': nonce },
    })
    if (!response.ok) throw fail()
    const token = await response.text()
    return verifyBootClock({ token, secret, nonce, nodeId, startMs, endMs: Date.now() })
  } catch { throw fail() }
}

export async function sendDemandControl({ url, handle, boot, secret, action, signal, fetchImpl = fetch }) {
  const token = mintDemandGrant({ handle, bootId: boot.bootId, secret, action,
    clockUncertaintyMs: boot.uncertaintyMs })
  const response = await fetchImpl(new URL('/producer/control', url), {
    method: 'POST', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500),
    headers: { 'X-Detection-Engine-Key': secret, 'X-Aegis-Demand-Grant': token },
  })
  if (!response.ok) throw fail()
}
