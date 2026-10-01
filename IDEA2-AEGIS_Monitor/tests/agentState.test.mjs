import assert from 'node:assert/strict'
import test from 'node:test'

import { ChallengeStore } from '../server/nodeIdentity/challengeStore.js'
import { ReplayWindow } from '../server/nodeIdentity/replayWindow.js'
import { AgentSessionStore } from '../server/nodeIdentity/agentSessionStore.js'

function deterministicRandom(fill = 1) {
  let value = fill
  return (size) => Buffer.alloc(size, value++)
}

test('challenge store enforces canonical tokens, exact expiry, one use, and bounds', () => {
  let now = 1_000
  const store = new ChallengeStore({
    now: () => now,
    randomBytes: deterministicRandom(),
    ttlMs: 60_000,
    maxPerNode: 2,
    maxTotal: 3,
  })

  const first = store.issue({ nodeId: 'edge-a', audience: 'urn:test', keyVersion: 1 })
  const second = store.issue({ nodeId: 'edge-a', audience: 'urn:test', keyVersion: 1 })
  assert.match(first.challengeId, /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/)
  assert.match(first.nonce, /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/)
  assert.equal(first.expiresAtMs, 61_000)
  assert.throws(
    () => store.issue({ nodeId: 'edge-a', audience: 'urn:test', keyVersion: 1 }),
    /capacity/i,
  )

  const observed = store.get(first.challengeId)
  assert.equal(observed.nodeId, 'edge-a')
  assert.equal(store.consume(first.challengeId, observed), true)
  assert.equal(store.consume(first.challengeId, observed), false)

  const third = store.issue({ nodeId: 'edge-b', audience: 'urn:test', keyVersion: 1 })
  now = third.expiresAtMs
  assert.equal(store.get(third.challengeId), null)
  assert.equal(store.consume(third.challengeId, third), false)
  assert.equal(store.get(second.challengeId), null)
  assert.equal(store.size, 0)
})

test('challenge allocation purges expired entries before enforcing global capacity', () => {
  let now = 50
  const store = new ChallengeStore({
    now: () => now,
    randomBytes: deterministicRandom(10),
    ttlMs: 10,
    maxPerNode: 4,
    maxTotal: 1,
  })
  store.issue({ nodeId: 'edge-a', audience: 'urn:test', keyVersion: 1 })
  assert.throws(() => store.issue({ nodeId: 'edge-b', audience: 'urn:test', keyVersion: 1 }), /capacity/i)
  now = 60
  assert.doesNotThrow(() => store.issue({ nodeId: 'edge-b', audience: 'urn:test', keyVersion: 1 }))
})

test('challenge tokens use rejection sampling instead of rewriting a forbidden prefix', () => {
  const samples = [Buffer.alloc(32, 0xf8), Buffer.alloc(32, 0xfc), Buffer.alloc(32, 0x01)]
  let calls = 0
  const store = new ChallengeStore({
    randomBytes(size) {
      assert.equal(size, 32)
      calls += 1
      return samples.shift() ?? Buffer.alloc(32, 0x02)
    },
  })
  const challenge = store.issue({ nodeId: 'edge-a', audience: 'urn:test', keyVersion: 1 })
  assert.match(challenge.challengeId, /^[A-Za-z0-9]/)
  assert.match(challenge.nonce, /^[A-Za-z0-9]/)
  assert.equal(calls, 4)
})

test('challenge and session stores reject random identifier collisions', () => {
  const challengeSamples = [1, 2, 1, 3, 4].map((fill) => Buffer.alloc(32, fill))
  const challenges = new ChallengeStore({ randomBytes: () => challengeSamples.shift() })
  const firstChallenge = challenges.issue({ nodeId: 'edge-a', audience: 'urn:test', keyVersion: 1 })
  const secondChallenge = challenges.issue({ nodeId: 'edge-b', audience: 'urn:test', keyVersion: 1 })
  assert.notEqual(firstChallenge.challengeId, secondChallenge.challengeId)
  assert.equal(challenges.size, 2)

  const sessionSamples = [10, 10, 11].map((fill) => Buffer.alloc(32, fill))
  const sessions = new AgentSessionStore({ randomBytes: () => sessionSamples.shift() })
  const firstSession = sessions.create({ nodeId: 'edge-a', keyVersion: 1, physicalCameraId: 1 })
  const secondSession = sessions.create({ nodeId: 'edge-b', keyVersion: 1, physicalCameraId: 2 })
  assert.notEqual(firstSession.sessionId, secondSession.sessionId)
  assert.equal(sessions.lookup(firstSession.sessionId).nodeId, 'edge-a')
  assert.equal(sessions.lookup(secondSession.sessionId).nodeId, 'edge-b')
})

test('replay window accepts bounded out-of-order sequences once and rejects old or duplicate values', () => {
  const window = new ReplayWindow()
  assert.equal(window.acceptSequence(100n), true)
  assert.equal(window.acceptSequence(102n), true)
  assert.equal(window.acceptSequence(101n), true)
  assert.equal(window.acceptSequence(101n), false)
  assert.equal(window.acceptSequence(38n), false)
  assert.equal(window.acceptSequence(0n), false)
  assert.equal(window.acceptSequence((1n << 64n)), false)
})

test('request nonces are one-use and expire only after their acceptance window closes', () => {
  const window = new ReplayWindow()
  assert.equal(window.acceptNonce('nonce-digest-a', { retainUntilMs: 31_000, nowMs: 1_000 }), true)
  assert.equal(window.acceptNonce('nonce-digest-a', { retainUntilMs: 31_000, nowMs: 2_000 }), false)
  assert.equal(window.acceptNonce('nonce-digest-b', { retainUntilMs: 32_000, nowMs: 31_000 }), true)
  assert.equal(window.acceptNonce('nonce-digest-a', { retainUntilMs: 62_000, nowMs: 31_001 }), true)
})

test('agent sessions store only digests, replace per-node state, expire exactly, and are memory-only', () => {
  let now = 5_000
  const store = new AgentSessionStore({
    now: () => now,
    randomBytes: deterministicRandom(20),
    ttlMs: 600_000,
    maxSessions: 2,
  })
  const first = store.create({ nodeId: 'edge-a', keyVersion: 2, physicalCameraId: 11 })
  assert.match(first.sessionId, /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/)
  assert.equal(store.lookup(first.sessionId).nodeId, 'edge-a')
  assert.equal(JSON.stringify(store).includes(first.sessionId), false)

  const replacement = store.create({ nodeId: 'edge-a', keyVersion: 2, physicalCameraId: 11 })
  assert.equal(store.lookup(first.sessionId), null)
  assert.equal(store.lookup(replacement.sessionId).physicalCameraId, 11)
  const other = store.create({ nodeId: 'edge-b', keyVersion: 1, physicalCameraId: 12 })
  assert.throws(
    () => store.create({ nodeId: 'edge-c', keyVersion: 1, physicalCameraId: 13 }),
    /capacity/i,
  )

  now = replacement.expiresAtMs
  assert.equal(store.lookup(replacement.sessionId), null)
  assert.equal(store.lookup(other.sessionId), null)
  assert.equal(store.size, 0)
  assert.equal(new AgentSessionStore().lookup(replacement.sessionId), null)
})
