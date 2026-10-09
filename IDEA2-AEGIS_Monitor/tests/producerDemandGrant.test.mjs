import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import * as grant from '../server/auth/producerDemandGrant.js'

const secret = 'fixture-engine-key'
const now = 1_800_000_000_000
const boot = Buffer.alloc(32, 4).toString('base64url')
const machineABoot = { bootId: boot, offsetLowerMs: 10, offsetUpperMs: 30,
  observedAtMs: now + 20, observedAtMonoMs: 1_020 }
const handle = { userId: '2', nodeId: 'edge-node-01', physicalCameraId: '1',
  logicalCameraId: 'CAM-02', producerGeneration: '9007199254740993',
  demandOwnerId: Buffer.alloc(32, 1).toString('base64url'),
  sessionBindingHash: `v1:${'b'.repeat(64)}`, leaseExpiresAtMs: now + 30_000,
  dbNowMs: now, dbObservationStartMs: now - 20, dbObservationEndMs: now + 20,
  dbObservationStartMonoMs: 980, dbObservationEndMonoMs: 1_020 }
function decode(token) { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')) }
function clockToken(payload) {
  const raw = Buffer.from(JSON.stringify(payload, Object.keys(payload).sort()))
  const key = createHmac('sha256', secret).update('AEGIS-demand-grant-v1-key').digest()
  return `${raw.toString('base64url')}.${createHmac('sha256', key).update('aegis-producer-clock-v1\n').update(raw).digest('base64url')}`
}

test('grant uses only committed server handle, exact generation and earlier DB expiry', () => {
  const token = grant.mintDemandGrant({ handle, boot: machineABoot, secret, nowMs: now + 40,
    nowMonoMs: 1_040, action: 'attach' })
  const claims = decode(token)
  assert.equal(claims.logicalCameraId, 'CAM-02')
  assert.equal(claims.producerGeneration, '9007199254740993')
  assert.equal(claims.userId, '2')
  assert.equal(claims.sessionBindingHash, handle.sessionBindingHash)
  assert.equal(claims.physicalCameraId, 1)
  assert.equal(claims.expiresAtMs, now + 28_900)
  assert.equal(claims.engineBootId, boot)
  assert.notEqual(claims.jti, decode(grant.mintDemandGrant({ handle, boot: machineABoot,
    secret, nowMs: now + 40, nowMonoMs: 1_040, action: 'attach' })).jti)
  assert.equal(Object.hasOwn(claims, 'sessionBinding'), false)
})

test('missing DB timestamps, late commit, expired lease and unknown clock fail closed', () => {
  for (const changed of [{ leaseExpiresAtMs: undefined }, { dbNowMs: undefined },
    { dbNowMs: now + 521 }, { dbObservationEndMs: now + 501 },
    { leaseExpiresAtMs: now + 100 }]) {
    assert.throws(() => grant.mintDemandGrant({ handle: { ...handle, ...changed },
      boot: machineABoot, secret, nowMs: now + 40, nowMonoMs: 1_040, action: 'attach' }))
  }
  for (const badBoot of [undefined, { ...machineABoot, offsetLowerMs: -901 },
    { ...machineABoot, offsetUpperMs: 901 }]) {
    assert.throws(() => grant.mintDemandGrant({ handle, bootId: boot, secret,
      boot: badBoot, nowMs: now + 40, nowMonoMs: 1_040, action: 'attach' }))
  }
})

test('authenticated boot clock is nonce/node bound with 500ms exact boundary', () => {
  const nonce = 'c'.repeat(64)
  const payload = { engineBootId: boot, nodeId: 'edge-node-01', nonce, engineNowMs: now }
  const verify = (p, endMs = now + 500) => grant.verifyBootClock({ token: clockToken(p),
    secret, nonce, nodeId: 'edge-node-01', startMs: now, endMs,
    startMonoMs: 1_000, endMonoMs: 1_000 + (endMs - now) })
  assert.equal(verify(payload).offsetLowerMs, -500)
  assert.throws(() => verify(payload, now + 501))
  assert.throws(() => verify({ ...payload, engineNowMs: now - 501 }))
  assert.throws(() => verify({ ...payload, nonce: 'd'.repeat(64) }))
  assert.throws(() => verify({ ...payload, nodeId: 'other' }))
})

test('DB clock exact 500ms bound is accepted and just outside rejected', () => {
  const options = { boot: machineABoot, secret, nowMs: now + 40,
    nowMonoMs: 1_040, action: 'attach' }
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
  const instantMono = Math.floor(performance.now())
  const freshHandle = {
    ...handle,
    leaseExpiresAtMs: instant + 30_000,
    dbNowMs: instant,
    dbObservationStartMs: instant - 10,
    dbObservationEndMs: instant,
    dbObservationStartMonoMs: instantMono - 10,
    dbObservationEndMonoMs: instantMono,
  }
  const liveBoot = { bootId: boot, offsetLowerMs: 0, offsetUpperMs: 0,
    observedAtMs: instant, observedAtMonoMs: instantMono }

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

test('signed Machine C boot proof accepts bounded +559ms offset without relaxing 500ms RTT', () => {
  const nonce = 'c'.repeat(64)
  const proof = clockToken({ engineBootId: boot, nodeId: 'edge-node-01', nonce,
    engineNowMs: now + 607 })
  const result = grant.verifyBootClock({ token: proof, secret, nonce,
    nodeId: 'edge-node-01', startMs: now, endMs: now + 170,
    startMonoMs: 1_000, endMonoMs: 1_170 })
  assert.equal(result.offsetLowerMs, 437)
  assert.equal(result.offsetUpperMs, 607)
  assert.equal(result.bootId, boot)
  assert.throws(() => grant.verifyBootClock({ token: proof, secret, nonce,
    nodeId: 'edge-node-01', startMs: now, endMs: now + 170,
    startMonoMs: 1_000, endMonoMs: 1_501 }))
})

test('signed Machine C +811ms offset is accepted within the shared 900ms bound', () => {
  const nonce = 'i'.repeat(64)
  const signedBoot = grant.verifyBootClock({
    token: clockToken({ engineBootId: boot, nodeId: 'edge-node-01', nonce,
      engineNowMs: now + 811 }),
    secret, nonce, nodeId: 'edge-node-01', startMs: now, endMs: now + 170,
    startMonoMs: 1_000, endMonoMs: 1_170,
  })
  assert.equal(signedBoot.offsetLowerMs, 641)
  assert.equal(signedBoot.offsetUpperMs, 811)
  const token = grant.mintDemandGrant({
    handle, boot: signedBoot, secret, action: 'attach',
    nowMs: now + 210, nowMonoMs: 1_210,
  })
  assert.ok(decode(token).expiresAtMs <= handle.leaseExpiresAtMs + 641 - 500 - 150)
})

test('signed opposite-direction and exact skew boundaries are conservative', () => {
  const nonce = 'd'.repeat(64)
  const verify = (engineNowMs, startMs = now, endMs = now + 170) =>
    grant.verifyBootClock({ token: clockToken({ engineBootId: boot,
      nodeId: 'edge-node-01', nonce, engineNowMs }), secret, nonce,
    nodeId: 'edge-node-01', startMs, endMs,
    startMonoMs: 1_000, endMonoMs: 1_170 })
  assert.equal(verify(now - 559).offsetLowerMs, -729)
  assert.equal(verify(now + 900).offsetUpperMs, 900)
  assert.equal(verify(now - 730).offsetLowerMs, -900)
  assert.throws(() => verify(now + 901))
  assert.throws(() => verify(now - 731))
})

test('Monitor wall discontinuity within probe and before mint fails closed', () => {
  const nonce = 'e'.repeat(64)
  const token = clockToken({ engineBootId: boot, nodeId: 'edge-node-01',
    nonce, engineNowMs: now + 607 })
  assert.throws(() => grant.verifyBootClock({ token, secret, nonce,
    nodeId: 'edge-node-01', startMs: now, endMs: now + 70,
    startMonoMs: 1_000, endMonoMs: 1_170 }))

  const validBoot = grant.verifyBootClock({ token, secret, nonce,
    nodeId: 'edge-node-01', startMs: now, endMs: now + 170,
    startMonoMs: 1_000, endMonoMs: 1_170 })
  assert.throws(() => grant.mintDemandGrant({ handle: {
    ...handle, dbObservationStartMonoMs: 980, dbObservationEndMonoMs: 1_020,
  }, boot: validBoot, secret, action: 'attach', nowMs: now + 210,
  nowMonoMs: 1_310 }))
})

test('Machine C grant expires no later than the historical DB lease in Engine time', () => {
  const nonce = 'f'.repeat(64)
  const signedBoot = grant.verifyBootClock({
    token: clockToken({ engineBootId: boot, nodeId: 'edge-node-01', nonce,
      engineNowMs: now + 607 }), secret, nonce, nodeId: 'edge-node-01',
    startMs: now, endMs: now + 170, startMonoMs: 1_000, endMonoMs: 1_170,
  })
  const boundedHandle = { ...handle, leaseExpiresAtMs: now + 10_000,
    dbObservationStartMs: now - 20, dbObservationEndMs: now + 20,
    dbObservationStartMonoMs: 980, dbObservationEndMonoMs: 1_020 }
  const token = grant.mintDemandGrant({ handle: boundedHandle, boot: signedBoot,
    secret, action: 'attach', nowMs: now + 210, nowMonoMs: 1_210 })
  // Full 500ms DB/Monitor offset, 100ms future DB/Engine divergence,
  // and 50ms for tolerated Monitor sampling discrepancies.
  assert.equal(decode(token).expiresAtMs, now + 10_000 + 437 - 500 - 150)
})

test('behind-clock and maximum DB offset yield conservative Engine expiries', () => {
  const behindBoot = { bootId: boot, offsetLowerMs: -729, offsetUpperMs: -559,
    observedAtMs: now + 170, observedAtMonoMs: 1_170 }
  const boundedHandle = { ...handle, leaseExpiresAtMs: now + 10_000,
    dbNowMs: now + 480 }
  const token = grant.mintDemandGrant({ handle: boundedHandle, boot: behindBoot,
    secret, action: 'attach', nowMs: now + 210, nowMonoMs: 1_210 })
  // Full 500ms DB/Monitor offset remains reserved even after an earlier sample.
  assert.equal(decode(token).expiresAtMs, now + 10_000 - 729 - 500 - 150)
  assert.throws(() => grant.mintDemandGrant({ handle: {
    ...boundedHandle, dbNowMs: now + 481,
  }, boot: behindBoot, secret, action: 'attach', nowMs: now + 210,
  nowMonoMs: 1_210 }))
})

test('Boot verification rejects invalid signature and replayed nonce before offset use', () => {
  const nonce = 'g'.repeat(64)
  const signed = clockToken({ engineBootId: boot, nodeId: 'edge-node-01', nonce,
    engineNowMs: now + 607 })
  const options = { secret, nonce, nodeId: 'edge-node-01', startMs: now,
    endMs: now + 170, startMonoMs: 1_000, endMonoMs: 1_170 }
  assert.throws(() => grant.verifyBootClock({ ...options,
    token: `${signed.slice(0, -1)}${signed.endsWith('A') ? 'B' : 'A'}` }))
  assert.throws(() => grant.verifyBootClock({ ...options, nonce: 'h'.repeat(64),
    token: signed }))
  assert.throws(() => grant.verifyBootClock({ ...options, nodeId: 'other',
    token: signed }))
})

test('probe measures RTT monotonically and rejects clock jumps and network delay', async () => {
  const run = async (wallValues, monoValues) => {
    const wall = [...wallValues], mono = [...monoValues]
    return grant.readEngineBoot({ url: 'http://engine.test/stream.mjpg',
      nodeId: 'edge-node-01', secret,
      wallClock: () => wall.shift(), monoClock: () => mono.shift(),
      fetchImpl: async (_url, options) => ({ ok: true, text: async () =>
        clockToken({ engineBootId: boot, nodeId: 'edge-node-01',
          nonce: options.headers['X-Aegis-Clock-Nonce'], engineNowMs: now + 607 }) }),
    })
  }
  assert.equal((await run([now, now + 170], [1_000, 1_170])).offsetLowerMs, 437)
  assert.equal((await run([now, now + 500], [1_000.1, 1_500])).offsetLowerMs, 107)
  for (const [wall, mono] of [
    [[now, now + 500], [1_000.1, 1_500.2]],
    [[now, now + 501], [1_000, 1_501]],
    [[now, now + 170], [1_000, 1_501]],
    [[now, now + 70], [1_000, 1_170]],
  ]) {
    await assert.rejects(run(wall, mono), error => {
      assert.equal(error.code, 'PRODUCER_AUTHORITY_UNAVAILABLE')
      assert.equal(grant.isRetryableProducerSyncError(error), false)
      return true
    })
  }
})

test('DB observation discontinuity, Monitor rollback and stale boot fail closed at mint', () => {
  const bootEvidence = { bootId: boot, offsetLowerMs: 437, offsetUpperMs: 607,
    observedAtMs: now + 170, observedAtMonoMs: 1_170 }
  const args = { handle, boot: bootEvidence, secret, action: 'attach',
    nowMs: now + 210, nowMonoMs: 1_210 }
  assert.throws(() => grant.mintDemandGrant({ ...args,
    handle: { ...handle, dbObservationEndMonoMs: 1_120 } }))
  assert.throws(() => grant.mintDemandGrant({ ...args,
    nowMs: now + 180 }))
  assert.throws(() => grant.mintDemandGrant({ ...args,
    nowMs: now + 711, nowMonoMs: 1_711 }))
})

test('tolerated Monitor clock step cannot consume the separate DB-Engine drift reserve', () => {
  const steppedHandle = { ...handle, leaseExpiresAtMs: now + 30_000,
    dbNowMs: now, dbObservationStartMs: now,
    dbObservationEndMs: now + 500, dbObservationStartMonoMs: 0,
    dbObservationEndMonoMs: 500 }
  // Monitor loses 25ms after the DB observation; the signed Engine proof
  // sees that offset, while future DB-vs-Engine drift may still reach 100ms.
  const steppedBoot = { bootId: boot, offsetLowerMs: 25, offsetUpperMs: 25,
    observedAtMs: now + 500, observedAtMonoMs: 525 }
  const token = grant.mintDemandGrant({ handle: steppedHandle, boot: steppedBoot,
    secret, action: 'attach', nowMs: now + 1_000, nowMonoMs: 1_025 })
  assert.ok(decode(token).expiresAtMs <= now + 29_900)
})

test('common DB and Engine clock movement between observations cannot outlive DB lease', () => {
  const steppedHandle = { ...handle, leaseExpiresAtMs: now + 30_000,
    dbNowMs: now, dbObservationStartMs: now,
    dbObservationEndMs: now + 500, dbObservationStartMonoMs: 0,
    dbObservationEndMonoMs: 500 }
  // After DB commit, both DB and Engine move forward by 500ms relative to
  // Monitor. Their relative drift is zero, but the DB sample is now stale.
  const steppedBoot = { bootId: boot, offsetLowerMs: 500, offsetUpperMs: 500,
    observedAtMs: now + 525, observedAtMonoMs: 525 }
  const token = grant.mintDemandGrant({ handle: steppedHandle, boot: steppedBoot,
    secret, action: 'attach', nowMs: now + 1_000, nowMonoMs: 1_000 })
  assert.ok(decode(token).expiresAtMs <= steppedHandle.leaseExpiresAtMs)
})
