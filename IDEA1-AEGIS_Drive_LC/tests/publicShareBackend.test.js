// tests/publicShareBackend.test.js — AEGIS Drive (IDEA1) · PUBLIC-SHARE-2
//
// The backend contract for `scope=public`, exercised through the same Express
// app production runs. Nothing here creates a gateway, opens a port, or exposes
// anything: the "public gateway" below is a second local TCP hop that models the
// peer a future gateway would be.
//
// What this suite exists to pin:
//   A. `public` is a third explicit scope, gated on PUBLIC_SHARE_BASE_URL.
//   B. publicUrl comes from configuration and a request Host cannot change it.
//   C. Ingress provenance (socket peer) and client identity (req.ip) are two
//      DIFFERENT values on the same request, and the scope rule uses the first.
//   D. A direct caller cannot forge public-gateway provenance with headers.
//   E. `zones`/`any` are refused through the public ingress without leaking
//      bytes, hits, or which scope the link carries.
//   F. The public and private rate-limit namespaces cannot lock each other.
//
// ⚠️ 127.0.0.2 models the HUB/private edge and 127.0.0.3 the public gateway.
//    Both are trusted proxies; only 127.0.0.3 is the configured gateway
//    identity. That difference is the entire point of the split under test.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { Client, loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-public-share-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
// Both edges are trusted; only the second is the pinned public-gateway identity.
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

const FILE_BODY = 'Public share backend contract fixture. 41 bytes of body text.'
const FILE_NAME = 'publicsharetest-contract.txt'
const CONFIGURED_ORIGIN = 'https://share.example.invalid'

let driveServer, noPublicServer, privateProxy, gatewayProxy, bareGatewayProxy
let directBaseUrl, noPublicBaseUrl, privateBaseUrl, gatewayBaseUrl, bareGatewayBaseUrl

/**
 * A local TCP hop that models a trusted edge.
 *
 * @param {string} localAddress which loopback alias it connects FROM — this is
 *        the socket peer Drive sees, and therefore the ingress identity.
 * @param {{ sanitize?: boolean }} [opts] sanitize:false forwards the client's
 *        own headers untouched, modelling an edge that forgot to overwrite them.
 */
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

  // A second app with the SAME code and no configured public origin — the state
  // production runs in today.
  noPublicServer = createApp({ env: { ...process.env, PUBLIC_SHARE_BASE_URL: '' } })
    .listen(0, '127.0.0.1')
  await new Promise((r) => noPublicServer.once('listening', r))
  noPublicBaseUrl = `http://127.0.0.1:${noPublicServer.address().port}`

  privateProxy = edgeProxy('127.0.0.2')
  gatewayProxy = edgeProxy('127.0.0.3')
  // The gateway peer with no forwarding header at all: req.ip then falls back to
  // the peer address, while ingress must still resolve to the gateway.
  bareGatewayProxy = edgeProxy('127.0.0.3', { sanitize: false })
  privateBaseUrl = await listen(privateProxy)
  gatewayBaseUrl = await listen(gatewayProxy)
  bareGatewayBaseUrl = await listen(bareGatewayProxy)
})

