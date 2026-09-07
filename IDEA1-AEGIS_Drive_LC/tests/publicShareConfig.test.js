// tests/publicShareConfig.test.js — AEGIS Drive (IDEA1) · PUBLIC-SHARE-2
//
// The configuration contract and the migration-009 DDL contract, without a
// server. Everything here is about failing closed at boot rather than coercing a
// half-configured deployment into running.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
process.env.SESSION_SECRET = 'public-share-config-test-secret'
delete process.env.TRUSTED_PROXY_CIDRS
delete process.env.PUBLIC_SHARE_BASE_URL
delete process.env.PUBLIC_SHARE_GATEWAY_CIDR

const {
  publicShareConfigFromEnv, parsePublicShareBaseUrl, parsePublicShareGatewayCidr, publicShareUrl,
  forbiddenGatewayNetworkFor,
} = await import('../server/config/publicShare.js')
const { requestIngressKind, requestIngressPeerIp } = await import('../server/request/ingress.js')

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(rootDir, 'server/db/migrations')
const MIGRATION_009 = '009_public_share_scope.sql'

// ═══ Base URL ════════════════════════════════════════════════════════════════

test('PS2-CFG-1 an absent base URL disables public share creation', () => {
  for (const value of [undefined, '', '   ']) {
    const config = publicShareConfigFromEnv({ PUBLIC_SHARE_BASE_URL: value })
    assert.equal(config.baseUrl, null)
    assert.equal(config.publicShareEnabled, false)
  }
})

test('PS2-CFG-2 a valid base URL is normalised once, with no trailing slash', () => {
  assert.equal(parsePublicShareBaseUrl('https://share.example.invalid'), 'https://share.example.invalid')
  assert.equal(parsePublicShareBaseUrl('  https://share.example.invalid  '), 'https://share.example.invalid')
  // A non-default port is part of the origin and is preserved; :443 is not.
  assert.equal(parsePublicShareBaseUrl('https://share.example.invalid:8443'), 'https://share.example.invalid:8443')
  assert.equal(parsePublicShareBaseUrl('https://share.example.invalid:443'), 'https://share.example.invalid')
})

test('PS2-CFG-2b a trailing slash is rejected, not silently trimmed', () => {
  // The merged G1 contract says the configured origin carries no trailing slash.
  // An earlier draft of PUBLIC-SHARE-2 accepted one and normalised it away, which
  // would have quietly widened an already accepted contract; PR #99 review caught
  // it. Rejecting also keeps the configured text and the emitted URL identical.
  for (const value of [
    'https://share.example.invalid/',
    '  https://share.example.invalid/  ',
    'https://share.example.invalid:8443/',
  ]) {
    assert.throws(() => parsePublicShareBaseUrl(value), /trailing slash/i, value)
  }
})

test('PS2-CFG-3 a malformed base URL fails closed instead of being coerced', () => {
  const rejected = [
    ['http://share.example.invalid', /https/i],                 // the token is in the path
    ['ftp://share.example.invalid', /https/i],
    ['//share.example.invalid', /https/i],
    ['share.example.invalid', /https/i],
    ['https://user:pw@share.example.invalid', /credential/i],   // published to every recipient
    ['https://share.example.invalid/base', /path/i],            // not the allowlisted /s route
    ['https://share.example.invalid/?a=1', /query/i],
    ['https://share.example.invalid/#f', /fragment/i],
    ['https://', /https|host/i],
  ]
  for (const [value, pattern] of rejected) {
    assert.throws(() => parsePublicShareBaseUrl(value), pattern, value)
  }
})

test('PS2-CFG-4 the public URL is composed from configuration plus the server path', () => {
  const config = publicShareConfigFromEnv({ PUBLIC_SHARE_BASE_URL: 'https://share.example.invalid' })
  assert.equal(
    publicShareUrl(config.baseUrl, '/s/abc-token_123'),
    'https://share.example.invalid/s/abc-token_123',
  )
  // No origin configured ⇒ no URL can be composed at all.
  assert.equal(publicShareUrl(null, '/s/abc'), null)
})

// ═══ Gateway identity ════════════════════════════════════════════════════════

test('PS2-CFG-5 an absent gateway identity means legacy/private mode', () => {
  const config = publicShareConfigFromEnv({})
  assert.equal(config.gatewayCidr, null)
  assert.equal(config.gatewayAddress, null)
  assert.equal(config.publicIngressConfigured, false)
})

test('PS2-CFG-6 the gateway identity must be exactly one IPv4 host CIDR', () => {
  assert.equal(parsePublicShareGatewayCidr('172.19.254.2/32'), '172.19.254.2/32')
  assert.equal(
    publicShareConfigFromEnv({ PUBLIC_SHARE_GATEWAY_CIDR: '172.19.254.2/32' }).gatewayAddress,
    '172.19.254.2',
  )

  const rejected = [
    '172.19.254.2',            // a bare address is not a pinned identity
    '172.19.254.0/24',         // a range is not an identity
    '172.19.254.2/31',
    '172.19.254.2/33',
    '172.19.254.999/32',
    '172.19.254.2/32,172.19.254.3/32', // exactly one
    '172.18.0.0/16',           // shared aegis_internal bridge
    '172.18.0.1/32',
    'loopback',
    '::1/128',                 // IPv4 host CIDR only
    'not-a-cidr',
  ]
  for (const value of rejected) {
    assert.throws(() => parsePublicShareGatewayCidr(value), /PUBLIC_SHARE_GATEWAY_CIDR/, value)
  }
})

