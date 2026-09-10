// PUBLIC-SHARE-7 S5.4 repository/runtime contract.
//
// This suite is deliberately static. S5.4 Production mutation is not
// authorized by this branch, so the review gate proves the exact future
// Compose model without contacting or changing Production.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const REPO_ROOT = new URL('../../', import.meta.url)
const OVERLAY_URL = new URL(
  'gateway/public-share/production/docker-compose.s5-4.yml',
  REPO_ROOT,
)
const RUNBOOK_URL = new URL('gateway/public-share/production/README.md', REPO_ROOT)
const PLAN_URL = new URL(
  'docs/superpowers/plans/2026-09-10-idea1-public-share-s5-4-gateway-networks.md',
  REPO_ROOT,
)
const GATEWAY_ROOT = new URL('gateway/public-share/', REPO_ROOT)

const overlay = readFileSync(OVERLAY_URL, 'utf8')
const runbook = readFileSync(RUNBOOK_URL, 'utf8')
const plan = readFileSync(PLAN_URL, 'utf8')
const readGateway = (name) => readFileSync(new URL(name, GATEWAY_ROOT), 'utf8')

function namedBlock(source, name, indent) {
  const lines = source.split(/\r?\n/)
  const prefix = ' '.repeat(indent)
  const header = `${prefix}${name}:`
  const start = lines.findIndex((line) => line === header)
  assert.notEqual(start, -1, `missing ${name} block at indent ${indent}`)

  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.trimStart().startsWith('#')) {
      const leading = line.length - line.trimStart().length
      if (leading <= indent) break
    }
    body.push(line)
  }
  return body.join('\n')
}

function directKeys(block, indent) {
  const pattern = new RegExp(`^ {${indent}}([a-z0-9_-]+):(?:\\s|$)`)
  return block
    .split(/\r?\n/)
    .map((line) => pattern.exec(line)?.[1])
    .filter(Boolean)
}

function service(name) {
  return namedBlock(namedBlock(overlay, 'services', 0), name, 2)
}

function serviceNetworks(name) {
  return directKeys(namedBlock(service(name), 'networks', 4), 6)
}

function environment(name) {
  return Object.fromEntries(
    namedBlock(service(name), 'environment', 4)
      .split(/\r?\n/)
      .map((line) => /^      ([A-Z0-9_]+):\s*(.+?)\s*$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, '')]),
  )
}

test('S5.4-STRUCT-1 declares only the exact isolated edge and upstream topology', () => {
  const services = directKeys(namedBlock(overlay, 'services', 0), 2).sort()
  assert.deepEqual(services, ['drive', 'public-share-gateway'])
  assert.equal(services.includes('cloudflared'), false, 'S5.4 must not deploy cloudflared')

  const networks = namedBlock(overlay, 'networks', 0)
  assert.deepEqual(directKeys(networks, 2).sort(), [
    'aegis_public_share_edge',
    'aegis_public_share_upstream',
  ], 'the S5.4 overlay must add only its two networks; private networks come from the Production base')
  assert.doesNotMatch(networks, /172\.31\.242\.0\/29/, 'future S5.5 egress must not be created')

  for (const [name, subnet, gateway] of [
    ['aegis_public_share_edge', '172.31.240.0/29', '172.31.240.1'],
    ['aegis_public_share_upstream', '172.31.241.0/29', '172.31.241.1'],
  ]) {
    const network = namedBlock(networks, name, 2)
    assert.match(network, /^    name: /m)
    assert.match(network, /^    driver: bridge$/m)
    assert.match(network, /^    internal: true$/m)
    assert.match(
      network,
      /^      com\.docker\.network\.bridge\.gateway_mode_ipv4: "isolated"$/m,
    )
    assert.match(network, new RegExp(`^        - subnet: ${subnet.replaceAll('.', '\\.')}$`, 'm'))
    assert.match(network, new RegExp(`^          gateway: ${gateway.replaceAll('.', '\\.')}$`, 'm'))
  }
})