after(async () => {
  for (const server of [privateProxy, gatewayProxy, bareGatewayProxy, noPublicServer, driveServer]) {
    await new Promise((r) => server.close(r))
  }
  if (usingPostgres) {
    await query('DELETE FROM shares')
    await query(`DELETE FROM files WHERE name LIKE 'publicsharetest-%'`)
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
    rawPost: (pathname, body) => c.raw(pathname, {
      method: 'POST',
      body,
      headers: withIp({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    }),
  }
}

const hitsOf = async (client, shareId) => {
  const res = await client.req('/api/shares')
  return res.data.shares.find((s) => String(s.id) === String(shareId))?.hits
}

// ═══ A. scope=public as a gated third scope ═══════════════════════════════════

test('PS2-SCOPE-1 public is rejected when no public origin is configured', async () => {
  const owner = await loginClient(noPublicBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  const res = await createShare(owner, file.id, { scope: 'public' })
  // The existing generic rejection — a caller learns its input was refused, not
  // anything about server configuration.
  assert.equal(res.status, 400)
  assert.deepEqual(res.data, { error: 'Invalid input' })

  // The same app still creates the two private scopes normally.
  for (const scope of ['any', 'zones']) {
    const created = await createShare(owner, file.id, { scope })
    assert.ok([201, 400].includes(created.status), `${scope} must not error`)
    if (created.status === 201) assert.equal(created.data.share.scope, scope)
  }
})

test('PS2-SCOPE-2 public is created when a public origin is configured', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  const res = await createShare(owner, file.id, { scope: 'public' })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  assert.equal(res.data.share.scope, 'public')
  // A public share carries no Share-layer CIDR restriction, exactly like `any`.
  assert.deepEqual(res.data.share.scopeCidrs, [])
})

test('PS2-SCOPE-3 any and zones semantics are unchanged', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(directBaseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await uploadFile(owner)

  const any = await createShare(owner, file.id, { scope: 'any' })
  assert.equal(any.status, 201)
  assert.equal(any.data.share.scope, 'any')
  assert.deepEqual(any.data.share.scopeCidrs, [])
  assert.equal(any.data.publicUrl, undefined, 'any must not gain a public URL')

  // zones still snapshots administrator CIDRs at creation time.
  const zone = await admin.req('/api/zones', {
    method: 'POST', body: { name: 'publicsharetest-zone', cidr: '198.51.100.0/24' },
  })
  if (zone.status === 201) {
    const zones = await createShare(owner, file.id, { scope: 'zones' })
    assert.equal(zones.status, 201)
    assert.equal(zones.data.share.scope, 'zones')
    assert.deepEqual(zones.data.share.scopeCidrs, ['198.51.100.0/24'])
    assert.equal(zones.data.publicUrl, undefined, 'zones must not gain a public URL')
    await admin.req(`/api/zones/${zone.data.zone.id}`, { method: 'DELETE' })
  }
})

test('PS2-SCOPE-4 an unknown scope is still rejected', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  for (const scope of ['internet', 'public-internet', 'vlan', 'subnet', '', null]) {
    const res = await createShare(owner, file.id, { scope })
    assert.equal(res.status, 400, `scope=${JSON.stringify(scope)} must be rejected`)
  }
})

test('PS2-SCOPE-5 public is never a saved default', async () => {
  const [schema, migration009] = await Promise.all([
    fs.readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/db/migrations/009_public_share_scope.sql', import.meta.url), 'utf8'),
  ])
  // The share row may be 'public'; the stored per-user preference may not.
  assert.match(schema, /share_default_scope[\s\S]{0,120}CHECK \(share_default_scope IN \('any', 'zones'\)\)/)
  // Comments are allowed to explain what the migration deliberately does not do;
  // the executable statements must not touch the preference column at all.
  const sql009 = migration009.replace(/^\s*--.*$/gm, '')
  assert.doesNotMatch(sql009, /share_default_scope/)
  assert.doesNotMatch(sql009, /(DROP TABLE|TRUNCATE|DELETE FROM|UPDATE)/i)

  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const res = await owner.req('/api/security/settings', {
    method: 'PATCH', body: { shareDefaults: { expiry: '24h', scope: 'public', requirePassword: true } },
  })
  assert.equal(res.status, 400, 'a public default must not be storable')
})

// ═══ B. publicUrl comes from configuration only ═══════════════════════════════

test('PS2-URL-1 publicUrl is the configured origin plus the server-created path', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  const res = await createShare(owner, file.id, { scope: 'public' })
  assert.equal(res.status, 201)
  assert.match(res.data.path, /^\/s\/[A-Za-z0-9_-]+$/)
  assert.equal(res.data.publicUrl, `${CONFIGURED_ORIGIN}${res.data.path}`)
  assert.ok(res.data.publicUrl.startsWith(`${CONFIGURED_ORIGIN}/s/`))
})

test('PS2-URL-2 a poisoned Host header cannot change publicUrl', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  // node:http rather than fetch — undici will not let a caller set Host, and the
  // header under test is exactly the one an attacker would set.
  const body = JSON.stringify({
    fileId: file.id, expiry: '24h', authType: 'none', scope: 'public',
  })
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: driveServer.address().port,
      method: 'POST',
      path: '/api/shares',
      headers: {
        Host: 'evil.attacker.invalid',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Cookie: owner.cookie,
        'X-CSRF-Token': owner.csrf,
        'X-Forwarded-Host': 'evil.attacker.invalid',
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(body)
  })

  assert.equal(response.status, 201, response.text)
  const created = JSON.parse(response.text)
  assert.equal(created.publicUrl, `${CONFIGURED_ORIGIN}${created.path}`)
  assert.ok(!response.text.includes('evil.attacker.invalid'), 'no attacker host may reach the response')
})

test('PS2-URL-3 the raw token is never persisted, only its hash', async (t) => {
  if (!usingPostgres) {
    t.skip('needs Postgres to read the stored row')
    return
  }
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const res = await createShare(owner, file.id, { scope: 'public' })
  const token = res.data.path.split('/').pop()

  const { rows } = await query('SELECT token_hash FROM shares WHERE id = $1', [res.data.share.id])
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0].token_hash, token)
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/)

  const audit = await readAudit(20)
  const serialized = JSON.stringify(audit)
  assert.ok(!serialized.includes(token), 'audit must never carry the raw token')
  assert.ok(!serialized.includes(CONFIGURED_ORIGIN), 'audit must not carry the public URL')
})

