import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import * as grant from '../server/auth/producerDemandGrant.js'

const secret = 'fixture-engine-key'
const now = 1_800_000_000_000
const boot = Buffer.alloc(32, 4).toString('base64url')
const handle = { userId: '2', nodeId: 'edge-node-01', physicalCameraId: '1',
  logicalCameraId: 'CAM-02', producerGeneration: '9007199254740993',
  demandOwnerId: Buffer.alloc(32, 1).toString('base64url'),
  sessionBindingHash: `v1:${'b'.repeat(64)}`, leaseExpiresAtMs: now + 30_000,
  dbNowMs: now, dbObservationStartMs: now - 20, dbObservationEndMs: now + 20 }
function decode(token) { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')) }
function clockToken(payload) {
  const raw = Buffer.from(JSON.stringify(payload, Object.keys(payload).sort()))
  const key = createHmac('sha256', secret).update('AEGIS-demand-grant-v1-key').digest()
  return `${raw.toString('base64url')}.${createHmac('sha256', key).update('aegis-producer-clock-v1\n').update(raw).digest('base64url')}`
}

test('grant uses only committed server handle, exact generation and earlier DB expiry', () => {
  const token = grant.mintDemandGrant({ handle, bootId: boot, secret, nowMs: now + 40,
    clockUncertaintyMs: 100, action: 'attach' })
  const claims = decode(token)
  assert.equal(claims.logicalCameraId, 'CAM-02')
  assert.equal(claims.producerGeneration, '9007199254740993')
  assert.equal(claims.userId, '2')
  assert.equal(claims.sessionBindingHash, handle.sessionBindingHash)
  assert.equal(claims.physicalCameraId, 1)
  assert.equal(claims.expiresAtMs, now + 30_000 - 500 - 100 - 100)
  assert.equal(claims.engineBootId, boot)
  assert.notEqual(claims.jti, decode(grant.mintDemandGrant({ handle, bootId: boot,
    secret, nowMs: now + 40, clockUncertaintyMs: 100, action: 'attach' })).jti)
  assert.equal(Object.hasOwn(claims, 'sessionBinding'), false)
})

test('missing DB timestamps, late commit, expired lease and unknown clock fail closed', () => {
  for (const changed of [{ leaseExpiresAtMs: undefined }, { dbNowMs: undefined },
    { dbNowMs: now + 521 }, { dbObservationEndMs: now + 501 },
    { leaseExpiresAtMs: now + 100 }]) {
    assert.throws(() => grant.mintDemandGrant({ handle: { ...handle, ...changed },
      bootId: boot, secret, nowMs: now + 40, clockUncertaintyMs: 100, action: 'attach' }))
  }
  for (const uncertainty of [undefined, -1, 501]) {
    assert.throws(() => grant.mintDemandGrant({ handle, bootId: boot, secret,
      nowMs: now + 40, clockUncertaintyMs: uncertainty, action: 'attach' }))
  }
})

test('authenticated boot clock is nonce/node bound with 500ms exact boundary', () => {
  const nonce = 'c'.repeat(64)
  const payload = { engineBootId: boot, nodeId: 'edge-node-01', nonce, engineNowMs: now }
  const verify = (p, endMs = now + 500) => grant.verifyBootClock({ token: clockToken(p),
    secret, nonce, nodeId: 'edge-node-01', startMs: now, endMs })
  assert.equal(verify(payload).uncertaintyMs, 500)
  assert.throws(() => verify(payload, now + 501))
  assert.throws(() => verify({ ...payload, engineNowMs: now - 1 }))
  assert.throws(() => verify({ ...payload, nonce: 'd'.repeat(64) }))
  assert.throws(() => verify({ ...payload, nodeId: 'other' }))
})

test('DB clock exact 500ms bound is accepted and just outside rejected', () => {
  const options = { bootId: boot, secret, nowMs: now + 40,
    clockUncertaintyMs: 0, action: 'attach' }
  assert.ok(grant.mintDemandGrant({ ...options, handle: { ...handle, dbNowMs: now + 480 } }))
  assert.throws(() => grant.mintDemandGrant({ ...options, handle: { ...handle, dbNowMs: now + 481 } }))
})

test('producer sync classifier retries transport failure but not Engine authority rejection', async () => {
  await assert.rejects(
    grant.readEngineBoot({
      url: 'http://engine.test/stream.mjpg',
      nodeId: 'edge-node-01',
      secret,
      fetchImpl: async () => { throw new Error('transient network failure') },
    }),
    error => {
      assert.equal(error.code, 'PRODUCER_AUTHORITY_UNAVAILABLE')
      assert.equal(grant.isRetryableProducerSyncError(error), true)
      return true
    },
  )

  await assert.rejects(
    grant.readEngineBoot({
      url: 'http://engine.test/stream.mjpg',
      nodeId: 'edge-node-01',
      secret,
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    error => {
      assert.equal(error.code, 'PRODUCER_AUTHORITY_UNAVAILABLE')
      assert.equal(grant.isRetryableProducerSyncError(error), false)
      return true
    },
  )
})

test('producer control retries transport failure but never retries stale-generation rejection', async () => {
  const instant = Date.now()
  const freshHandle = {
    ...handle,
    leaseExpiresAtMs: instant + 30_000,
    dbNowMs: instant,
    dbObservationStartMs: instant - 10,
    dbObservationEndMs: instant,
  }
  const liveBoot = { bootId: boot, uncertaintyMs: 0 }

  await assert.rejects(
    grant.sendDemandControl({
      url: 'http://engine.test/stream.mjpg',
      handle: freshHandle,
      boot: liveBoot,
      secret,
      action: 'refresh',
      fetchImpl: async () => { throw new Error('transient network failure') },
    }),
    error => {
      assert.equal(error.code, 'PRODUCER_AUTHORITY_UNAVAILABLE')
      assert.equal(grant.isRetryableProducerSyncError(error), true)
      return true
    },
  )

  await assert.rejects(
    grant.sendDemandControl({
      url: 'http://engine.test/stream.mjpg',
      handle: freshHandle,
      boot: liveBoot,
      secret,
      action: 'refresh',
      fetchImpl: async () => ({ ok: false, status: 409 }),
    }),
    error => {
      assert.equal(error.code, 'PRODUCER_AUTHORITY_UNAVAILABLE')
      assert.equal(grant.isRetryableProducerSyncError(error), false)
      return true
    },
  )
})
