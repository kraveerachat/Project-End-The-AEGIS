// PUBLIC-SHARE-7 S5.5-D Task 4: the authoritative Cloudflare transport allowlist.
//
// These tests are offline and static. They never resolve DNS, never contact
// Cloudflare, and never touch Production. They assert that the reviewed
// point-in-time endpoint snapshot is exact, narrow, and fail-closed, and that
// the verifier rejects unsafe allowlists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const production = fileURLToPath(new URL('../../gateway/public-share/production/', import.meta.url))
const allowlistPath = path.join(production, 'cloudflare-endpoints.json')
const script = path.join(production, 'verify-cloudflare-endpoints.sh')
const shell = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'

const HOST_32 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/
const octetsValid = (cidr) =>
  HOST_32.exec(cidr).slice(1, 5).every((o) => Number(o) >= 0 && Number(o) <= 255 && String(Number(o)) === o)

const allowlist = () => JSON.parse(readFileSync(allowlistPath, 'utf8'))

test('CF-ALLOWLIST-SCHEMA the snapshot is well formed and self-describing', () => {
  const data = allowlist()
  assert.ok(data && typeof data === 'object' && !Array.isArray(data), 'allowlist must be an object')

  // The artifact must not present itself as an eternal Cloudflare IP contract.
  assert.equal(data.snapshotType, 'reviewed-point-in-time-snapshot')
  assert.match(data.snapshotUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'snapshot needs an exact UTC instant')
  assert.ok(typeof data.reviewNote === 'string' && data.reviewNote.length > 0, 'snapshot needs a review note')
  assert.match(data.reviewNote, /re-?verif/i, 'the note must say the snapshot needs re-verification')
})

test('CF-ALLOWLIST-TRANSPORT is TCP/7844 only and excludes UDP and 443', () => {
  const { transport } = allowlist()
  assert.equal(transport.port, 7844, 'the only allowed destination port is 7844')
  assert.deepEqual(transport.protocols, ['tcp'], 'this contract is TCP only; QUIC/UDP is deliberately excluded')
  assert.equal(transport.ipVersion, 'ipv4', 'S5.5 allows IPv4 destinations only')
  assert.equal(transport.protocols.includes('udp'), false, 'UDP/7844 must never be allowed')

  // Scan the effective allow surface only. The `excluded` record must be able to
  // name what it denies without tripping the gate, exactly as the verifier does.
  const data = allowlist()
  const allowSurface = JSON.stringify({
    endpoints: data.endpoints, regions: data.regions, transport: data.transport,
  })
  assert.doesNotMatch(allowSurface, /:\s*443\b/, 'TCP/443 must not appear in the allow surface')
  assert.doesNotMatch(allowSurface, /0\.0\.0\.0\/0/, 'a default route must never be allowed')

  // The deliberate narrowing must be recorded, not silently implied.
  const excluded = allowlist().excluded
  assert.ok(Array.isArray(excluded) && excluded.length > 0, 'exclusions must be explicit')
  const reasons = excluded.map((item) => `${item.transport} ${item.reason}`).join(' | ')
  assert.match(reasons, /udp\/7844/i, 'UDP/7844 must be explicitly excluded')
  assert.match(reasons, /tcp\/443/i, 'TCP/443 must be explicitly excluded')
})