test('S5.4-STRUCT-2 pins exact member addresses and preserves Drive private memberships', () => {
  assert.deepEqual(serviceNetworks('public-share-gateway').sort(), [
    'aegis_public_share_edge',
    'aegis_public_share_upstream',
  ])
  assert.deepEqual(serviceNetworks('drive').sort(), [
    'aegis_drive_proxy',
    'aegis_internal',
    'aegis_public_share_upstream',
    'aegis_vlan10_macvlan',
  ])

  const gatewayNetworks = namedBlock(service('public-share-gateway'), 'networks', 4)
  assert.match(gatewayNetworks, /aegis_public_share_edge:[\s\S]*?ipv4_address: 172\.31\.240\.2/)
  assert.match(gatewayNetworks, /aegis_public_share_upstream:[\s\S]*?ipv4_address: 172\.31\.241\.2/)

  const driveNetworks = namedBlock(service('drive'), 'networks', 4)
  assert.match(driveNetworks, /aegis_drive_proxy:[\s\S]*?ipv4_address: 172\.19\.255\.3/)
  assert.match(driveNetworks, /aegis_internal:[\s\S]*?ipv4_address: 172\.18\.0\.3/)
  assert.match(driveNetworks, /aegis_vlan10_macvlan:[\s\S]*?ipv4_address: 192\.168\.10\.11/)
  assert.match(driveNetworks, /aegis_public_share_upstream:[\s\S]*?ipv4_address: 172\.31\.241\.3/)

  assert.match(overlay, /RESERVED_CONNECTOR_EDGE_IP: 172\.31\.240\.3/)
})

test('S5.4-STRUCT-3 Drive and managed-edge trust are exact, narrow, and UI-off', () => {
  const drive = environment('drive')
  assert.equal(drive.TRUSTED_PROXY_CIDRS, '172.19.255.2/32,172.31.241.2/32')
  assert.equal(drive.PUBLIC_SHARE_GATEWAY_CIDR, '172.31.241.2/32')
  assert.equal(drive.PUBLIC_SHARE_BASE_URL, 'https://share.aegistk-pb.com')
  assert.equal(drive.PUBLIC_SHARE_UI_ENABLED, 'false')

  const gateway = environment('public-share-gateway')
  assert.deepEqual(gateway, {
    PUBLIC_SHARE_HOST: 'share.aegistk-pb.com',
    PUBLIC_SHARE_EDGE_MODE: 'cloudflare',
    PUBLIC_SHARE_EDGE_PROXY_CIDR: '172.31.240.3/32',
  })

  const trustText = `${drive.TRUSTED_PROXY_CIDRS};${drive.PUBLIC_SHARE_GATEWAY_CIDR}`
  for (const forbidden of [
    '0.0.0.0/0',
    '172.31.241.0/29',
    '172.31.240.0/29',
    '172.19.255.0/29',
    '192.168.10.0/24',
  ]) {
    assert.equal(trustText.includes(forbidden), false, `${forbidden} must not enter Drive trust`)
  }
  assert.doesNotMatch(trustText, /(?:103\.21\.244|173\.245\.48|2400:cb00)/,
    'provider CIDRs must never enter Drive trust')
})

test('S5.4-STRUCT-4 gateway reuses the hardened nginx image with no host, data, or secret capability', () => {
  const gateway = service('public-share-gateway')
  assert.match(gateway, /^    image: aegis-public-share-gateway:public-share-50ce6e1638$/m)
  assert.match(gateway, /^    user: "101:101"$/m)
  assert.match(gateway, /^    read_only: true$/m)
  assert.match(gateway, /^    cap_drop:\s*\n      - ALL$/m)
  assert.match(gateway, /^    security_opt:\s*\n      - no-new-privileges:true$/m)
  assert.match(gateway, /^    tmpfs:\s*\n      - \/tmp:rw,noexec,nosuid,nodev,size=16m$/m)
  assert.match(gateway, /^    expose:\s*\n      - "8080"$/m)

  assert.doesNotMatch(gateway, /^    ports:/m)
  assert.doesNotMatch(gateway, /^    volumes:/m)
  assert.doesNotMatch(gateway, /network_mode:\s*(?:host|default)/)
  assert.doesNotMatch(gateway, /DATABASE|POSTGRES|PASSWORD|SECRET|TOKEN|STORAGE|DATALAKE/i)

  const dockerfile = readGateway('Dockerfile')
  assert.match(dockerfile, /^FROM nginx:alpine@sha256:[a-f0-9]{64}$/m)
  assert.match(dockerfile, /^USER 101:101$/m)
  assert.doesNotMatch(dockerfile, /node|python|postgres|sqlite/i)
  assert.match(readGateway('entrypoint.sh'), /aegis-validate-public-share-host\.sh/)
  assert.match(readGateway('entrypoint.sh'), /aegis-validate-public-share-edge\.sh/)
})

