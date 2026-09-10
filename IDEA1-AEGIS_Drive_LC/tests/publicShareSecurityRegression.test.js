// tests/publicShareSecurityRegression.test.js — AEGIS Drive (IDEA1) · PUBLIC-SHARE-5
//
// The public-share security regression matrix. This suite adds no product
// behaviour: it pins the invariants the merged PUBLIC-SHARE-1..4 work already
// claims, so a future change cannot quietly retract one of them.
//
// It deliberately does NOT duplicate what is already pinned elsewhere:
//   publicShareConfig.test.js   configuration, ingress helpers, migration 009
//   publicShareBackend.test.js  scope gating, publicUrl, ingress provenance
//   trustedProxy.test.js        the two approved trusted-proxy states
//   shareScopeTruthUi.test.js   the Shares screen contract
//   publicShareGateway*.test.js the dedicated gateway route/log/isolation matrix
//
// What it adds is the recipient-facing and forensic half of the matrix that no
// single existing suite owns end to end:
//   §5  token/existence indistinguishability
//   §6  raw-token secrecy across every persisted and reported surface
//   §7  password secrecy
//   §8  password correctness and server-side lockout
//   §9  T-05 limiter namespace separation, in BOTH directions
//   §12 Vault exclusion at redemption, not only at creation
//   §13 ownership lifecycle and object-hiding
//   §14 trash
//   §15 expiry, revoke and the hit counter
//   §16 response security headers
//   §23 audit content: what must be recorded, and what must never be
//
// ⚠️ 127.0.0.2 models the HUB/private edge and 127.0.0.3 the public gateway.
//    Both are trusted proxies; only 127.0.0.3 is the configured gateway
//    identity. 127.0.0.4 models an UNTRUSTED peer.
//
// ⚠️ Every test uses its own recipient IP. The limiter is process-global with no
//    reset hook, so a shared address would let one test's lockout leak into
//    another and produce a false pass.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { Client, loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-ps5-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.TRUSTED_PROXY_CIDRS = '127.0.0.2/32,127.0.0.3/32'
process.env.PUBLIC_SHARE_GATEWAY_CIDR = '127.0.0.3/32'
process.env.PUBLIC_SHARE_BASE_URL = 'https://share.example.invalid'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initAvatarStorage } = await import('../server/storage/avatarStore.js')
const store = await import('../server/db/store.js')
const { usingPostgres, closePool, query, readAudit } = await import('../server/db/connection.js')

const FILE_NAME = 'ps5regression-report.pdf'
const FILE_BODY = 'PS5-REGRESSION-FILE-BYTES-DO-NOT-LEAK'

let driveServer, privateProxy, gatewayProxy, untrustedProxy
let directBaseUrl, privateBaseUrl, gatewayBaseUrl, untrustedBaseUrl

/** A local TCP hop that models a trusted edge, connecting FROM `localAddress`. */
function edgeProxy(localAddress, { sanitize = true } = {}) {
  return createServer((clientReq, clientRes) => {
    const headers = { ...clientReq.headers }
    if (sanitize) {
      const sourceIp = String(clientReq.headers['x-test-client-ip'] ?? '198.51.100.250')
      headers['x-forwarded-for'] = sourceIp
      headers['x-real-ip'] = sourceIp
      delete headers.forwarded
    }
    delete headers['x-test-client-ip']

    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: driveServer.address().port,
      localAddress,
      method: clientReq.method,
      path: clientReq.url,
      headers,
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers)
      upstreamRes.pipe(clientRes)
    })
    upstream.on('error', (error) => clientRes.destroy(error))
    clientReq.pipe(upstream)
  })
}

const listen = async (server) => {
  server.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return `http://127.0.0.1:${server.address().port}`
}

before(async () => {
  await initStorage()
  await initAvatarStorage()

  driveServer = createApp().listen(0, '127.0.0.1')
  await new Promise((r) => driveServer.once('listening', r))
  directBaseUrl = `http://127.0.0.1:${driveServer.address().port}`

  privateProxy = edgeProxy('127.0.0.2')
  gatewayProxy = edgeProxy('127.0.0.3')
  // An untrusted peer that forwards whatever the caller sent, untouched.
  untrustedProxy = edgeProxy('127.0.0.4', { sanitize: false })
  privateBaseUrl = await listen(privateProxy)
  gatewayBaseUrl = await listen(gatewayProxy)
  untrustedBaseUrl = await listen(untrustedProxy)
})

