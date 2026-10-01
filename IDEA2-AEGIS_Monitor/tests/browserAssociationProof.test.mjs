import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import {
  BROWSER_ASSOCIATION_DOMAIN,
  canonicalBrowserAssociationPayload,
  verifyBrowserAssociationProof,
} from '../server/nodeIdentity/browserAssociationProof.js'

const token = (byte, size = 32) => Buffer.alloc(size, byte).toString('base64url')

const claims = Object.freeze({
  version: 1,
  purpose: 'AEGIS-BROWSER-NODE-ASSOCIATION-V1',
  audience: 'https://aegis.internal',
  challenge_id: token(1),
  challenge_nonce: token(2),
  session_binding: token(3),
  node_id: 'edge-node-01',
  key_version: 7,
  issued_at_ms: 1_750_000_000_000,
  expires_at_ms: 1_750_000_030_000,
})

test('browser association canonical bytes use a distinct fixed domain and exact field order', () => {
  const rendered = canonicalBrowserAssociationPayload(claims).toString('utf8')
  assert.equal(BROWSER_ASSOCIATION_DOMAIN, 'AEGIS-BROWSER-NODE-ASSOCIATION-V1')
  assert.equal(rendered.split('\n')[0], BROWSER_ASSOCIATION_DOMAIN)
  assert.deepEqual(rendered.split('\n').slice(1).map((line) => line.split('=', 1)[0]), [
    'version', 'purpose_b64', 'audience_b64', 'challenge_id', 'challenge_nonce',
    'session_binding', 'node_id_b64', 'key_version', 'issued_at_ms', 'expires_at_ms',
  ])
  assert.doesNotMatch(rendered, /AEGIS-(?:AGENT-AUTH|ENGINE-DETECTION|AGENT-HEARTBEAT)-V1/)
})

test('valid proof verifies while wrong domain, session, audience, and exact expiry fail closed', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, canonicalBrowserAssociationPayload(claims), privateKey).toString('base64url')
  const expected = {
    audience: claims.audience,
    sessionBinding: claims.session_binding,
    challengeId: claims.challenge_id,
    challengeNonce: claims.challenge_nonce,
    issuedAtMs: claims.issued_at_ms,
    expiresAtMs: claims.expires_at_ms,
  }
  assert.equal(verifyBrowserAssociationProof({ claims, signature, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), expected, nowMs: claims.issued_at_ms + 1 }), true)
  for (const altered of [
    { ...claims, purpose: 'AEGIS-AGENT-AUTH-V1' },
    { ...claims, session_binding: token(4) },
    { ...claims, audience: 'https://attacker.invalid' },
  ]) {
    assert.equal(verifyBrowserAssociationProof({ claims: altered, signature, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), expected, nowMs: claims.issued_at_ms + 1 }), false)
  }
  assert.equal(verifyBrowserAssociationProof({ claims, signature, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), expected, nowMs: claims.expires_at_ms }), false)
})

test('canonicalization rejects unknown fields, malformed tokens, unsafe integers, and cross-domain claims', () => {
  assert.throws(() => canonicalBrowserAssociationPayload({ ...claims, camera_id: 'CAM-01' }), /field/i)
  assert.throws(() => canonicalBrowserAssociationPayload({ ...claims, challenge_id: `-${claims.challenge_id.slice(1)}` }), /challenge/i)
  assert.throws(() => canonicalBrowserAssociationPayload({ ...claims, issued_at_ms: Number.MAX_SAFE_INTEGER + 1 }), /issued/i)
  assert.throws(() => canonicalBrowserAssociationPayload({ ...claims, purpose: 'AEGIS-ENGINE-DETECTION-V1' }), /purpose/i)
})
