// PUBLIC-SHARE-7 S5.5 repository/runtime contract.
//
// This suite is deliberately static, in the same spirit as the S5.4 contract.
// S5.5 Production mutation is not authorized by this branch, so the review gate
// proves the exact future Compose model without contacting or changing
// Production. Nothing here pulls an image, starts a container, reaches
// Cloudflare, or reads a real tunnel credential.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const REPO_ROOT = new URL('../../', import.meta.url)
const S5_4_URL = new URL(
  'gateway/public-share/production/docker-compose.s5-4.yml',
  REPO_ROOT,
)
const S5_5_URL = new URL(
  'gateway/public-share/production/docker-compose.s5-5.yml',
  REPO_ROOT,
)
const PIN_URL = new URL(
  'gateway/public-share/production/cloudflared-pin.json',
  REPO_ROOT,
)

// The accepted S5.4 overlay digest is recorded over LF-normalized content so
// the gate is identical on the Linux Production host and on a CRLF checkout.
const S5_4_SHA256 =
  'cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819'

// Owner-approved runtime credential contract. The host path is canonical and
// the container destination is fixed; neither is created or read by this branch.
const TOKEN_HOST_PATH = '/opt/aegis/runtime/public-share/secrets/cloudflared-token'
const TOKEN_CONTAINER_PATH = '/run/secrets/cloudflared-token'

const normalize = (text) => text.replace(/\r\n/g, '\n')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const pin = JSON.parse(readFileSync(PIN_URL, 'utf8'))

// Read lazily: before Task 3 this throws ENOENT and every structural contract
// below fails closed, which is the intended RED state.
let overlayCache
function overlay() {
  overlayCache ??= normalize(readFileSync(S5_5_URL, 'utf8'))
  return overlayCache
}

function namedBlock(source, name, indent) {
  const lines = source.split('\n')
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
  const pattern = new RegExp(`^ {${indent}}([a-z0-9_.-]+):(?:\\s|$)`)
  return block
    .split('\n')
    .map((line) => pattern.exec(line)?.[1])
    .filter(Boolean)
}