after(async () => {
  for (const server of [privateProxy, gatewayProxy, untrustedProxy, driveServer]) {
    await new Promise((r) => server.close(r))
  }
  if (usingPostgres) {
    await query('DELETE FROM shares')
    await query(`DELETE FROM files WHERE name LIKE 'ps5regression-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  await store.__resetSharesForTests()
})

async function uploadFile(client, { name = FILE_NAME, content = FILE_BODY } = {}) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'application/octet-stream' }), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.data)}`)
  return res.data.file
}

const createShare = (client, fileId, opts = {}) => client.req('/api/shares', {
  method: 'POST',
  body: { fileId, expiry: '24h', authType: 'none', scope: 'any', ...opts },
})

/** A recipient: no cookie, no session, no CSRF — someone opening a link. */
function recipient(baseUrl, ip) {
  const c = new Client(baseUrl)
  const withIp = (extra = {}) => (ip ? { 'X-Test-Client-IP': ip, ...extra } : { ...extra })
  return {
    raw: (pathname, opts = {}) => c.raw(pathname, { ...opts, headers: withIp(opts.headers) }),
    rawPost: (pathname, body, extra = {}) => c.raw(pathname, {
      method: 'POST',
      body,
      headers: withIp({ 'Content-Type': 'application/x-www-form-urlencoded', ...extra }),
    }),
  }
}

const hitsOf = async (client, shareId) => {
  const res = await client.req('/api/shares')
  return res.data.shares.find((s) => String(s.id) === String(shareId))?.hits
}

const tokenOf = (created) => created.data.path.split('/').pop()

/** Every audit row as one lowercase blob, for absence assertions. */
const auditText = async (limit = 60) => JSON.stringify(await readAudit(limit)).toLowerCase()

/**
 * Direct row access for the defence-in-depth gates that a well-behaved API can
 * never reach (a Vault-backed share row, an already-expired row). PostgreSQL
 * only: in memory mode the store exposes no such hook, and inventing one would
 * be a source change this phase is not allowed to make.
 */
const canForgeRows = usingPostgres

/* ══════════════════════════════════════════════════════════════════════════
   §5 · PS5-T02 — the recipient cannot tell WHY a link does not work
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-T02-1 unknown, malformed, revoked and trashed links are one indistinguishable refusal', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const secretName = `ps5regression-secret-${randomBytes(4).toString('hex')}.pdf`
  const revokedFile = await uploadFile(owner, { name: secretName })
  const trashedFile = await uploadFile(owner, { name: secretName })

  const revoked = await createShare(owner, revokedFile.id, { scope: 'public' })
  assert.equal(revoked.status, 201)
  await owner.req(`/api/shares/${revoked.data.share.id}`, { method: 'DELETE' })

  const trashed = await createShare(owner, trashedFile.id, { scope: 'public' })
  assert.equal(trashed.status, 201)
  await owner.req(`/api/files/${trashedFile.id}`, { method: 'DELETE' })

  const cases = {
    unknown: randomBytes(16).toString('hex'),
    malformed: 'not%20a%20token',
    revoked: tokenOf(revoked),
    trashed: tokenOf(trashed),
  }

  // ⚠️ The CSP nonce is generated per response BY DESIGN, so it is normalised
  //    out of the body comparison. Normalising alone would let a FIXED nonce
  //    pass, so the actual values are captured and checked for distinctness
  //    below — the normalisation must never become the thing that hides a
  //    regression in nonce generation.
  const normalise = (html) => html.replace(/nonce="[^"]*"/g, 'nonce="<per-response>"')

  const nonces = []
  const seen = {}
  for (const [label, token] of Object.entries(cases)) {
    const res = await recipient(gatewayBaseUrl, '203.0.113.11').raw(`/s/${token}`)
    const body = res.buffer.toString('utf8')
    seen[label] = {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: normalise(body),
    }
    // Capture the real value, not merely its presence.
    const nonceMatch = body.match(/nonce="([^"]+)"/)
    assert.ok(nonceMatch, `${label} must carry a CSP nonce`)
    assert.match(nonceMatch[1], /^[A-Za-z0-9+/=]{16,}$/, `${label} nonce must be a non-trivial base64 value`)
    nonces.push(nonceMatch[1])
    // No metadata may leak through the refusal.
    assert.equal(body.includes(secretName), false, `${label} leaked the file name`)
    assert.equal(body.toLowerCase().includes(DEMO_USER.username), false, `${label} leaked the owner`)
    assert.equal(body.includes(STORAGE_ROOT), false, `${label} leaked a storage path`)
    assert.equal(body.includes(FILE_BODY), false, `${label} leaked file bytes`)
    assert.equal(body.includes(token), false, `${label} echoed the token back`)
  }

  // Each of these four refusals was generated by its own request, so every
  // nonce must be fresh. This is a distinctness check over the responses the
  // test actually exercised — it is not a claim about entropy quality.
  assert.equal(nonces.length, Object.keys(cases).length)
  assert.equal(
    new Set(nonces).size,
    nonces.length,
    `every refusal must carry its own freshly generated CSP nonce, got ${JSON.stringify(nonces)}`,
  )

  // One template, one status, one body — for every reason.
  const reference = seen.unknown
  assert.equal(reference.status, 404)
  for (const [label, got] of Object.entries(seen)) {
    assert.equal(got.status, reference.status, `${label} status differs`)
    assert.equal(got.contentType, reference.contentType, `${label} content-type differs`)
    assert.equal(got.body, reference.body, `${label} body differs from the unknown-token refusal`)
  }
})

test('PS5-T02-2 the audit still records WHY, even though the recipient cannot see it', async () => {
  // Indistinguishability is a RECIPIENT-facing property. The forensic record is
  // deliberately more specific, and this suite must not flatten that.
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, { scope: 'public' })
  await owner.req(`/api/shares/${created.data.share.id}`, { method: 'DELETE' })

  await recipient(gatewayBaseUrl, '203.0.113.12').raw(`/s/${tokenOf(created)}`)
  await recipient(gatewayBaseUrl, '203.0.113.12').raw(`/s/${randomBytes(16).toString('hex')}`)

  const rows = await readAudit(30)
  const actions = rows.map((r) => r.action)
  assert.ok(actions.includes('SHARE_REDEEM_REVOKED'), 'a revoked link must be distinguishable in the audit')
  assert.ok(actions.includes('SHARE_REDEEM'), 'an unknown token must still be audited')
})

/* ══════════════════════════════════════════════════════════════════════════
   §6 · PS5-T06 — the raw token exists exactly once, in the creation response
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-T06-1 the raw token is returned once and never appears anywhere else', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'ps5-token-secrecy-pw',
  })
  assert.equal(created.status, 201)
  const token = tokenOf(created)
  assert.ok(token.length >= 16, 'a share token must not be trivially short')

  // Redeem, deny, and guess so every logging path has been exercised.
  await recipient(gatewayBaseUrl, '203.0.113.13').raw(`/s/${token}`)
  await recipient(gatewayBaseUrl, '203.0.113.13').raw(`/s/${token}nope`)

  // 1. the listing never carries it
  const list = await owner.req('/api/shares')
  assert.equal(JSON.stringify(list.data).includes(token), false, 'the raw token leaked into GET /api/shares')

  // 2. the audit never carries it
  assert.equal((await auditText()).includes(token.toLowerCase()), false, 'the raw token leaked into the audit')

  // 3. persistence stores only a hash
  if (usingPostgres) {
    const { rows } = await query('SELECT token_hash FROM shares WHERE id = $1', [created.data.share.id])
    assert.equal(rows.length, 1)
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/, 'only a sha256 hex digest may be stored')
    assert.notEqual(rows[0].token_hash, token)
    const all = await query('SELECT * FROM shares')
    assert.equal(JSON.stringify(all.rows).includes(token), false, 'the raw token is present in the shares table')
  }
  // The token is not recoverable through any owner-facing route either.
  const detail = await owner.req(`/api/shares`)
  assert.equal(detail.data.shares.some((s) => JSON.stringify(s).includes(token)), false)
})

/* ══════════════════════════════════════════════════════════════════════════
   §7 · PS5-T07 — the link password is never readable after creation
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-T07-1 the plaintext link password is never stored, returned, or audited', async () => {
  const sentinel = `ps5-pw-${randomBytes(6).toString('hex')}`
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: sentinel,
  })
  assert.equal(created.status, 201)
  const token = tokenOf(created)

  // The creation response itself must not echo it back.
  assert.equal(JSON.stringify(created.data).includes(sentinel), false, 'the creation response echoed the password')
  assert.equal(created.data.share.hasPassword, true, 'the protected state is reported as a boolean only')

  // Exercise the password path: one wrong, one right.
  const client = recipient(gatewayBaseUrl, '203.0.113.14')
  const wrong = await client.rawPost(`/s/${token}`, `password=${encodeURIComponent(sentinel)}-wrong`)
  assert.equal(wrong.status, 401)
  const right = await client.rawPost(`/s/${token}`, `password=${encodeURIComponent(sentinel)}`)
  assert.equal(right.status, 200)

  // Neither page may echo the submitted secret back to the browser.
  assert.equal(wrong.buffer.toString('utf8').includes(sentinel), false, 'the failed form echoed the password')
  assert.equal(right.buffer.toString('utf8').includes(sentinel), false, 'the success response echoed the password')

  // Not in the listing, not in the audit.
  const list = await owner.req('/api/shares')
  assert.equal(JSON.stringify(list.data).includes(sentinel), false, 'the password leaked into GET /api/shares')
  assert.equal((await auditText()).includes(sentinel.toLowerCase()), false, 'the password leaked into the audit')

  if (usingPostgres) {
    const { rows } = await query('SELECT password_hash FROM shares WHERE id = $1', [created.data.share.id])
    assert.equal(rows.length, 1)
    assert.match(rows[0].password_hash, /^\$2[aby]\$/, 'the link password must be stored as a bcrypt hash')
    assert.equal(rows[0].password_hash.includes(sentinel), false)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
   §8 · PS5-T04 — password correctness and server-side lockout
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-T04-1 a wrong password is denied, the right one succeeds, and guessing locks out', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'ps5-correct-horse-battery',
  })
  const token = tokenOf(created)
  const client = recipient(gatewayBaseUrl, '203.0.113.15')

  // A bare GET offers the form and never the bytes.
  const form = await client.raw(`/s/${token}`)
  assert.equal(form.status, 200)
  assert.equal(form.buffer.toString('utf8').includes(FILE_BODY), false, 'a form must not carry the file')

  assert.equal((await client.rawPost(`/s/${token}`, 'password=wrong-one')).status, 401)
  const ok = await client.rawPost(`/s/${token}`, 'password=ps5-correct-horse-battery')
  assert.equal(ok.status, 200)
  assert.equal(ok.buffer.toString('utf8'), FILE_BODY)

  // Sustained guessing must be stopped server-side, on the accepted threshold
  // (rateLimit.js MAX_ATTEMPTS = 5). This asserts the observed behaviour; it
  // does not introduce a new policy.
  const guesser = recipient(gatewayBaseUrl, '203.0.113.16')
  let locked = null
  for (let attempt = 0; attempt < 8 && !locked; attempt += 1) {
    const res = await guesser.rawPost(`/s/${token}`, `password=guess-${attempt}`)
    if (res.status === 429) locked = res
  }
  assert.ok(locked, 'repeated wrong passwords must eventually lock out')
  assert.ok(Number(locked.headers.get('retry-after')) > 0, 'a lockout must tell the caller when to retry')
  assert.equal(locked.buffer.toString('utf8').includes(FILE_BODY), false, 'a lockout must never carry the file')
})

/* ══════════════════════════════════════════════════════════════════════════
   §9 · PS5-T05 — the limiter namespaces cannot poison each other
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-T05-1 a public lockout leaves the private path and login working', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'ps5-namespace-pw',
  })
  const token = tokenOf(created)
  const ip = '203.0.113.21'

  // Lock the PUBLIC namespace for this address.
  let locked = false
  for (let i = 0; i < 8 && !locked; i += 1) {
    locked = (await recipient(gatewayBaseUrl, ip).rawPost(`/s/${token}`, `password=bad-${i}`)).status === 429
  }
  assert.ok(locked, 'the public namespace must lock')

  // The SAME address, the SAME link, on the private path is a different
  // namespace and must still be able to try.
  const viaPrivate = await recipient(privateBaseUrl, ip).rawPost(`/s/${token}`, 'password=ps5-namespace-pw')
  assert.notEqual(viaPrivate.status, 429, 'a public lockout must not lock the private path')
  assert.equal(viaPrivate.status, 200, 'the correct password must still work privately')

  // And signing in is a third namespace.
  const login = await new Client(privateBaseUrl).req('/api/login', {
    method: 'POST',
    body: { username: DEMO_USER.username, password: DEMO_USER.password },
    headers: { 'X-Test-Client-IP': ip },
  })
  assert.notEqual(login.status, 429, 'a share lockout must never lock signing in')
})

test('PS5-T05-2 private and login failures do not consume the public namespace', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'ps5-inverse-pw',
  })
  const token = tokenOf(created)
  const ip = '203.0.113.22'

  // Burn the PRIVATE share namespace and the LOGIN namespace for this address.
  for (let i = 0; i < 8; i += 1) {
    await recipient(privateBaseUrl, ip).rawPost(`/s/${token}`, `password=bad-private-${i}`)
  }
  // ⚠️ A throwaway username on purpose. recordFailure() bumps BOTH the per-IP
  //    and the per-ACCOUNT axis, and the account axis is global — burning the
  //    shared demo account here would lock every later test out of logging in.
  //    The axis this test actually needs burnt is `login|<ip>`, which a
  //    non-existent username reaches just as well.
  const throwawayUser = `ps5-login-burn-${randomBytes(4).toString('hex')}`
  for (let i = 0; i < 8; i += 1) {
    await new Client(privateBaseUrl).req('/api/login', {
      method: 'POST',
      body: { username: throwawayUser, password: `bad-login-${i}` },
      headers: { 'X-Test-Client-IP': ip },
    })
  }

  // The public path for the same address and the same link must be untouched.
  const viaPublic = await recipient(gatewayBaseUrl, ip).rawPost(`/s/${token}`, 'password=ps5-inverse-pw')
  assert.notEqual(viaPublic.status, 429, 'private/login failures must not lock the public namespace')
  assert.equal(viaPublic.status, 200, 'the correct password must still work publicly')
})

/* ══════════════════════════════════════════════════════════════════════════
   §10 · PS5-T27 — forged headers cannot move the limiter identity
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-T27-1 an untrusted peer cannot rotate its limiter identity with forged headers', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'any', authType: 'password', password: 'ps5-forge-pw',
  })
  const token = tokenOf(created)

  // 127.0.0.4 is NOT a trusted proxy, so whatever it forwards is ignored and the
  // peer itself is the client identity. Rotating the forged header must not buy
  // a fresh quota.
  const untrusted = new Client(untrustedBaseUrl)
  let locked = false
  for (let i = 0; i < 10 && !locked; i += 1) {
    const res = await untrusted.raw(`/s/${token}`, {
      method: 'POST',
      body: `password=forge-${i}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // A different fabricated client on every attempt.
        'X-Forwarded-For': `198.51.100.${i + 10}`,
        'X-Real-IP': `198.51.100.${i + 10}`,
        Forwarded: `for=198.51.100.${i + 10}`,
      },
    })
    if (res.status === 429) locked = true
  }
  assert.ok(locked, 'forged forwarding headers must not grant an unlimited guessing budget')
})

/* ══════════════════════════════════════════════════════════════════════════
   §12–§15 · lifecycle: Vault, ownership, trash, expiry, revoke, hit counter
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-VAULT-1 a Vault file cannot be shared, and a forged Vault row is still not redeemable', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  // Creation-side control (also pinned by PS2-GUARD-1; kept here because the
  // redemption half below is meaningless without it).
  if (usingPostgres) {
    await query('UPDATE files SET vault = TRUE WHERE id = $1', [file.id])
    const refused = await createShare(owner, file.id, { scope: 'public' })
    assert.equal(refused.status, 400, 'a Vault file must not be shareable')
    await query('UPDATE files SET vault = FALSE WHERE id = $1', [file.id])
  }

  const created = await createShare(owner, file.id, { scope: 'public' })
  assert.equal(created.status, 201)
  const token = tokenOf(created)
  assert.equal((await recipient(gatewayBaseUrl, '203.0.113.31').raw(`/s/${token}`)).status, 200)

  if (!canForgeRows) {
    // Honest gap rather than a silent memory-mode substitution.
    console.log('[PS5] Vault redemption defence-in-depth needs row access; PostgreSQL not in use')
    return
  }
  // Defence in depth: the file becomes Vault-backed AFTER the share exists, so
  // the creation gate is bypassed. Redemption must still refuse — the server
  // holds only undecryptable ciphertext and must not ship it.
  await query('UPDATE files SET vault = TRUE WHERE id = $1', [file.id])
  const res = await recipient(gatewayBaseUrl, '203.0.113.31').raw(`/s/${token}`)
  assert.equal(res.status, 404, 'a Vault-backed share must not be redeemable')
  assert.equal(res.buffer.toString('utf8').includes(FILE_BODY), false, 'no ciphertext or bytes may be delivered')
  await query('UPDATE files SET vault = FALSE WHERE id = $1', [file.id])
})

test('PS5-OWN-1 only the owner may revoke, and a foreign target is hidden rather than refused', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(directBaseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, { scope: 'public' })
  const token = tokenOf(created)
  const shareId = created.data.share.id

  // Admin is not an exception to share ownership.
  const byAdmin = await admin.req(`/api/shares/${shareId}`, { method: 'DELETE' })
  assert.equal(byAdmin.status, 404, 'a non-owner must get the object-hiding response')
  assert.deepEqual(byAdmin.data, { error: 'Not found' }, 'the refusal must not describe the target')
  assert.equal(JSON.stringify(byAdmin.data).includes(FILE_NAME), false, 'no file metadata may leak')

  // The link is genuinely still alive — the refusal was real, not cosmetic.
  assert.equal((await recipient(gatewayBaseUrl, '203.0.113.32').raw(`/s/${token}`)).status, 200)

  // A non-owner cannot see it in their own listing either.
  const adminList = await admin.req('/api/shares')
  assert.equal(
    adminList.data.shares.some((s) => String(s.id) === String(shareId)),
    false,
    'another account must not see this share',
  )

  // The owner can.
  assert.equal((await owner.req(`/api/shares/${shareId}`, { method: 'DELETE' })).status, 200)
  assert.equal((await recipient(gatewayBaseUrl, '203.0.113.32').raw(`/s/${token}`)).status, 404)
})

test('PS5-TRASH-1 trashing the file makes its live links unredeemable without counting a hit', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, { scope: 'public' })
  const token = tokenOf(created)

  assert.equal((await recipient(gatewayBaseUrl, '203.0.113.33').raw(`/s/${token}`)).status, 200)
  const before = await hitsOf(owner, created.data.share.id)

  assert.equal((await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })).status, 200)

  const res = await recipient(gatewayBaseUrl, '203.0.113.33').raw(`/s/${token}`)
  assert.equal(res.status, 404, 'a trashed file must not be redeemable')
  assert.equal(res.buffer.toString('utf8').includes(FILE_BODY), false, 'no bytes may be delivered')

  const after = await hitsOf(owner, created.data.share.id)
  if (after !== undefined) assert.equal(after, before, 'a refusal must not count as a hit')
})

test('PS5-LIFE-1 a successful redemption counts exactly one hit and a revoked one counts none', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, { scope: 'public' })
  const token = tokenOf(created)
  const shareId = created.data.share.id
  const client = recipient(gatewayBaseUrl, '203.0.113.34')

  assert.equal(await hitsOf(owner, shareId), 0)
  assert.equal((await client.raw(`/s/${token}`)).status, 200)
  assert.equal(await hitsOf(owner, shareId), 1, 'one delivery is one hit')
  assert.equal((await client.raw(`/s/${token}`)).status, 200)
  assert.equal(await hitsOf(owner, shareId), 2, 'the counter follows deliveries exactly')

  await owner.req(`/api/shares/${shareId}`, { method: 'DELETE' })
  assert.equal((await client.raw(`/s/${token}`)).status, 404, 'a revoked link must be dead')
})

test('PS5-LIFE-2 an expired link is refused and delivers nothing', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, { scope: 'public' })
  const token = tokenOf(created)

  assert.equal((await recipient(gatewayBaseUrl, '203.0.113.35').raw(`/s/${token}`)).status, 200)

  if (!canForgeRows) {
    // The shortest offered expiry is 1h, so an honest expiry test needs row
    // access. Not silently substituted with a weaker assertion.
    console.log('[PS5] expiry gate needs row access to age a share; PostgreSQL not in use')
    return
  }
  await query(`UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [created.data.share.id])
  const before = await hitsOf(owner, created.data.share.id)
  const res = await recipient(gatewayBaseUrl, '203.0.113.35').raw(`/s/${token}`)
  assert.equal(res.status, 404, 'an expired link must be refused')
  assert.equal(res.buffer.toString('utf8').includes(FILE_BODY), false, 'no bytes may be delivered')
  assert.equal(await hitsOf(owner, created.data.share.id), before, 'an expired attempt is not a hit')
})

/* ══════════════════════════════════════════════════════════════════════════
   §16 · PS5-HDR — the delivered file keeps its response security headers
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-HDR-1 a successful public delivery carries the accepted security headers', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, { scope: 'public' })

  const res = await recipient(gatewayBaseUrl, '203.0.113.41').raw(`/s/${tokenOf(created)}`)
  assert.equal(res.status, 200)
  assert.equal(res.buffer.toString('utf8'), FILE_BODY)

  assert.equal(res.headers.get('content-type'), 'application/octet-stream')
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  // The uploaded name must never be served as a renderable type.
  assert.equal((res.headers.get('content-type') ?? '').includes('html'), false)
})

test('PS5-HDR-2 the refusal and password pages stay non-indexable and non-cacheable', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'ps5-header-pw',
  })

  const pages = [
    await recipient(gatewayBaseUrl, '203.0.113.42').raw(`/s/${randomBytes(16).toString('hex')}`), // unavailable
    await recipient(gatewayBaseUrl, '203.0.113.42').raw(`/s/${tokenOf(created)}`),                // password form
  ]
  for (const res of pages) {
    const body = res.buffer.toString('utf8')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.match(body, /<meta name="robots" content="noindex,nofollow">/)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
   §23 · PS5-AUD — the audit records the recipient, and never the secrets
   ══════════════════════════════════════════════════════════════════════════ */

test('PS5-AUD-1 a public redemption is attributed to the recipient, not the gateway peer', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const sentinelPw = `ps5-aud-${randomBytes(5).toString('hex')}`
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: sentinelPw,
  })
  const token = tokenOf(created)
  const RECIPIENT_IP = '203.0.113.77'

  const ok = await recipient(gatewayBaseUrl, RECIPIENT_IP)
    .rawPost(`/s/${token}`, `password=${encodeURIComponent(sentinelPw)}`)
  assert.equal(ok.status, 200)

  const rows = await readAudit(30)
  // ⚠️ readAudit() returns snake_case from PostgreSQL and camelCase from memory.
  const sourceOf = (row) => row.source_ip ?? row.sourceIp
  const event = rows.find((row) => row.action === 'SHARE_REDEEM' && row.result === 'OK')
  assert.ok(event, 'a successful public redemption must be audited')

  // G3: the canonical RECIPIENT address is retained for attribution...
  assert.equal(sourceOf(event), RECIPIENT_IP, 'the audit must record the recipient, not the ingress peer')
  // ...and the gateway peer must never be substituted for it.
  assert.notEqual(sourceOf(event), '127.0.0.3', 'the gateway peer must never stand in for the recipient')

  // Absence: no raw token, no plaintext password, no public URL carrying either.
  const blob = await auditText(40)
  assert.equal(blob.includes(token.toLowerCase()), false, 'the raw token leaked into the audit')
  assert.equal(blob.includes(sentinelPw.toLowerCase()), false, 'the password leaked into the audit')
  assert.equal(blob.includes('share.example.invalid'), false, 'the public URL leaked into the audit')
})

console.log(`[public share security regression] database mode: ${DB_MODE}`)