test('PS2-CFG-6b every host inside the shared aegis_internal bridge is refused', () => {
  // PR #99 review: the first implementation compared the configured value against
  // an exact-string list. Because the input is constrained to a single /32, that
  // rejected only `172.18.0.1/32` while every other host on the same bridge —
  // where PostgreSQL and Monitor live — was accepted as a "dedicated" gateway.
  // The rule is about the network, so the check is about the network.
  for (const value of [
    '172.18.0.1/32',
    '172.18.0.2/32',
    '172.18.0.5/32',
    '172.18.1.20/32',
    '172.18.10.20/32',
    '172.18.255.254/32',
  ]) {
    assert.throws(
      () => parsePublicShareGatewayCidr(value),
      /must not be inside .*172\.18\.0\.0\/16/,
      value,
    )
  }

  // The boundaries either side of the /16 are not inside it and must still pass.
  for (const value of ['172.17.255.254/32', '172.19.0.1/32', '172.19.254.2/32']) {
    assert.equal(parsePublicShareGatewayCidr(value), value)
  }

  assert.equal(forbiddenGatewayNetworkFor('172.18.7.7')?.cidr, '172.18.0.0/16')
  assert.equal(forbiddenGatewayNetworkFor('172.19.254.2'), null)
})

// ═══ Ingress provenance, as a unit ═══════════════════════════════════════════

/** A minimal request double: only what the helper is allowed to read. */
const fakeReq = ({ peer, config, headers = {} }) => ({
  socket: { remoteAddress: peer },
  headers,
  app: { get: (key) => (key === 'publicShareConfig' ? config : undefined) },
})

test('PS2-CFG-7 without a configured gateway nothing can be public-gateway ingress', () => {
  const config = publicShareConfigFromEnv({})
  for (const peer of ['127.0.0.1', '172.19.254.2', '::ffff:172.19.254.2', undefined]) {
    assert.equal(requestIngressKind(fakeReq({ peer, config })), 'private')
  }
})

test('PS2-CFG-8 ingress follows the socket peer and normalises IPv4-mapped IPv6', () => {
  const config = publicShareConfigFromEnv({ PUBLIC_SHARE_GATEWAY_CIDR: '172.19.254.2/32' })
  assert.equal(requestIngressKind(fakeReq({ peer: '172.19.254.2', config })), 'public-gateway')
  assert.equal(requestIngressKind(fakeReq({ peer: '::ffff:172.19.254.2', config })), 'public-gateway')
  assert.equal(requestIngressPeerIp(fakeReq({ peer: '::ffff:172.19.254.2', config })), '172.19.254.2')
  assert.equal(requestIngressKind(fakeReq({ peer: '172.19.255.2', config })), 'private')
  assert.equal(requestIngressKind(fakeReq({ peer: '172.19.254.3', config })), 'private')
})

test('PS2-CFG-9 no header can produce public-gateway provenance', () => {
  const config = publicShareConfigFromEnv({ PUBLIC_SHARE_GATEWAY_CIDR: '172.19.254.2/32' })
  const headers = {
    'x-forwarded-for': '172.19.254.2',
    'x-real-ip': '172.19.254.2',
    forwarded: 'for=172.19.254.2;by=172.19.254.2',
    host: '172.19.254.2',
  }
  assert.equal(requestIngressKind(fakeReq({ peer: '198.51.100.9', config, headers })), 'private')
})

test('PS2-CFG-10 an unreadable peer is never treated as private', () => {
  const config = publicShareConfigFromEnv({ PUBLIC_SHARE_GATEWAY_CIDR: '172.19.254.2/32' })
  // Not evidence of the gateway either — but the scope rule is written as
  // "private only", so absence of evidence must fail toward denial.
  assert.equal(requestIngressKind(fakeReq({ peer: undefined, config })), 'unknown')
  assert.equal(requestIngressKind(fakeReq({ peer: '', config })), 'unknown')
})

test('PS2-CFG-11 requestSourceIp is untouched and is a different accessor', async () => {
  const source = await readFile(path.join(rootDir, 'server/request/sourceIp.js'), 'utf8')
  // The client-identity accessor still reads req.ip and nothing else. If this
  // ever starts reading the socket peer, the two identities have been merged
  // again and the PR #97 review correction has been undone.
  assert.match(source, /return typeof req\.ip === 'string' && req\.ip \? req\.ip : 'unknown'/)
  assert.doesNotMatch(source, /remoteAddress/)

  const ingress = await readFile(path.join(rootDir, 'server/request/ingress.js'), 'utf8')
  assert.match(ingress, /req\?\.socket\?\.remoteAddress/)
  // Ingress must never consult a forwarding header or req.ip. Comments in that
  // module discuss both at length, so the scan runs on the code only.
  const executable = ingress.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
  for (const banned of ['x-forwarded-for', 'x-real-ip', 'req.ip']) {
    assert.ok(!executable.toLowerCase().includes(banned), `ingress must not read ${banned}`)
  }
})