// ═══ C. Vault and ownership are unchanged by the new scope ════════════════════

test('PS2-GUARD-1 a Vault file cannot be shared publicly', async (t) => {
  if (!usingPostgres) {
    t.skip('needs Postgres to set files.vault')
    return
  }
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  await query('UPDATE files SET vault = true WHERE id = $1', [file.id])
  try {
    for (const scope of ['public', 'any', 'zones']) {
      const res = await createShare(owner, file.id, { scope })
      assert.equal(res.status, 400, `vault + ${scope} must be rejected`)
    }
  } finally {
    await query('UPDATE files SET vault = false WHERE id = $1', [file.id])
  }
})

test('PS2-GUARD-2 a public share cannot be minted for another owner file', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const other = await loginClient(directBaseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await uploadFile(owner)

  // Admin is deliberately used here: there is no cross-owner bypass, by role or
  // otherwise, and `public` must not become the exception.
  const res = await createShare(other, file.id, { scope: 'public' })
  assert.equal(res.status, 400, 'cross-owner public creation must be refused')
})

// ═══ D. The identity split ════════════════════════════════════════════════════

test('PS2-INGRESS-1 the gateway peer and the client address are different values', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const share = await createShare(owner, file.id, { scope: 'public' })
  const token = share.data.path.split('/').pop()

  const res = await recipient(gatewayBaseUrl, '203.0.113.50').raw(`/s/${token}`)
  assert.equal(res.status, 200, 'a public share through the public ingress must be delivered')

  // The audit source is the CLIENT, resolved through the trusted-proxy walk —
  // not 127.0.0.3, the gateway peer that carried the request.
  //
  // ⚠️ readAudit() returns snake_case rows from PostgreSQL and camelCase from the
  //    in-memory store, so the accessor must tolerate both — the same shape guard
  //    tests/shareRedemption.test.js already uses. Reading only `sourceIp` made
  //    this assertion silently undefined under PostgreSQL.
  const event = (await readAudit(20)).find((row) => row.action === 'SHARE_REDEEM' && row.result === 'OK')
  const auditSource = event?.source_ip ?? event?.sourceIp
  assert.equal(auditSource, '203.0.113.50')
  assert.notEqual(auditSource, '127.0.0.3')
})

test('PS2-INGRESS-2 the gateway peer is still the ingress when it sends no forwarding header', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const zones = await createShare(owner, file.id, { scope: 'any' })
  const token = zones.data.path.split('/').pop()

  // No X-Forwarded-For at all, so req.ip falls back to the peer address. Ingress
  // must not follow req.ip: this is still the public gateway, so a non-public
  // share must still be refused.
  const res = await recipient(bareGatewayBaseUrl, null).raw(`/s/${token}`)
  assert.equal(res.status, 403, 'ingress must be read from the socket peer, not req.ip')
})

test('PS2-INGRESS-3 forged headers cannot manufacture public-gateway provenance', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const share = await createShare(owner, file.id, { scope: 'any' })
  const token = share.data.path.split('/').pop()

  // A direct caller: socket peer 127.0.0.1, which is neither trusted nor the
  // gateway. Every header an attacker could reach for is set.
  const res = await new Client(directBaseUrl).raw(`/s/${token}`, {
    headers: {
      'X-Forwarded-For': '127.0.0.3',
      'X-Real-IP': '127.0.0.3',
      Forwarded: 'for=127.0.0.3;by=127.0.0.3',
    },
  })
  // An `any` share is still redeemable, which proves the request was classified
  // PRIVATE — had the headers forged gateway provenance it would be 403.
  assert.equal(res.status, 200, 'forged headers must not make this a public-gateway request')
})

// ═══ E. The public ingress refuses the private scopes ═════════════════════════