function scalar(block, indent, key) {
  const pattern = new RegExp(`^ {${indent}}${key}:\\s*(.+?)\\s*$`, 'm')
  const match = pattern.exec(block)
  assert.ok(match, `missing scalar ${key} at indent ${indent}`)
  return match[1].replace(/^['"]|['"]$/g, '')
}

// Credential scanning runs against effective configuration only. Explanatory
// comments are documentation, not directives, and must not trip the gate.
const withoutComments = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

function listItems(block, indent) {
  const pattern = new RegExp(`^ {${indent}}- (.+?)\\s*$`)
  return block
    .split('\n')
    .map((line) => pattern.exec(line)?.[1])
    .filter(Boolean)
    .map((value) => value.replace(/^['"]|['"]$/g, ''))
}

const service = (name) => namedBlock(namedBlock(overlay(), 'services', 0), name, 2)
const network = (name) => namedBlock(namedBlock(overlay(), 'networks', 0), name, 2)

test('S5.5-OVERLAY-IMMUTABLE the accepted S5.4 overlay is unchanged byte-for-byte', () => {
  const s5_4 = normalize(readFileSync(S5_4_URL, 'utf8'))
  assert.equal(
    sha256(s5_4),
    S5_4_SHA256,
    'the accepted S5.4 overlay must not be modified by S5.5',
  )
})

test('S5.5-COMPOSE-EXISTS the S5.5 overlay exists and is a Compose document', () => {
  const text = overlay()
  assert.ok(text.trim().length > 0, 'the S5.5 overlay must not be empty')
  assert.match(text, /^services:$/m, 'the S5.5 overlay must declare services')
  assert.match(text, /^networks:$/m, 'the S5.5 overlay must declare networks')
})

test('S5.5-IMAGE-PIN-CONSUMPTION the connector uses the exact verified pin', () => {
  const image = scalar(service('public-share-connector'), 4, 'image')
  assert.equal(
    image,
    pin.image,
    'the connector image must be the exact verified tag@sha256 from cloudflared-pin.json',
  )
  assert.match(
    image,
    /^cloudflare\/cloudflared:202[6-9]\.\d+\.\d+@sha256:[a-f0-9]{64}$/,
    'only an official immutable tag@sha256 reference is allowed',
  )
  assert.doesNotMatch(image, /:latest/, 'floating tags are forbidden')
})

test('S5.5-SERVICE-CONNECTOR the connector is hardened and correctly attached', () => {
  const services = directKeys(namedBlock(overlay(), 'services', 0), 2).sort()
  assert.deepEqual(
    services,
    ['public-share-connector'],
    'S5.5 adds only the connector; it must not restate drive or the gateway',
  )

  const connector = service('public-share-connector')
  assert.equal(scalar(connector, 4, 'user'), '65532:65532', 'connector must run non-root')
  assert.equal(scalar(connector, 4, 'read_only'), 'true', 'connector rootfs must be read-only')
  assert.equal(
    scalar(connector, 4, 'restart'),
    'on-failure:5',
    'connector must fail closed rather than restart forever',
  )
  assert.deepEqual(listItems(namedBlock(connector, 'cap_drop', 4), 6), ['ALL'])
  assert.deepEqual(
    listItems(namedBlock(connector, 'security_opt', 4), 6),
    ['no-new-privileges:true'],
  )
  assert.doesNotMatch(connector, /^ {4}container_name:/m, 'no fixed container_name')
  assert.doesNotMatch(connector, /^ {4}ports:/m, 'the connector must never publish a host port')
  assert.doesNotMatch(connector, /^ {4}privileged:/m, 'the connector must never be privileged')
  assert.doesNotMatch(connector, /^ {4}network_mode:/m, 'the connector must never use host networking')
  assert.doesNotMatch(connector, /^ {4}tmpfs:/m, 'the verified image needs no tmpfs to start read-only')

  // Verified startup contract, proven against the pinned image in Task 1.
  assert.deepEqual(listItems(namedBlock(connector, 'command', 4), 6), pin.entrypointFlags)

  const attached = namedBlock(connector, 'networks', 4)
  assert.deepEqual(
    directKeys(attached, 6).sort(),
    ['aegis_public_share_edge', 'aegis_public_share_egress'],
    'the connector attaches to exactly the edge and egress networks',
  )
  assert.equal(scalar(namedBlock(attached, 'aegis_public_share_edge', 6), 8, 'ipv4_address'), '172.31.240.3')
  assert.equal(scalar(namedBlock(attached, 'aegis_public_share_egress', 6), 8, 'ipv4_address'), '172.31.242.2')

  for (const forbidden of [
    'aegis_public_share_upstream',
    'aegis_internal',
    'aegis_drive_proxy',
    'aegis_vlan10',
    'aegis_vlan10_macvlan',
    'default',
  ]) {
    assert.equal(
      directKeys(attached, 6).includes(forbidden),
      false,
      `the connector must never attach to ${forbidden}`,
    )
  }
})

test('S5.5-NETWORK-EGRESS the egress bridge is exact, routable and masqueraded', () => {
  assert.deepEqual(
    directKeys(namedBlock(overlay(), 'networks', 0), 2).sort(),
    ['aegis_public_share_egress'],
    'S5.5 adds only the egress network; edge and upstream come from S5.4',
  )

  const egress = network('aegis_public_share_egress')
  assert.equal(scalar(egress, 4, 'name'), 'aegis_public_share_egress')
  assert.equal(scalar(egress, 4, 'driver'), 'bridge')
  assert.equal(scalar(egress, 4, 'internal'), 'false', 'egress must reach the Cloudflare edge')

  const opts = namedBlock(egress, 'driver_opts', 4)
  assert.equal(scalar(opts, 6, 'com\\.docker\\.network\\.bridge\\.name'), 'aegis-ps-eg')
  assert.equal(
    scalar(opts, 6, 'com\\.docker\\.network\\.bridge\\.enable_ip_masquerade'),
    'true',
  )

  const ipam = namedBlock(namedBlock(egress, 'ipam', 4), 'config', 6)
  assert.match(ipam, /^ {8}- subnet: 172\.31\.242\.0\/29$/m)
  assert.match(ipam, /^ {10}gateway: 172\.31\.242\.1$/m)
})

test('S5.5-CREDENTIAL-BOUNDS the token is file-only, read-only and never inline', () => {
  const connector = service('public-share-connector')
  const command = listItems(namedBlock(connector, 'command', 4), 6)

  const tokenFileAt = command.indexOf('--token-file')
  assert.notEqual(tokenFileAt, -1, 'the connector must read its token from a file')
  assert.equal(command[tokenFileAt + 1], '/run/secrets/cloudflared-token')
  assert.equal(command.includes('--token'), false, 'an inline --token literal is forbidden')

  // The owner-approved runtime credential lives under the canonical
  // /opt/aegis/runtime/public-share/secrets/ path on the Production host.
  const mounts = listItems(namedBlock(connector, 'volumes', 4), 6)
  assert.deepEqual(
    mounts,
    [`${TOKEN_HOST_PATH}:${TOKEN_CONTAINER_PATH}:ro`],
    'the connector mounts exactly the canonical token file, read-only',
  )

  const [hostPath, containerPath, mode] = mounts[0].split(':')
  assert.equal(hostPath, TOKEN_HOST_PATH, 'token host path must be the canonical source')
  assert.equal(containerPath, TOKEN_CONTAINER_PATH, 'token container destination is fixed')
  assert.equal(mode, 'ro', 'the token mount must be read-only')
  assert.equal(
    command[tokenFileAt + 1],
    containerPath,
    '--token-file must point at the mounted destination',
  )

  const effective = withoutComments(overlay())
  assert.doesNotMatch(effective, /TUNNEL_TOKEN/, 'no TUNNEL_TOKEN environment variable')
  assert.doesNotMatch(effective, /^ {4}environment:/m, 'the connector takes no environment credentials')
  // A real connector token is a long base64url JSON blob; none may be committed.
  assert.doesNotMatch(
    effective,
    /eyJ[A-Za-z0-9_-]{40,}/,
    'no encoded tunnel credential may appear in the overlay',
  )
})

test('S5.5-GATEWAY-DRIVE-PRESERVED S5.5 does not re-topologize drive or the gateway', () => {
  const text = overlay()
  assert.doesNotMatch(text, /^ {2}drive:$/m, 'drive topology stays owned by S5.4 and the base')
  assert.doesNotMatch(text, /^ {2}public-share-gateway:$/m, 'gateway topology stays owned by S5.4')
  assert.doesNotMatch(text, /172\.31\.241\./, 'S5.5 must not touch the upstream network')
  assert.doesNotMatch(text, /172\.31\.240\.2/, 'S5.5 must not move the gateway edge address')
  assert.doesNotMatch(text, /PUBLIC_SHARE_UI_ENABLED/, 'S5.5 must not enable the Public Share UI')
})

// ---------------------------------------------------------------------------
// S5.5-E TASK 8: connector / topology pre-start validator.
//
// Exercised against disposable mocks: a mock docker returning fixture inspect
// JSON, a mock stat returning fixture file metadata, a mock firewall script and
// a mock systemctl. Nothing here needs root, touches a real firewall, starts a
// container, reads a real token, or contacts Production.
// ---------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync as readFile } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync as exists } from 'node:fs'
import { fileURLToPath } from 'node:url'

const productionDir = fileURLToPath(new URL('../../gateway/public-share/production/', import.meta.url))
const runtimeCheck = nodePath.join(productionDir, 's5-5-runtime-check.sh')
const rollbackScript = nodePath.join(productionDir, 'rollback-s5-5.sh')
const systemdDir = nodePath.join(productionDir, 'systemd')
const runbookPath = nodePath.join(productionDir, 'README.md')
const bash = process.platform === 'win32' && exists('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'

const TOKEN_PATH = '/opt/aegis/runtime/public-share/secrets/cloudflared-token'
const CONNECTOR_CONTAINER = 'aegis-prod-public-share-connector-1'
const CONNECTOR_SERVICE = 'aegis-public-share-connector.service'

const MOCK_DOCKER_RUNTIME = `#!/usr/bin/env bash
# Disposable mock docker: serves fixture JSON, never contacts a daemon.
set -u
printf '%s\\n' "\$*" >> "\$MOCK_LOG"
if [ "\${1:-}" = "network" ] && [ "\${2:-}" = "inspect" ]; then
  file="\$MOCK_FIXTURES/net-\${3}.json"
  [ -f "\$file" ] || { echo "Error: No such network: \${3}" >&2; exit 1; }
  cat "\$file"; exit 0
fi
if [ "\${1:-}" = "inspect" ]; then
  file="\$MOCK_FIXTURES/ctr-\${2}.json"
  [ -f "\$file" ] || { echo "Error: No such object: \${2}" >&2; exit 1; }
  cat "\$file"; exit 0
fi
if [ "\${1:-}" = "compose" ]; then exit 0; fi
exit 0
`

const MOCK_STAT = `#!/usr/bin/env bash
# Disposable mock stat: returns fixture metadata; never opens file contents.
set -u
[ -f "\$MOCK_STAT_FILE" ] || { echo "stat: cannot statx: No such file or directory" >&2; exit 1; }
cat "\$MOCK_STAT_FILE"
`

const MOCK_SCRIPT_RC = `#!/usr/bin/env bash
set -u
printf '%s\\n' "\$*" >> "\$MOCK_LOG"
exit "\${MOCK_RC:-0}"
`

const MOCK_SYSTEMCTL = `#!/usr/bin/env bash
set -u
printf '%s\\n' "\$*" >> "\$MOCK_SYSTEMCTL_LOG"
exit "\${MOCK_SYSTEMCTL_RC:-0}"
`

function netFixture({ name, id, subnet, gateway, bridgeName, containers = {}, internal = true }) {
  return [{
    Name: name,
    Id: id,
    Driver: 'bridge',
    Internal: internal,
    Options: bridgeName ? { 'com.docker.network.bridge.name': bridgeName } : {},
    IPAM: { Config: [{ Subnet: subnet, Gateway: gateway }] },
    Containers: Object.fromEntries(Object.entries(containers).map(([cname, ip]) => [
      `id-${cname}`, { Name: cname, IPv4Address: `${ip}/29` },
    ])),
  }]
}

function runtimeHarness(options = {}) {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'aegis-s55-rt-'))
  const bin = nodePath.join(root, 'bin')
  const fixtures = nodePath.join(root, 'fixtures')
  mkdirSync(bin); mkdirSync(fixtures)

  const dockerBin = nodePath.join(bin, 'docker')
  const statBin = nodePath.join(bin, 'stat')
  const firewallBin = nodePath.join(bin, 's5-5-firewall.sh')
  const systemctlBin = nodePath.join(bin, 'systemctl')
  writeFileSync(dockerBin, MOCK_DOCKER_RUNTIME, { mode: 0o755 })
  writeFileSync(statBin, MOCK_STAT, { mode: 0o755 })
  writeFileSync(firewallBin, MOCK_SCRIPT_RC, { mode: 0o755 })
  writeFileSync(systemctlBin, MOCK_SYSTEMCTL, { mode: 0o755 })

  // Healthy accepted topology by default.
  const nets = {
    aegis_public_share_edge: netFixture({
      name: 'aegis_public_share_edge',
      id: 'c76a975802719cac673e9c4a9ed6d39eb1cd5820d90dcee8e4dfca590a40db50',
      subnet: '172.31.240.0/29', gateway: '172.31.240.1',
      containers: options.edgeContainers ?? { 'aegis-prod-public-share-gateway-1': '172.31.240.2' },
    }),
    aegis_public_share_upstream: netFixture({
      name: 'aegis_public_share_upstream',
      id: 'a96e511142c99f2deb413db8f3c6373927fc716f41f979bf38c8496e28ffe383',
      subnet: '172.31.241.0/29', gateway: '172.31.241.1',
      containers: options.upstreamContainers ?? {
        'aegis-prod-public-share-gateway-1': '172.31.241.2',
        'aegis-prod-drive-1': '172.31.241.3',
      },
    }),
  }
  if (options.egress !== false) {
    nets.aegis_public_share_egress = netFixture({
      name: 'aegis_public_share_egress',
      id: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
      subnet: options.egressSubnet ?? '172.31.242.0/29',
      gateway: options.egressGateway ?? '172.31.242.1',
      bridgeName: options.egressBridge ?? 'aegis-ps-eg',
      internal: false,
      containers: options.egressContainers ?? {},
    })
  }
  for (const [name, value] of Object.entries(nets)) {
    if (options.networks && options.networks[name] !== undefined) {
      if (options.networks[name] === null) continue
      writeFileSync(nodePath.join(fixtures, `net-${name}.json`), JSON.stringify(options.networks[name]))
      continue
    }
    writeFileSync(nodePath.join(fixtures, `net-${name}.json`), JSON.stringify(value))
  }

  // Connector container fixture (absent by default at pre-start).
  if (options.connectorNetworks) {
    writeFileSync(nodePath.join(fixtures, `ctr-${CONNECTOR_CONTAINER}.json`), JSON.stringify([{
      Name: `/${CONNECTOR_CONTAINER}`,
      HostConfig: { NetworkMode: options.networkMode ?? 'aegis_public_share_edge' },
      NetworkSettings: {
        Networks: Object.fromEntries(Object.entries(options.connectorNetworks).map(([n, ip]) => [
          n, { IPAddress: ip },
        ])),
      },
    }]))
  }

  // Token metadata fixture: regular file, root:65532, 0440 by default.
  const statFile = nodePath.join(fixtures, 'token-stat.txt')
  if (options.tokenStat !== null) {
    writeFileSync(statFile, `${options.tokenStat ?? 'regular file|0|65532|440'}\n`)
  }

  const log = nodePath.join(root, 'mock.log')
  const systemctlLog = nodePath.join(root, 'systemctl.log')
  writeFileSync(log, ''); writeFileSync(systemctlLog, '')

  const env = {
    ...process.env,
    MSYS_NO_PATHCONV: '1',
    MOCK_FIXTURES: fixtures,
    MOCK_LOG: log,
    MOCK_STAT_FILE: statFile,
    MOCK_SYSTEMCTL_LOG: systemctlLog,
    MOCK_RC: String(options.firewallRc ?? 0),
    MOCK_SYSTEMCTL_RC: String(options.systemctlRc ?? 0),
    AEGIS_DOCKER_BIN: dockerBin,
    AEGIS_STAT_BIN: statBin,
    AEGIS_FIREWALL_SCRIPT: firewallBin,
    AEGIS_SYSTEMCTL_BIN: systemctlBin,
    AEGIS_TOKEN_FILE: options.tokenFile ?? TOKEN_PATH,
    AEGIS_CONNECTOR_CONTAINER: CONNECTOR_CONTAINER,
  }

  const run = (...args) => spawnSync(bash, [runtimeCheck, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  })
  const runRollback = (...args) => spawnSync(bash, [rollbackScript, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  })
  const mockLog = () => readFile(log, 'utf8')
  const systemctlCalls = () => readFile(systemctlLog, 'utf8')
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { run, runRollback, mockLog, systemctlCalls, cleanup, env, root }
}

test('S5.5-PRESTART-HAPPY accepts the complete safe state', () => {
  const h = runtimeHarness()
  try {
    const result = h.run('--pre-start')
    assert.equal(result.status, 0, `pre-start should accept a safe state: ${result.stdout}${result.stderr}`)
    // The firewall gate must actually have been consulted.
    assert.match(h.mockLog(), /validate/, 's5-5-firewall.sh validate must be invoked')
  } finally { h.cleanup() }
})

test('S5.5-PRESTART-FIREWALL halts immediately when firewall validation fails', () => {
  const h = runtimeHarness({ firewallRc: 1 })
  try {
    assert.equal(h.run('--pre-start').status, 1, 'a failing firewall validate must fail the pre-start gate')
  } finally { h.cleanup() }
})

test('S5.5-PRESTART-TOPOLOGY requires the accepted edge and upstream topology', () => {
  // Edge gateway missing from its accepted address.
  let h = runtimeHarness({ edgeContainers: {} })
  try {
    assert.equal(h.run('--pre-start').status, 1, 'missing gateway on edge .2 must fail')
  } finally { h.cleanup() }

  // Gateway present but at the wrong edge address.
  h = runtimeHarness({ edgeContainers: { 'aegis-prod-public-share-gateway-1': '172.31.240.4' } })
  try {
    assert.equal(h.run('--pre-start').status, 1, 'gateway at the wrong edge address must fail')
  } finally { h.cleanup() }

  // Drive missing from upstream .3.
  h = runtimeHarness({ upstreamContainers: { 'aegis-prod-public-share-gateway-1': '172.31.241.2' } })
  try {
    assert.equal(h.run('--pre-start').status, 1, 'missing drive on upstream .3 must fail')
  } finally { h.cleanup() }

  // Edge network absent entirely.
  h = runtimeHarness({ networks: { aegis_public_share_edge: null } })
  try {
    assert.equal(h.run('--pre-start').status, 1, 'a missing edge network must fail closed')
  } finally { h.cleanup() }
})

test('S5.5-PRESTART-EGRESS validates egress topology when the network is present', () => {
  for (const [label, options] of Object.entries({
    'wrong subnet': { egressSubnet: '172.31.243.0/29' },
    'wrong gateway': { egressGateway: '172.31.242.9' },
    'wrong stable bridge name': { egressBridge: 'br-whatever' },
  })) {
    const h = runtimeHarness(options)
    try {
      assert.equal(h.run('--pre-start').status, 1, `egress with ${label} must fail`)
    } finally { h.cleanup() }
  }
})

test('S5.5-PRESTART-MEMBERSHIP refuses any forbidden connector attachment', () => {
  // Exactly edge + egress is the only accepted membership.
  let h = runtimeHarness({
    connectorNetworks: {
      aegis_public_share_edge: '172.31.240.3',
      aegis_public_share_egress: '172.31.242.2',
    },
  })
  try {
    assert.equal(h.run('--pre-start').status, 0, 'edge + egress membership must be accepted')
  } finally { h.cleanup() }

  const forbidden = [
    'aegis_public_share_upstream',
    'aegis_internal',
    'aegis_drive_proxy',
    'aegis_vlan10',
    'aegis_vlan10_macvlan',
    'bridge',
  ]
  for (const network of forbidden) {
    const h2 = runtimeHarness({
      connectorNetworks: {
        aegis_public_share_edge: '172.31.240.3',
        aegis_public_share_egress: '172.31.242.2',
        [network]: '10.1.2.3',
      },
    })
    try {
      assert.equal(h2.run('--pre-start').status, 1, `attachment to ${network} must be refused`)
    } finally { h2.cleanup() }
  }

  // Host networking is never acceptable.
  const h3 = runtimeHarness({
    connectorNetworks: { host: '' }, networkMode: 'host',
  })
  try {
    assert.equal(h3.run('--pre-start').status, 1, 'host networking must be refused')
  } finally { h3.cleanup() }

  // Right networks, wrong fixed addresses.
  const h4 = runtimeHarness({
    connectorNetworks: {
      aegis_public_share_edge: '172.31.240.5',
      aegis_public_share_egress: '172.31.242.2',
    },
  })
  try {
    assert.equal(h4.run('--pre-start').status, 1, 'connector must hold its exact fixed addresses')
  } finally { h4.cleanup() }
})

test('S5.5-PRESTART-TOKEN enforces regular-file, ownership and mode without reading content', () => {
  // Happy path is asserted by S5.5-PRESTART-HAPPY; here every unsafe variant.
  const unsafe = {
    'a directory at the token path (Compose create_host_path)': 'directory|0|65532|440',
    'a symlink at the token path': 'symbolic link|0|65532|440',
    'wrong owner': 'regular file|1000|65532|440',
    'wrong group': 'regular file|0|0|440',
    'world readable mode': 'regular file|0|65532|444',
    'group writable mode': 'regular file|0|65532|460',
    'mode 0640': 'regular file|0|65532|640',
    'mode 0400': 'regular file|0|65532|400',
  }
  for (const [label, statLine] of Object.entries(unsafe)) {
    const h = runtimeHarness({ tokenStat: statLine })
    try {
      const result = h.run('--pre-start')
      assert.equal(result.status, 1, `token check must reject ${label}`)
    } finally { h.cleanup() }
  }

  // A missing token path must fail closed, never be created.
  const missing = runtimeHarness({ tokenStat: null })
  try {
    assert.equal(missing.run('--pre-start').status, 1, 'a missing token file must fail closed')
  } finally { missing.cleanup() }
})

test('S5.5-PRESTART-TOKEN-SECRECY never reads, prints or passes the token', () => {
  const text = readFile(runtimeCheck, 'utf8')
  const code = text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')

  // The validator may stat the path, but must never open or emit its bytes.
  for (const forbidden of [/\bcat\b[^\n]*TOKEN/i, /\bhead\b[^\n]*TOKEN/i, /\btail\b[^\n]*TOKEN/i,
    /\bod\b[^\n]*TOKEN/i, /\bxxd\b[^\n]*TOKEN/i, /sha\d*sum[^\n]*TOKEN/i, /md5sum[^\n]*TOKEN/i,
    /\bbase64\b[^\n]*TOKEN/i, /\$\(<\s*"?\$\{?TOKEN/i, /read[^\n]*<[^\n]*TOKEN/i]) {
    assert.doesNotMatch(code, forbidden, `the validator must never read token contents: ${forbidden}`)
  }
  assert.doesNotMatch(code, /TUNNEL_TOKEN/, 'the token must never be exported as an environment variable')
  assert.doesNotMatch(code, /--token\s+[^f]/, 'the token must never be passed as an inline argument')

  // And it must genuinely check type/owner/mode.
  assert.match(code, /regular file/, 'the validator must require a regular file')
  assert.match(code, /440/, 'the validator must require mode 0440')
  assert.match(code, /65532/, 'the validator must require group 65532')
})

test('S5.5-PRESTART-USAGE fails closed on an unknown or missing mode', () => {
  const h = runtimeHarness()
  try {
    assert.notEqual(h.run().status, 0, 'no mode must fail')
    assert.notEqual(h.run('--definitely-not-a-mode').status, 0, 'an unknown mode must fail')
  } finally { h.cleanup() }
})

// ---------------------------------------------------------------------------
// S5.5-E TASK 10: periodic drift fail-closed enforcement.
//
// The watchdog is driven against the same disposable mocks. systemd is never
// invoked for real: `systemctl` is a mock that only records its arguments.
// ---------------------------------------------------------------------------

const driftServicePath = nodePath.join(systemdDir, 'aegis-public-share-drift.service')
const driftTimerPath = nodePath.join(systemdDir, 'aegis-public-share-drift.timer')

function unitSections(file) {
  const sections = {}
  let current = null
  for (const raw of readFile(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)]$/.exec(line)
    if (header) { current = header[1]; sections[current] ??= {}; continue }
    const kv = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line)
    if (kv && current) { sections[current][kv[1]] ??= []; sections[current][kv[1]].push(kv[2].trim()) }
  }
  return sections
}

test('S5.5-DRIFT-TIMER runs on the exact approved cadence', () => {
  const timer = unitSections(driftTimerPath)
  assert.equal(timer.Timer.OnBootSec[0], '1min')
  assert.equal(timer.Timer.OnUnitActiveSec[0], '60s')
  assert.equal(timer.Timer.AccuracySec[0], '15s')
  assert.equal(timer.Timer.Unit[0], 'aegis-public-share-drift.service')
  assert.ok(timer.Install, 'the timer needs an [Install] section to be enabled')
})

test('S5.5-DRIFT-SERVICE is a oneshot that only enforces', () => {
  const service = unitSections(driftServicePath)
  assert.equal(service.Service.Type[0], 'oneshot')
  assert.equal(
    service.Service.ExecStart[0],
    '/opt/aegis/runtime/public-share/s5-5-runtime-check.sh --enforce-drift',
  )
  // The watchdog must never repair by weakening, nor restart the world.
  const body = readFile(driftServicePath, 'utf8')
  for (const forbidden of [/compose[^\n]*\bdown\b/, /\bprune\b/, /iptables/, /\bufw\b/,
    /systemctl[^\n]*\b(docker|ufw)\b/, /s5-5-firewall\.sh\s+remove/]) {
    assert.doesNotMatch(body, forbidden, `the drift unit must not run ${forbidden}`)
  }
})

test('S5.5-DRIFT-CLEAN does nothing while the state is safe', () => {
  const h = runtimeHarness({
    connectorNetworks: {
      aegis_public_share_edge: '172.31.240.3',
      aegis_public_share_egress: '172.31.242.2',
    },
  })
  try {
    const result = h.run('--enforce-drift')
    assert.equal(result.status, 0, `a safe state must not trigger enforcement: ${result.stderr}`)
    assert.equal(h.systemctlCalls().trim(), '', 'nothing may be stopped while the state is safe')
  } finally { h.cleanup() }
})

test('S5.5-DRIFT-STOPS-CONNECTOR-ONLY stops the connector and nothing else', () => {
  // Each drift class must trigger enforcement.
  const driftCases = {
    'firewall policy drift': { firewallRc: 1 },
    'unauthorized network attachment': {
      connectorNetworks: {
        aegis_public_share_edge: '172.31.240.3',
        aegis_public_share_egress: '172.31.242.2',
        aegis_public_share_upstream: '172.31.241.4',
      },
    },
    'connector address drift': {
      connectorNetworks: {
        aegis_public_share_edge: '172.31.240.9',
        aegis_public_share_egress: '172.31.242.2',
      },
    },
    'egress topology drift': { egressBridge: 'br-unexpected' },
    'edge topology drift': { edgeContainers: {} },
    'credential drift': { tokenStat: 'regular file|0|0|444' },
  }

  for (const [label, options] of Object.entries(driftCases)) {
    const h = runtimeHarness(options)
    try {
      const result = h.run('--enforce-drift')
      assert.notEqual(result.status, 0, `${label} must be reported as drift`)

      const calls = h.systemctlCalls()
      assert.match(calls, /stop aegis-public-share-connector\.service/,
        `${label} must stop the connector service`)

      // The blast radius is exactly one unit.
      const stopped = calls.split(/\r?\n/).filter(Boolean)
      assert.equal(stopped.length, 1, `${label} must issue exactly one systemctl action`)
      for (const protectedUnit of ['docker', 'ufw', 'postgres', 'drive', 'gateway',
        'monitor', 'twingate', 'containerd']) {
        assert.doesNotMatch(calls, new RegExp(protectedUnit, 'i'),
          `${label} must never target ${protectedUnit}`)
      }
      assert.doesNotMatch(calls, /\b(restart|disable|mask)\b/,
        `${label} must only stop, never restart or disable`)
    } finally { h.cleanup() }
  }
})

test('S5.5-DRIFT-STOP-FAILURE reports safely instead of escalating', () => {
  const h = runtimeHarness({ firewallRc: 1, systemctlRc: 1 })
  try {
    const result = h.run('--enforce-drift')
    assert.notEqual(result.status, 0, 'a failed stop must be reported as failure')
    assert.match(`${result.stdout}${result.stderr}`, /STOP-FAILED/,
      'the failure must be reported explicitly')
    // One attempt, then report. No retry storm, no broader action.
    assert.equal(h.systemctlCalls().split(/\r?\n/).filter(Boolean).length, 1,
      'a failed stop must not escalate or loop')
  } finally { h.cleanup() }
})

test('S5.5-DRIFT-NEVER-WEAKENS-FIREWALL the watchdog only reads firewall state', () => {
  const code = readFile(runtimeCheck, 'utf8')
    .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert.match(code, /s5-5-firewall\.sh|FIREWALL_SCRIPT/, 'it must consult the firewall gate')
  assert.doesNotMatch(code, /FIREWALL_SCRIPT"?\s+(remove|apply)/,
    'the watchdog must never apply or remove firewall policy')
  assert.doesNotMatch(code, /iptables/, 'the watchdog must never drive iptables directly')
  assert.doesNotMatch(code, /\bufw\b/, 'the watchdog must never drive UFW')
})