test('S5.4-ROLLBACK-1 runbook restores the exact S5.3 private state without whole-stack operations', () => {
  assert.match(runbook, /\/opt\/aegis\/runtime\/docker-compose\.production\.yml/)
  assert.match(runbook, /\/opt\/aegis\/runtime\/public-share\/drive-s5-3\.yml/)
  assert.match(runbook, /324fb5126b2f13f7b1c529ef1391131ef37f81acc8c3921b9b50f649b179de62/)
  assert.match(runbook, /sha256:04d2f81478fdb0d4284433cfd2d07197c9175d61425216565405a46f914766df/)
  assert.match(runbook, /TRUSTED_PROXY_CIDRS=172\.19\.255\.2\/32/)
  assert.match(runbook, /PUBLIC_SHARE_GATEWAY_CIDR=unset/)
  assert.match(runbook, /PUBLIC_SHARE_UI_ENABLED=false/)
  assert.match(runbook, /up -d --no-deps --no-build drive/)
  assert.match(runbook, /rm -s -f public-share-gateway/)
  assert.match(runbook, /docker network rm aegis_public_share_edge aegis_public_share_upstream/)

  assert.doesNotMatch(runbook, /docker compose[^\n]*\bdown\b/)
  assert.doesNotMatch(runbook, /docker (?:system|image|volume|network) prune/)
  assert.doesNotMatch(runbook, /up (?:--build |-d )*(?![^\n]*\b(?:drive|public-share-gateway)\b)[^\n]*$/m)
  assert.doesNotMatch(runbook, /PUBLIC_SHARE_UI_ENABLED=true/)
  assert.doesNotMatch(runbook, /cloudflared.*(?:up|run|start|create)/i)
})

test('S5.4-PREFLIGHT-1 PostgreSQL probes select the configured role inside the container', () => {
  const preflight = plan.match(
    /sudo bash <<'S5_4_PREFLIGHT'([\s\S]*?)\nS5_4_PREFLIGHT/,
  )?.[1]
  assert.ok(preflight, 'the owner-run S5.4 preflight must remain executable')

  assert.match(
    preflight,
    /postgres_query\(\) \{[\s\S]*?\$DOCKER exec[\s\S]*?sh -c '[\s\S]*?test -n "\$\{POSTGRES_USER:-\}"[\s\S]*?--username "\$POSTGRES_USER"[\s\S]*?' sh "\$sql"/,
    'the configured database role must expand in the PostgreSQL container, not the host shell',
  )
  assert.doesNotMatch(
    preflight,
    /\$DOCKER exec -u postgres "\$POSTGRES" psql\b/,
    'implicit PostgreSQL role selection caused the owner-observed false negative',
  )
  assert.match(
    preflight,
    /migration=\$\(postgres_query "SELECT pg_get_constraintdef\(oid\) FROM pg_constraint WHERE conname='shares_scope_check';"/,
  )
  assert.match(
    preflight,
    /public_rows=\$\(postgres_query "SELECT count\(\*\) FROM shares WHERE scope='public';"/,
  )
  assert.match(preflight, /case "\$migration" in \*public\* \) pass migration_009_present/)
  assert.match(preflight, /expect_eq public_share_rows "\$public_rows" 0/)
})