for (const scope of ['zones', 'any']) {
  test(`PS2-RULE-1 ${scope} is refused through the public ingress`, async () => {
    const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
    const admin = await loginClient(directBaseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
    const file = await uploadFile(owner)

    let zoneId = null
    if (scope === 'zones') {
      const zone = await admin.req('/api/zones', {
        method: 'POST', body: { name: 'publicsharetest-rule', cidr: '203.0.113.0/24' },
      })
      if (zone.status !== 201) return // zones unavailable in this mode
      zoneId = zone.data.zone.id
    }
    const created = await createShare(owner, file.id, { scope })
    assert.equal(created.status, 201)
    const token = created.data.path.split('/').pop()

    // Same link, same recipient address, two ingresses.
    const viaPrivate = await recipient(privateBaseUrl, '203.0.113.50').raw(`/s/${token}`)
    assert.equal(viaPrivate.status, 200, `${scope} must still work on the private path`)

    const before = await hitsOf(owner, created.data.share.id)
    const viaPublic = await recipient(gatewayBaseUrl, '203.0.113.50').raw(`/s/${token}`)
    assert.equal(viaPublic.status, 403, `${scope} must be refused through the public ingress`)
    assert.ok(!viaPublic.buffer.toString('utf8').includes(FILE_BODY), 'no file bytes may be delivered')
    assert.equal(await hitsOf(owner, created.data.share.id), before, 'a refusal must not count as a hit')

    const blocked = (await readAudit(20))
      .find((row) => row.action === 'SHARE_REDEEM_OUT_OF_SCOPE')
    assert.equal(blocked?.result, 'BLOCKED')

    if (zoneId) await admin.req(`/api/zones/${zoneId}`, { method: 'DELETE' })
  })
}

test('PS2-RULE-2 public continues through the normal redemption gates', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  // Password, expiry, revoke and Vault gates still apply to a public share — the
  // ingress rule is an extra gate, never a replacement for the existing ones.
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'public-link-pw-1',
  })
  assert.equal(created.status, 201)
  const token = created.data.path.split('/').pop()
  const client = recipient(gatewayBaseUrl, '203.0.113.60')

  const form = await client.raw(`/s/${token}`)
  assert.equal(form.status, 200)
  assert.ok(form.buffer.toString('utf8').includes('Password required'), 'the password gate still applies')
  assert.ok(!form.buffer.toString('utf8').includes(FILE_BODY))

  const wrong = await client.rawPost(`/s/${token}`, 'password=not-the-password')
  assert.equal(wrong.status, 401)

  const right = await client.rawPost(`/s/${token}`, 'password=public-link-pw-1')
  assert.equal(right.status, 200)
  assert.equal(right.buffer.toString('utf8'), FILE_BODY)
  assert.equal(right.headers.get('content-type'), 'application/octet-stream')
  assert.equal(right.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(right.headers.get('cache-control'), 'no-store')
  assert.match(right.headers.get('content-disposition'), /^attachment;/)

  // And revoke still ends it immediately, through the public ingress too.
  const revoked = await owner.req(`/api/shares/${created.data.share.id}`, { method: 'DELETE' })
  assert.equal(revoked.status, 200)
  const after = await client.raw(`/s/${token}`)
  assert.equal(after.status, 404)
})

test('PS2-RULE-3 a public share is still redeemable on the private path', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, { scope: 'public' })
  const token = created.data.path.split('/').pop()

  // `public` is the strictly more permissive scope, so the internal path is not
  // additionally restricted — the merged architecture contract, §7.4.
  const res = await recipient(privateBaseUrl, '198.51.100.11').raw(`/s/${token}`)
  assert.equal(res.status, 200)
  assert.equal(res.buffer.toString('utf8'), FILE_BODY)
})

// ═══ F. Rate-limit namespace isolation ═══════════════════════════════════════

test('PS2-LIMIT-1 public-path password failures do not lock the private path', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'public-limit-pw-1',
  })
  const token = created.data.path.split('/').pop()

  // One recipient address, burning the whole public quota on the public ingress.
  const attacker = recipient(gatewayBaseUrl, '203.0.113.77')
  let sawLockout = false
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await attacker.rawPost(`/s/${token}`, 'password=wrong-guess')
    if (res.status === 429) { sawLockout = true; break }
  }
  assert.ok(sawLockout, 'the public path must still rate limit')

  // The SAME client address on the private path must be unaffected: a different
  // namespace, so the counters cannot reach across.
  const viaPrivate = await recipient(privateBaseUrl, '203.0.113.77')
    .rawPost(`/s/${token}`, 'password=public-limit-pw-1')
  assert.equal(viaPrivate.status, 200, 'a public lockout must not lock private redemption')
  assert.equal(viaPrivate.buffer.toString('utf8'), FILE_BODY)
})

test('PS2-LIMIT-2 share lockouts never reach the login page', async () => {
  const owner = await loginClient(directBaseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const created = await createShare(owner, file.id, {
    scope: 'public', authType: 'password', password: 'public-limit-pw-2',
  })
  const token = created.data.path.split('/').pop()

  const client = recipient(gatewayBaseUrl, '203.0.113.88')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await client.rawPost(`/s/${token}`, 'password=wrong-guess')
  }

  // Login is a third namespace and must be untouched by either share path.
  const login = await new Client(gatewayBaseUrl).req('/api/login', {
    method: 'POST',
    body: { username: DEMO_USER.username, password: 'definitely-not-the-password' },
    headers: { 'X-Test-Client-IP': '203.0.113.88' },
  })
  assert.notEqual(login.status, 429, 'a share lockout must never lock signing in')
})

console.log(`[public share backend tests] database mode: ${DB_MODE}`)
