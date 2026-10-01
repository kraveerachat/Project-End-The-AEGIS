import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { canonicalBrowserAssociationPayload } from '../server/nodeIdentity/browserAssociationProof.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const engineRoot = path.join(root, 'IDEA2-AEGIS_CCTV-Operator', 'detection-engine')
const token = (byte) => Buffer.alloc(32, byte).toString('base64url')

test('Node and Python browser-association canonical bytes are identical', () => {
  const claims = {
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
  }
  const script = [
    'import base64,json,sys',
    'from aegis_identity_agent.browser_protocol import canonical_browser_association_payload',
    'value=json.loads(base64.urlsafe_b64decode(sys.argv[1]+"=="))',
    'print(base64.urlsafe_b64encode(canonical_browser_association_payload(value)).decode("ascii"))',
  ].join(';')
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const result = spawnSync(process.env.AEGIS_TEST_PYTHON || 'python', ['-c', script, encoded], {
    cwd: engineRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.equal(Buffer.from(result.stdout.trim(), 'base64url').toString('hex'), canonicalBrowserAssociationPayload(claims).toString('hex'))
})
