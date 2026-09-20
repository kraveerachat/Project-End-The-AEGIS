import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserAssociationChallengeStore } from '../server/nodeIdentity/browserAssociationChallenges.js'

const sessionBinding = Buffer.alloc(32, 9).toString('base64url')

test('challenge is session-bound, one-use, and expired at the exact boundary', () => {
  let now = 10_000
  let value = 0
  const store = new BrowserAssociationChallengeStore({
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++value),
  })
  const challenge = store.issue({ sessionBinding, audience: 'https://aegis.internal' })
  assert.equal(challenge.expires_at_ms, 40_000)
  assert.equal(store.consume({ challengeId: challenge.challenge_id, sessionBinding: Buffer.alloc(32, 8).toString('base64url') }), null)
  assert.deepEqual(store.consume({ challengeId: challenge.challenge_id, sessionBinding }), challenge)
  assert.equal(store.consume({ challengeId: challenge.challenge_id, sessionBinding }), null)

  const expiring = store.issue({ sessionBinding, audience: 'https://aegis.internal' })
  now = expiring.expires_at_ms
  assert.equal(store.consume({ challengeId: expiring.challenge_id, sessionBinding }), null)
})

test('challenge store retains at most eight per session and evicts the oldest deterministically', () => {
  let value = 0
  const store = new BrowserAssociationChallengeStore({
    now: () => 50_000,
    randomBytes: (size) => Buffer.alloc(size, ++value),
  })
  const challenges = Array.from({ length: 9 }, () => store.issue({ sessionBinding, audience: 'https://aegis.internal' }))
  assert.equal(store.consume({ challengeId: challenges[0].challenge_id, sessionBinding }), null)
  assert.ok(store.consume({ challengeId: challenges[8].challenge_id, sessionBinding }))
  assert.equal(store.size, 7)
})

test('token generation uses rejection sampling when Base64URL begins with a forbidden character', () => {
  const samples = [Buffer.alloc(32, 0xfb), Buffer.alloc(32, 7), Buffer.alloc(32, 8)]
  const store = new BrowserAssociationChallengeStore({ now: () => 1, randomBytes: () => samples.shift() })
  const challenge = store.issue({ sessionBinding, audience: 'https://aegis.internal' })
  assert.match(challenge.challenge_id, /^[A-Za-z0-9]/)
  assert.match(challenge.challenge_nonce, /^[A-Za-z0-9]/)
})

test('combined active and consumed replay state cannot exceed the configured total cap', () => {
  let value = 0
  const store = new BrowserAssociationChallengeStore({
    now: () => 1,
    randomBytes: (size) => Buffer.alloc(size, ++value),
    maxTotal: 2,
  })
  for (let index = 0; index < 2; index += 1) {
    const challenge = store.issue({ sessionBinding, audience: 'https://aegis.internal' })
    assert.ok(store.consume({ challengeId: challenge.challenge_id, sessionBinding }))
  }
  assert.throws(
    () => store.issue({ sessionBinding, audience: 'https://aegis.internal' }),
    /capacity/i,
  )
})
