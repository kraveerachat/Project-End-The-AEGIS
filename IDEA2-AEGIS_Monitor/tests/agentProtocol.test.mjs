import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AUTH_DOMAIN,
  REQUEST_PROOFS,
  canonicalAuthPayload,
  canonicalRequestPayload,
  parseCanonicalToken,
  parseStrictJsonBytes,
  parseUint,
} from '../server/nodeIdentity/agentProtocol.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vectors = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/agentProofV1.json'), 'utf8'))

test('canonical auth vector is byte-exact UTF-8 without trailing LF', () => {
  assert.equal(AUTH_DOMAIN, 'AEGIS-AGENT-AUTH-V1')
  const payload = canonicalAuthPayload(vectors.auth.fields)
  assert.ok(Buffer.isBuffer(payload))
  assert.equal(payload.toString('utf8'), vectors.auth.canonical)
  assert.equal(payload.at(-1), '7'.charCodeAt(0))
})

test('canonical heartbeat request vector binds the fixed domain, path, method, body hash, and uint64 sequence', () => {
  assert.deepEqual(REQUEST_PROOFS.heartbeat, {
    domain: 'AEGIS-AGENT-HEARTBEAT-V1',
    method: 'POST',
    path: '/internal/heartbeat',
  })
  assert.equal(canonicalRequestPayload(vectors.request.fields).toString('utf8'), vectors.request.canonical)
  assert.throws(
    () => canonicalRequestPayload({ ...vectors.request.fields, domain: 'AEGIS-ENGINE-DETECTION-V1' }),
    /domain/i,
  )
  assert.throws(
    () => canonicalRequestPayload({ ...vectors.request.fields, path: '/internal/detections' }),
    /path/i,
  )
})

test('all request proof domains are separate and fixed to one canonical route', () => {
  assert.deepEqual(REQUEST_PROOFS, {
    heartbeat: { domain: 'AEGIS-AGENT-HEARTBEAT-V1', method: 'POST', path: '/internal/heartbeat' },
    detection: { domain: 'AEGIS-ENGINE-DETECTION-V1', method: 'POST', path: '/internal/detections' },
    alert: { domain: 'AEGIS-ENGINE-ALERT-V1', method: 'POST', path: '/internal/alerts' },
    clip: { domain: 'AEGIS-ENGINE-CLIP-V1', method: 'POST', path: '/internal/clips' },
  })
  assert.equal(new Set(Object.values(REQUEST_PROOFS).map(({ domain }) => domain)).size, 4)
})

test('canonical token parser rejects padding, forbidden leading characters, malformed alphabet, and wrong decoded length', () => {
  assert.equal(parseCanonicalToken(vectors.auth.fields.challengeId, 32, 'challenge'), vectors.auth.fields.challengeId)
  for (const invalid of [
    `${vectors.auth.fields.challengeId}=`,
    `-${vectors.auth.fields.challengeId.slice(1)}`,
    `_${vectors.auth.fields.challengeId.slice(1)}`,
    `!${vectors.auth.fields.challengeId.slice(1)}`,
    vectors.request.fields.requestNonce,
  ]) {
    assert.throws(() => parseCanonicalToken(invalid, 32, 'challenge'), /challenge/i)
  }
})

test('unsigned decimal parser enforces canonical uint64 and positive uint32 boundaries', () => {
  assert.equal(parseUint('0', { label: 'sequence' }), 0n)
  assert.equal(parseUint('18446744073709551615', { label: 'sequence' }), 18446744073709551615n)
  assert.equal(parseUint('4294967295', { label: 'key version', positive: true, max: 4294967295n }), 4294967295n)
  for (const invalid of ['', '-1', '+1', '01', '1.0', '18446744073709551616']) {
    assert.throws(() => parseUint(invalid, { label: 'sequence' }), /sequence/i)
  }
  assert.throws(() => parseUint('0', { label: 'key version', positive: true, max: 4294967295n }), /key version/i)
})

test('strict JSON byte parser rejects duplicate keys, invalid UTF-8, non-objects, and bodies above 16 KiB', () => {
  assert.deepEqual(parseStrictJsonBytes(Buffer.from('{"nodeId":"edge-a"}')), { nodeId: 'edge-a' })
  assert.throws(() => parseStrictJsonBytes(Buffer.from('{"nodeId":"edge-a","nodeId":"edge-b"}')), /duplicate/i)
  assert.throws(() => parseStrictJsonBytes(Buffer.from([0xc3, 0x28])), /utf-8/i)
  assert.throws(() => parseStrictJsonBytes(Buffer.from('[]')), /object/i)
  assert.throws(() => parseStrictJsonBytes(Buffer.alloc(16 * 1024 + 1, 0x20)), /size/i)
})

test('canonical builders reject unknown fields rather than signing ambiguous structures', () => {
  assert.throws(() => canonicalAuthPayload({ ...vectors.auth.fields, extra: 'not-signed' }), /field/i)
  assert.throws(() => canonicalRequestPayload({ ...vectors.request.fields, extra: 'not-signed' }), /field/i)
})