// ═══ Migration 009 DDL contract ══════════════════════════════════════════════

test('PS2-MIG-1 migration 009 exists and is the next in sequence', async () => {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  assert.ok(files.includes(MIGRATION_009), 'migration 009 must exist')
  assert.equal(files.at(-1), MIGRATION_009, '009 must be the newest migration')
  // No number is reused.
  const numbers = files.map((name) => name.slice(0, 3))
  assert.equal(new Set(numbers).size, numbers.length)
})

test('PS2-MIG-2 migration 009 only widens the scope CHECK, transactionally', async () => {
  const sql = await readFile(path.join(migrationsDir, MIGRATION_009), 'utf8')
  const executable = sql.replace(/^\s*--.*$/gm, '')

  assert.match(executable, /BEGIN;/)
  assert.match(executable, /COMMIT;/)
  // The end state matches schema.sql exactly, legacy values preserved.
  assert.match(
    executable,
    /ADD CONSTRAINT shares_scope_check\s+CHECK \(scope IN \('any', 'zones', 'public', 'vlan', 'subnet'\)\)/,
  )
  // The old constraint is found in the catalog, not guessed by name, and only a
  // CHECK constraint can ever be dropped by the lookup.
  assert.match(executable, /con\.contype = 'c'/)
  assert.match(executable, /ALTER TABLE shares DROP CONSTRAINT %I/)
})

test('PS2-MIG-3 migration 009 contains no destructive or unrelated DDL', async () => {
  const sql = await readFile(path.join(migrationsDir, MIGRATION_009), 'utf8')
  const executable = sql.replace(/^\s*--.*$/gm, '')

  for (const banned of [
    /DROP TABLE/i, /TRUNCATE/i, /DELETE FROM/i, /\bUPDATE\b/i, /\bINSERT\b/i,
    /DROP COLUMN/i, /ALTER COLUMN/i, /CREATE TABLE/i, /GRANT/i, /REVOKE/i,
  ]) {
    assert.doesNotMatch(executable, banned, `009 must not contain ${banned}`)
  }
  // It must not touch the per-user preference, the token, or the password hash.
  for (const banned of ['share_default_scope', 'token_hash', 'password_hash']) {
    assert.ok(!executable.includes(banned), `009 must not touch ${banned}`)
  }
  // vlan_scope may appear ONLY in the catalog lookup's exclusion guard, which is
  // what stops the DO block from dropping a constraint that governs that column
  // instead of the one it means to replace.
  const vlanReferences = executable.match(/vlan_scope/g) ?? []
  const guardedReferences = executable.match(/NOT LIKE '%vlan_scope%'/g) ?? []
  assert.equal(
    vlanReferences.length,
    guardedReferences.length,
    'vlan_scope may appear only inside the catalog lookup exclusion guard',
  )
  // shares is the only table named.
  const tables = [...executable.matchAll(/ALTER TABLE (\w+)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(tables)], ['shares'])
})

test('PS2-MIG-4 deployed migrations 001-008 are untouched by this change', async () => {
  // Their content is not asserted here — git is the record of that. What is
  // asserted is that 009 does not reach back into them and that they still exist.
  const files = await readdir(migrationsDir)
  for (const expected of [
    '001_vault_envelope.sql', '002_user_preferences.sql', '003_upload_sessions.sql',
    '004_vault_v2.sql', '005_protected_trash.sql', '006_interface_style.sql',
    '007_security_settings.sql', '008_vault_autolock_1_minute.sql',
  ]) {
    assert.ok(files.includes(expected), `${expected} must still exist`)
  }
})

test('PS2-MIG-5 a fresh schema and a migrated database describe scope identically', async () => {
  const [schema, sql] = await Promise.all([
    readFile(path.join(rootDir, 'server/db/schema.sql'), 'utf8'),
    readFile(path.join(migrationsDir, MIGRATION_009), 'utf8'),
  ])
  const constraint = /CHECK \(scope IN \('any', 'zones', 'public', 'vlan', 'subnet'\)\)/
  assert.match(schema, constraint, 'schema.sql must accept public on a fresh database')
  assert.match(sql, constraint, 'the migration must reach the same end state')
  // Same constraint NAME, so the two paths are indistinguishable afterwards.
  assert.match(schema, /ADD CONSTRAINT shares_scope_check/)
  assert.match(sql, /ADD CONSTRAINT shares_scope_check/)
  // The saved per-user default stays private-only.
  assert.match(schema, /CHECK \(share_default_scope IN \('any', 'zones'\)\)/)
})
