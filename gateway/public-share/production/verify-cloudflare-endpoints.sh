#!/usr/bin/env bash
# PUBLIC-SHARE-7 S5.5-D Task 4: offline fail-closed allowlist gate.
#
# --check-schema [endpoints.json] validates the reviewed transport allowlist.
# This never resolves DNS, never contacts Cloudflare, and never touches
# Production; it only proves the committed snapshot is exact and narrow.
#
# On success it prints CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED, which is the
# gate that unblocks the firewall tooling. The snapshot it validates is a
# reviewed point-in-time record, not an eternal Cloudflare IP contract.
set -euo pipefail

exec node --input-type=commonjs - "${BASH_SOURCE[0]}" "$@" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

try {
  const [scriptFile, mode, ...args] = process.argv.slice(2)
  const defaultFile = path.join(
    path.dirname(path.resolve(scriptFile)), 'cloudflare-endpoints.json',
  )
  assert.ok(mode === '--check-schema' && args.length <= 1,
    'usage: --check-schema [endpoints.json]')
  const file = args[0] ?? defaultFile
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(data && typeof data === 'object' && !Array.isArray(data),
    'allowlist must be an object')

  // The artifact must keep declaring itself a dated snapshot.
  assert.equal(data.snapshotType, 'reviewed-point-in-time-snapshot',
    'allowlist must declare itself a reviewed point-in-time snapshot')
  assert.match(String(data.snapshotUtc), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'snapshot requires an exact UTC instant')
  assert.match(String(data.reviewNote), /re-?verif/i,
    'snapshot must state that it requires re-verification')

  // Transport is TCP/7844 only. UDP/QUIC and 443 stay denied.
  const transport = data.transport ?? {}
  assert.equal(transport.ipVersion, 'ipv4', 'only IPv4 destinations are in scope')
  assert.equal(transport.port, 7844, 'the only allowed destination port is 7844')
  assert.ok(Array.isArray(transport.protocols), 'protocols must be a list')
  assert.deepEqual(transport.protocols, ['tcp'], 'TCP only; QUIC/UDP is excluded')

  const serialized = JSON.stringify({
    endpoints: data.endpoints, regions: data.regions, transport,
  })
  assert.doesNotMatch(serialized, /0\.0\.0\.0\/0/, 'a default route is forbidden')
  assert.doesNotMatch(serialized, /:\s*443\b/, 'TCP/443 is forbidden')

  // Exclusions must stay explicit so a later reviewer sees the narrowing.
  assert.ok(Array.isArray(data.excluded) && data.excluded.length > 0,
    'exclusions must be recorded explicitly')
  const exclusions = data.excluded.map((item) => String(item.transport)).join(' ')
  for (const required of ['udp/7844', 'tcp/443']) {
    assert.ok(exclusions.includes(required), `${required} must be explicitly excluded`)
  }

  // Every endpoint is an exact public /32 host address.
  const endpoints = data.endpoints
  assert.ok(Array.isArray(endpoints) && endpoints.length > 0,
    'endpoints must be a non-empty array')
  const host32 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/
  for (const endpoint of endpoints) {
    const match = host32.exec(String(endpoint))
    assert.ok(match, `${endpoint} must be an exact /32 host address`)
    const octets = match.slice(1, 5).map(Number)
    assert.ok(
      octets.every((o, i) => o >= 0 && o <= 255 && String(o) === match[i + 1]),
      `${endpoint} has invalid octets`,
    )
    const [a, b] = octets
    assert.ok(a !== 10 && a !== 127 && a < 224, `${endpoint} is not a public unicast address`)
    assert.ok(!(a === 172 && b >= 16 && b <= 31), `${endpoint} is RFC1918`)
    assert.ok(!(a === 192 && b === 168), `${endpoint} is RFC1918`)
    assert.ok(!(a === 169 && b === 254), `${endpoint} is link-local`)
  }
  assert.equal(new Set(endpoints).size, endpoints.length, 'endpoints must be unique')
  assert.deepEqual([...endpoints].sort(), endpoints, 'endpoints must be stored sorted')

  // The flat list must be exactly the union of the reviewed regions.
  assert.ok(Array.isArray(data.regions) && data.regions.length >= 2,
    'both tunnel regions must be recorded')
  const hostnames = data.regions.map((region) => String(region.hostname)).sort()
  assert.deepEqual(hostnames,
    ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'],
    'exactly the two reviewed region hostnames are allowed')
  const union = data.regions.flatMap((region) => region.endpoints ?? []).sort()
  assert.deepEqual(union, [...endpoints].sort(),
    'the flat endpoint list must equal the union of the reviewed regions')

  // Provenance must stay reviewable.
  assert.ok(Array.isArray(data.provenance?.sources) && data.provenance.sources.length >= 2,
    'provenance must cite documentation and resolution evidence')
  for (const source of data.provenance.sources) {
    assert.ok(source?.method && source?.detail, 'each provenance source needs method and detail')
  }

  console.log(`CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED (${endpoints.length} endpoints, tcp/${transport.port}, snapshot ${data.snapshotUtc})`)
} catch (error) {
  // Never echo supplied JSON or assertion values.
  const detail = error.code === 'ERR_ASSERTION'
    ? error.message.split('\n')[0]
    : 'unreadable or invalid JSON input'
  console.error(`CLOUDFLARE_TRANSPORT_ALLOWLIST=FAIL: ${detail}`)
  process.exitCode = 1
}
NODE