test('CF-ALLOWLIST-ENDPOINTS are exact /32 public hosts with no broad CIDR', () => {
  const { endpoints } = allowlist()
  assert.ok(Array.isArray(endpoints) && endpoints.length > 0, 'endpoints must be a non-empty array')

  for (const endpoint of endpoints) {
    assert.match(endpoint, HOST_32, `${endpoint} must be an exact /32 host address`)
    assert.ok(octetsValid(endpoint), `${endpoint} must have valid octets`)
  }

  assert.deepEqual([...new Set(endpoints)], endpoints, 'endpoints must be unique')
  assert.deepEqual([...endpoints].sort(), endpoints, 'endpoints must be stored sorted for reviewable diffs')

  // No RFC1918 / loopback / link-local / multicast may be reachable via this allowlist.
  for (const endpoint of endpoints) {
    const [a, b] = endpoint.split(/[./]/).map(Number)
    assert.notEqual(a, 10, `${endpoint} is RFC1918`)
    assert.notEqual(a, 127, `${endpoint} is loopback`)
    assert.equal(a === 172 && b >= 16 && b <= 31, false, `${endpoint} is RFC1918`)
    assert.equal(a === 192 && b === 168, false, `${endpoint} is RFC1918`)
    assert.equal(a === 169 && b === 254, false, `${endpoint} is link-local`)
    assert.ok(a < 224, `${endpoint} is multicast or reserved`)
  }
})

test('CF-ALLOWLIST-PROVENANCE records reviewable evidence for both regions', () => {
  const data = allowlist()
  assert.ok(Array.isArray(data.provenance?.sources) && data.provenance.sources.length >= 2,
    'provenance must cite at least the documentation and the resolution evidence')
  for (const source of data.provenance.sources) {
    assert.ok(source.method && source.detail, 'each source needs a method and detail')
  }
  assert.match(JSON.stringify(data.provenance), /argotunnel\.com/, 'provenance must name the resolved hostnames')

  const hostnames = data.regions.map((region) => region.hostname).sort()
  assert.deepEqual(hostnames, ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'])

  // Every region endpoint is in the flat allowlist, and nothing extra is.
  const fromRegions = data.regions.flatMap((region) => region.endpoints).sort()
  assert.deepEqual(fromRegions, [...data.endpoints].sort(),
    'the flat endpoint list must be exactly the union of the reviewed regions')
  for (const region of data.regions) {
    assert.ok(region.endpoints.length > 0, `${region.hostname} must contribute endpoints`)
    assert.deepEqual([...new Set(region.endpoints)], region.endpoints, 'region endpoints must be unique')
  }
})

test('CF-ALLOWLIST-VERIFIER accepts the reviewed snapshot and fails closed on unsafe input', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'aegis-cf-endpoints-'))
  const run = (...args) => spawnSync(shell, [script, ...args], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  })
  const fixture = (value) => {
    const filename = path.join(scratch, 'endpoints.json')
    writeFileSync(filename, JSON.stringify(value))
    return filename
  }
  const check = (result, expected, label) => {
    assert.ifError(result.error)
    assert.equal(result.status, expected, `${label}: ${result.stdout}${result.stderr}`)
  }

  try {
    const good = allowlist()
    check(run('--check-schema'), 0, 'default path')
    check(run('--check-schema', allowlistPath), 0, 'explicit path')
    assert.match(run('--check-schema').stdout, /CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED/,
      'the passing gate string must be emitted verbatim')

    // Each unsafe mutation must be rejected.
    const rejected = {
      'broad CIDR': { ...good, endpoints: ['198.41.192.0/24'] },
      'default route': { ...good, endpoints: ['0.0.0.0/0'] },
      'bare address without /32': { ...good, endpoints: ['198.41.192.7'] },
      'udp allowed': { ...good, transport: { ...good.transport, protocols: ['tcp', 'udp'] } },
      'wrong port': { ...good, transport: { ...good.transport, port: 443 } },
      'private destination': { ...good, endpoints: ['10.0.0.1/32'], regions: [] },
      'empty endpoints': { ...good, endpoints: [] },
      'missing snapshot type': { ...good, snapshotType: undefined },
      'region drift': {
        ...good,
        regions: [{ hostname: 'region1.v2.argotunnel.com', endpoints: ['198.41.192.7/32'] }],
      },
    }
    for (const [label, value] of Object.entries(rejected)) {
      check(run('--check-schema', fixture(value)), 1, `must reject ${label}`)
    }
    check(run('--check-schema', path.join(scratch, 'absent.json')), 1, 'missing file')
    check(run(), 1, 'missing mode')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
