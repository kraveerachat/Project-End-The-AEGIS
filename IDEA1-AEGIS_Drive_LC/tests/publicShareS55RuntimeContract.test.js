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

function netFixture({ name, id, subnet, gateway, bridgeName, gatewayMode, containers = {}, internal = true, enableIPv6 = false }) {
  const doc = {
    Name: name,
    Id: id,
    Driver: 'bridge',
    Internal: internal,
    Options: {
      ...(bridgeName ? { 'com.docker.network.bridge.name': bridgeName } : {}),
      ...(gatewayMode ? { 'com.docker.network.bridge.gateway_mode_ipv4': gatewayMode } : {}),
    },
    IPAM: { Config: [{ Subnet: subnet, Gateway: gateway }] },
    Containers: Object.fromEntries(Object.entries(containers).map(([cname, ip]) => [
      `id-${cname}`, { Name: cname, IPv4Address: `${ip}/29` },
    ])),
  }
  if (enableIPv6 !== undefined) {
    doc.EnableIPv6 = enableIPv6
  }
  return [doc]
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
      subnet: '172.31.240.0/29', gateway: '172.31.240.1', gatewayMode: 'isolated',
      containers: options.edgeContainers ?? { 'aegis-prod-public-share-gateway-1': '172.31.240.2' },
    }),
    aegis_public_share_upstream: netFixture({
      name: 'aegis_public_share_upstream',
      id: 'a96e511142c99f2deb413db8f3c6373927fc716f41f979bf38c8496e28ffe383',
      subnet: '172.31.241.0/29', gateway: '172.31.241.1', gatewayMode: 'isolated',
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

  // Connector container fixture. Absent unless the scenario says otherwise,
  // which models "the bootstrap create has not been run yet".
  if (options.connectorNetworks || options.networkMode || options.connectorState) {
    const state = options.connectorState ?? 'created'
    writeFileSync(nodePath.join(fixtures, `ctr-${CONNECTOR_CONTAINER}.json`), JSON.stringify([{
      Name: `/${CONNECTOR_CONTAINER}`,
      State: {
        Status: state,
        Running: options.connectorRunning ?? (state === 'running'),
        Restarting: options.connectorRestarting ?? (state === 'restarting'),
        Paused: state === 'paused',
        Dead: state === 'dead',
      },
      RestartCount: options.connectorRestartCount ?? 0,
      Config: {
        Labels: options.connectorLabels ?? {
          'com.docker.compose.project': 'aegis-prod',
          'com.docker.compose.service': 'public-share-connector',
        },
      },
      HostConfig: { NetworkMode: options.networkMode ?? 'aegis_public_share_edge' },
      NetworkSettings: {
        // Docker keeps the configured attachment on a stopped container but clears
        // the live endpoint fields, so the realistic shape depends on state:
        //   stopped (created/exited): IPAddress "" and IPAMConfig.IPv4Address kept
        //   running:                  IPAddress assigned and IPAMConfig.IPv4Address kept
        // A string value renders that state-appropriate shape; an object value is
        // used verbatim so a test can pin any combination explicitly.
        Networks: Object.fromEntries(Object.entries(options.connectorNetworks ?? {}).map(([n, value]) => {
          if (value !== null && typeof value === 'object') return [n, value]
          const live = state === 'running' || options.connectorRunning === true
          return [n, { IPAddress: live ? value : '', IPAMConfig: { IPv4Address: value } }]
        })),
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
  // Since the create-before-start correction, the "complete safe state" includes
  // an already-created, still-stopped connector and a materialised egress network.
  const h = runtimeHarness({
    connectorNetworks: {
      aegis_public_share_edge: '172.31.240.3',
      aegis_public_share_egress: '172.31.242.2',
    },
    connectorState: 'created',
  })
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
  // Drift validates the RUNNING connector: live addresses are assigned. (A
  // stopped object has no live endpoint and is correctly reported as drift.)
  const h = runtimeHarness({
    connectorState: 'running',
    connectorRunning: true,
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

// ---------------------------------------------------------------------------
// S5.5-E TASK 11: connector-only rollback.
//
// Driven against the same disposable mocks. Nothing is stopped, removed or
// pruned for real, and Production is never contacted.
// ---------------------------------------------------------------------------

test('S5.5-ROLLBACK-FORBIDS-BROAD-OPERATIONS never uses a whole-stack hammer', () => {
  const text = readFile(rollbackScript, 'utf8')
  const code = text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')

  assert.match(text, /^#!\/usr\/bin\/env bash$/m)
  assert.match(text, /^set -euo pipefail$/m)

  for (const forbidden of [
    [/compose[^\n]*\bdown\b/, 'docker compose down'],
    [/system\s+prune/, 'docker system prune'],
    [/network\s+prune/, 'docker network prune'],
    [/volume\s+prune/, 'docker volume prune'],
    [/image\s+prune/, 'docker image prune'],
    [/volume\s+rm/, 'volume removal'],
    [/-v\b[^\n]*\brm\b|\brm\b[^\n]*\s-v\b/, 'container removal with volumes'],
    [/\bufw\b/, 'UFW'],
    [/systemctl[^\n]*\b(docker|containerd)\b/, 'docker daemon control'],
  ]) {
    assert.doesNotMatch(code, forbidden[0], `rollback must never run ${forbidden[1]}`)
  }

  // It must never recreate or restart anything it does not own.
  for (const service of ['drive', 'public-share-gateway', 'postgres', 'monitor', 'twingate']) {
    assert.doesNotMatch(code, new RegExp(`\\b(up|restart|rm|stop)\\b[^\\n]*\\b${service}\\b`),
      `rollback must never operate ${service}`)
  }
})

test('S5.5-ROLLBACK-ORDER reverses the lifecycle narrowly', () => {
  // A deployed connector exists, and the egress network is already drained.
  const h = runtimeHarness({
    egressContainers: {},
    connectorNetworks: {
      aegis_public_share_edge: '172.31.240.3',
      aegis_public_share_egress: '172.31.242.2',
    },
  })
  try {
    const result = h.runRollback()
    assert.equal(result.status, 0, `rollback should succeed: ${result.stdout}${result.stderr}`)

    const systemctl = h.systemctlCalls()
    const docker = h.mockLog()

    // 1-2. Drift lifecycle and connector service are stopped and disabled first.
    assert.match(systemctl, /stop aegis-public-share-drift\.timer/)
    assert.match(systemctl, /disable aegis-public-share-drift\.timer/)
    assert.match(systemctl, /stop aegis-public-share-connector\.service/)
    assert.match(systemctl, /disable aegis-public-share-connector\.service/)

    // Reverse order: the timer must be stopped before the connector, so the
    // watchdog cannot fight the rollback.
    assert.ok(
      systemctl.indexOf('stop aegis-public-share-drift.timer')
        < systemctl.indexOf('stop aegis-public-share-connector.service'),
      'the drift timer must be stopped before the connector',
    )

    // 3. Only the connector container is removed.
    assert.match(docker, /rm .*public-share-connector|stop .*public-share-connector/)

    // 4. Firewall policy is removed through the owning tool only.
    assert.match(h.mockLog(), /remove/, 's5-5-firewall.sh remove must be invoked')

    // 5. The egress network is removed only after it is proven empty.
    assert.match(docker, /network inspect aegis_public_share_egress/)
    assert.match(docker, /network rm aegis_public_share_egress/)
    assert.ok(
      docker.indexOf('network inspect aegis_public_share_egress')
        < docker.indexOf('network rm aegis_public_share_egress'),
      'the egress network must be inspected before it is removed',
    )
  } finally { h.cleanup() }
})

test('S5.5-ROLLBACK-EGRESS-ENDPOINTS refuses to remove a network still in use', () => {
  const h = runtimeHarness({
    egressContainers: { 'aegis-prod-public-share-connector-1': '172.31.242.2' },
  })
  try {
    const result = h.runRollback()
    assert.notEqual(result.status, 0, 'rollback must fail when the egress network still has endpoints')
    assert.doesNotMatch(h.mockLog(), /network rm aegis_public_share_egress/,
      'a network with endpoints must never be removed')
  } finally { h.cleanup() }
})

test('S5.5-ROLLBACK-PRESERVES-S5-4 leaves the accepted baseline intact', () => {
  const h = runtimeHarness({ egressContainers: {} })
  try {
    assert.equal(h.runRollback().status, 0)
    const docker = h.mockLog()

    // The S5.4 networks and services are never touched.
    for (const network of ['aegis_public_share_edge', 'aegis_public_share_upstream',
      'aegis_internal', 'aegis_drive_proxy', 'aegis_vlan10']) {
      assert.doesNotMatch(docker, new RegExp(`network rm[^\\n]*${network}`),
        `rollback must never remove ${network}`)
    }
    const systemctl = h.systemctlCalls()
    for (const unit of ['docker', 'ufw', 'postgres', 'twingate', 'monitor']) {
      assert.doesNotMatch(systemctl, new RegExp(unit, 'i'), `rollback must never control ${unit}`)
    }
  } finally { h.cleanup() }
})

test('S5.5-ROLLBACK-IDEMPOTENT tolerates already-absent objects', () => {
  // Egress network already gone, connector already removed.
  const h = runtimeHarness({ egress: false })
  try {
    const first = h.runRollback()
    assert.equal(first.status, 0, `rollback must tolerate an absent egress network: ${first.stderr}`)
    const second = h.runRollback()
    assert.equal(second.status, 0, 'rollback must be idempotent')
    assert.doesNotMatch(h.mockLog(), /\bprune\b/,
      'an absent object must never trigger a broad cleanup')
  } finally { h.cleanup() }
})

// ---------------------------------------------------------------------------
// S5.5-E TASK 13: production runbook contract.
//
// The runbook may DOCUMENT future Production commands, but documentation is not
// authorization. These assertions pin both the operational content and the
// explicit gating language.
// ---------------------------------------------------------------------------

const runbook = () => readFile(runbookPath, 'utf8')

test('S5.5-RUNBOOK-COMPOSE-ORDER documents the exact four-layer stack', () => {
  const text = runbook()
  const layers = [
    'docker-compose.production.yml',
    'drive-s5-3.yml',
    'drive-gateway-s5-4.yml',
    'connector-s5-5.yml',
  ]
  let cursor = -1
  for (const layer of layers) {
    const at = text.indexOf(layer, cursor + 1)
    assert.notEqual(at, -1, `the runbook must document ${layer}`)
    assert.ok(at > cursor, `${layer} must appear in the accepted layering order`)
    cursor = at
  }
  // The deployed connector overlay is a byte-for-byte copy, not a hand edit.
  assert.match(text, /connector-s5-5\.yml[\s\S]{0,400}byte-for-byte[\s\S]{0,200}docker-compose\.s5-5\.yml|docker-compose\.s5-5\.yml[\s\S]{0,400}byte-for-byte[\s\S]{0,200}connector-s5-5\.yml/,
    'the runbook must state connector-s5-5.yml is copied byte-for-byte from docker-compose.s5-5.yml')
  assert.match(text, /--project-name aegis-prod/, 'the accepted Compose project must be documented')
})

test('S5.5-RUNBOOK-TOKEN documents exact credential preparation and handling', () => {
  const text = runbook()
  assert.match(text, /\/opt\/aegis\/runtime\/public-share\/secrets\/cloudflared-token/,
    'the canonical token path must be documented')
  assert.match(text, /0440/, 'mode 0440 must be documented')
  assert.match(text, /root:65532|root\b[\s\S]{0,80}65532/, 'owner root and group 65532 must be documented')

  // The create_host_path trap must be called out explicitly.
  assert.match(text, /regular file/i, 'the runbook must require a regular file')
  assert.match(text, /director(y|ies)/i, 'the runbook must warn about a directory being created')
  assert.match(text, /before[\s\S]{0,120}compose|compose[\s\S]{0,120}before/i,
    'the runbook must require creating the file BEFORE Compose runs')

  // Handling warnings.
  for (const warning of [/history/i, /\blogs?\b/i, /environment|env\b/i, /Obsidian|receipt/i]) {
    assert.match(text, warning, `the runbook must warn about ${warning}`)
  }
  assert.match(text, /\b(cat|echo)\b/, 'the runbook must warn against echoing or cat-ing the token')
})

test('S5.5-RUNBOOK-LIFECYCLE documents firewall, validator, drift and rollback', () => {
  const text = runbook()
  assert.match(text, /s5-5-firewall\.sh apply/, 'firewall apply must be documented')
  assert.match(text, /s5-5-firewall\.sh validate/, 'firewall validate must be documented')
  assert.match(text, /s5-5-runtime-check\.sh --pre-start/, 'the pre-start validator must be documented')
  assert.match(text, /s5-5-runtime-check\.sh --enforce-drift/, 'drift enforcement must be documented')
  assert.match(text, /aegis-public-share-s5-5-firewall\.service/)
  assert.match(text, /aegis-public-share-connector\.service/)
  assert.match(text, /aegis-public-share-drift\.timer/)
  assert.match(text, /rollback-s5-5\.sh/, 'connector-only rollback must be documented')
  assert.match(text, /fail[- ]closed/i, 'fail-closed behaviour must be documented')

  // The S5.4 rollback section must survive this update.
  assert.match(text, /docker-compose\.s5-4\.yml|drive-gateway-s5-4\.yml/,
    'the existing S5.4 runbook content must be preserved')
})

test('S5.5-RUNBOOK-NOT-AUTHORIZATION gates every Production action', () => {
  const text = runbook()
  assert.match(text, /DO NOT EXECUTE WITHOUT SEPARATE S5\.5-F OWNER AUTHORIZATION/,
    'the runbook must carry the explicit non-authorization banner verbatim')
  assert.match(text, /documentation is not approval|not authorization|NOT approval/i,
    'the runbook must state that documentation is not approval')

  // Remaining gates must be recorded honestly.
  assert.match(text, /PRODUCTION_DNS_PATH_MEASURED=NO/)
  assert.match(text, /atomicity[\s\S]{0,120}NOT ACCEPTED|NOT ACCEPTED[\s\S]{0,120}atomicity/i)
  assert.match(text, /persistence[\s\S]{0,160}NOT ACCEPTED|NOT ACCEPTED[\s\S]{0,160}persistence/i)
  assert.match(text, /NOT CONFIGURED/, 'public DNS/TLS must be recorded as not configured')
  assert.match(text, /Internet exposure[\s\S]{0,40}NONE/i)
  assert.match(text, /G5[\s\S]{0,20}OPEN/)
  assert.match(text, /UI[\s\S]{0,20}OFF|PUBLIC_SHARE_UI_ENABLED[\s\S]{0,20}false/i)

  // No DNS exception may be smuggled in as a documented step.
  assert.doesNotMatch(text, /--dport\s+53[^\n]*ACCEPT/, 'no DNS allow rule may be documented')
})

// ---------------------------------------------------------------------------
// S5.5-E LIFECYCLE CORRECTION: create-before-start.
//
// The object that is validated must be the object that starts. Pre-start no
// longer tolerates an absent egress network or an absent connector: by the time
// it runs, the connector has already been CREATED (stopped) by the authorized
// bootstrap, which is what materialises the egress network and aegis-ps-eg.
//
// Still mock-only: no container is created, no unit installed, no firewall
// touched, no real token used.
// ---------------------------------------------------------------------------

// A stopped, correctly-labelled, correctly-attached connector.
const STOPPED_CONNECTOR = {
  connectorNetworks: {
    aegis_public_share_edge: '172.31.240.3',
    aegis_public_share_egress: '172.31.242.2',
  },
  connectorState: 'created',
  connectorRunning: false,
  connectorLabels: {
    'com.docker.compose.project': 'aegis-prod',
    'com.docker.compose.service': 'public-share-connector',
  },
}

test('S5.5-LIFECYCLE-PRESTART-REQUIRES-EGRESS refuses when the egress network is absent', () => {
  const h = runtimeHarness({ ...STOPPED_CONNECTOR, egress: false })
  try {
    const result = h.run('--pre-start')
    assert.equal(result.status, 1,
      'pre-start must refuse when aegis_public_share_egress does not exist')
  } finally { h.cleanup() }
})

test('S5.5-LIFECYCLE-PRESTART-REQUIRES-CONNECTOR refuses when the connector is absent', () => {
  // No connectorNetworks => no container fixture => docker inspect fails.
  const h = runtimeHarness()
  try {
    const result = h.run('--pre-start')
    assert.equal(result.status, 1,
      'pre-start must refuse when the connector container has not been created')
  } finally { h.cleanup() }
})

test('S5.5-LIFECYCLE-PRESTART-REQUIRES-STOPPED refuses any non-stopped state', () => {
  // The whole point of create-before-start: it must not already be running.
  for (const state of ['running', 'restarting', 'paused', 'dead', 'removing', 'unknown']) {
    const h = runtimeHarness({
      ...STOPPED_CONNECTOR,
      connectorState: state,
      connectorRunning: state === 'running',
    })
    try {
      assert.equal(h.run('--pre-start').status, 1,
        `pre-start must refuse a connector in state '${state}'`)
    } finally { h.cleanup() }
  }

  // Running=true must be refused even if the status string looks benign.
  const lying = runtimeHarness({ ...STOPPED_CONNECTOR, connectorState: 'created', connectorRunning: true })
  try {
    assert.equal(lying.run('--pre-start').status, 1,
      'pre-start must refuse whenever Running is true')
  } finally { lying.cleanup() }

  // An ACTIVE restart loop is current state, not history: Restarting=true must
  // be refused whatever the status string says.
  const restartingFlag = runtimeHarness({
    ...STOPPED_CONNECTOR, connectorState: 'exited', connectorRestarting: true,
  })
  try {
    assert.equal(restartingFlag.run('--pre-start').status, 1,
      'pre-start must refuse whenever State.Restarting is true')
  } finally { restartingFlag.cleanup() }
})

test('S5.5-LIFECYCLE-PRESTART-RESTARTCOUNT-IS-HISTORY does not reject on past restarts', () => {
  // RestartCount is cumulative history, not current state. A container that
  // restarted earlier and is now genuinely stopped is a safe object to validate
  // and start; rejecting it would make the connector permanently unstartable
  // after any past restart.
  const priorRestarts = runtimeHarness({
    ...STOPPED_CONNECTOR,
    connectorState: 'exited',
    connectorRunning: false,
    connectorRestarting: false,
    connectorRestartCount: 3,
  })
  try {
    const result = priorRestarts.run('--pre-start')
    assert.equal(result.status, 0,
      `a stopped connector with prior restarts must be accepted: ${result.stdout}${result.stderr}`)
  } finally { priorRestarts.cleanup() }

  // Both accepted stopped states, with and without restart history.
  for (const state of ['created', 'exited']) {
    for (const restarts of [0, 7]) {
      const h = runtimeHarness({
        ...STOPPED_CONNECTOR, connectorState: state, connectorRestartCount: restarts,
      })
      try {
        assert.equal(h.run('--pre-start').status, 0,
          `${state} with RestartCount=${restarts} must be accepted`)
      } finally { h.cleanup() }
    }
  }

  // An active loop is still refused, and history is never the reason.
  for (const options of [
    { connectorState: 'restarting', connectorRestartCount: 5 },
    { connectorState: 'exited', connectorRestarting: true, connectorRestartCount: 0 },
  ]) {
    const h = runtimeHarness({ ...STOPPED_CONNECTOR, ...options })
    try {
      assert.equal(h.run('--pre-start').status, 1, 'an active restart loop must be refused')
    } finally { h.cleanup() }
  }

  // The validator must not treat a restart count as proof of a live loop.
  const code = readFile(runtimeCheck, 'utf8')
    .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(code, /RestartCount[^\n]*(fail|result=1)/i,
    'RestartCount must not be a rejection criterion on its own')
})

test('S5.5-LIFECYCLE-PRESTART-ACCEPTS-CREATED-AND-EXITED passes only for the approved stopped states', () => {
  for (const state of ['created', 'exited']) {
    const h = runtimeHarness({ ...STOPPED_CONNECTOR, connectorState: state })
    try {
      const result = h.run('--pre-start')
      assert.equal(result.status, 0,
        `pre-start must accept a stopped connector in state '${state}': ${result.stdout}${result.stderr}`)
    } finally { h.cleanup() }
  }
})

test('S5.5-LIFECYCLE-PRESTART-LABELS binds validation to the accepted project and service', () => {
  // A container with the right name but the wrong identity must be refused, so
  // validation cannot be satisfied by a look-alike.
  const wrongProject = runtimeHarness({
    ...STOPPED_CONNECTOR,
    connectorLabels: {
      'com.docker.compose.project': 'not-aegis-prod',
      'com.docker.compose.service': 'public-share-connector',
    },
  })
  try {
    assert.equal(wrongProject.run('--pre-start').status, 1,
      'pre-start must refuse a container from another Compose project')
  } finally { wrongProject.cleanup() }

  const wrongService = runtimeHarness({
    ...STOPPED_CONNECTOR,
    connectorLabels: {
      'com.docker.compose.project': 'aegis-prod',
      'com.docker.compose.service': 'something-else',
    },
  })
  try {
    assert.equal(wrongService.run('--pre-start').status, 1,
      'pre-start must refuse a container for another Compose service')
  } finally { wrongService.cleanup() }

  const noLabels = runtimeHarness({ ...STOPPED_CONNECTOR, connectorLabels: {} })
  try {
    assert.equal(noLabels.run('--pre-start').status, 1,
      'pre-start must refuse a container with no Compose identity labels')
  } finally { noLabels.cleanup() }
})

test('S5.5-LIFECYCLE-PRESTART-EXACT-TOPOLOGY pins the stopped object to its exact identity', () => {
  // A third network on the object that is about to start is a violation.
  for (const extra of ['aegis_public_share_upstream', 'aegis_internal', 'aegis_drive_proxy',
    'aegis_vlan10', 'aegis_vlan10_macvlan', 'bridge', 'monitor_net', 'twingate_net', 'unknown_net']) {
    const h = runtimeHarness({
      ...STOPPED_CONNECTOR,
      connectorNetworks: { ...STOPPED_CONNECTOR.connectorNetworks, [extra]: '10.9.9.9' },
    })
    try {
      assert.equal(h.run('--pre-start').status, 1, `a third network ${extra} must be refused`)
    } finally { h.cleanup() }
  }

  // Exact fixed addresses on the stopped object.
  for (const [label, networks] of Object.entries({
    'wrong edge address': {
      aegis_public_share_edge: '172.31.240.4', aegis_public_share_egress: '172.31.242.2',
    },
    'wrong egress address': {
      aegis_public_share_edge: '172.31.240.3', aegis_public_share_egress: '172.31.242.3',
    },
    'missing egress attachment': { aegis_public_share_edge: '172.31.240.3' },
    'missing edge attachment': { aegis_public_share_egress: '172.31.242.2' },
  })) {
    const h = runtimeHarness({ ...STOPPED_CONNECTOR, connectorNetworks: networks })
    try {
      assert.equal(h.run('--pre-start').status, 1, `${label} must be refused`)
    } finally { h.cleanup() }
  }

  // Host / container networking on the stopped object.
  for (const mode of ['host', 'container:abc123']) {
    const h = runtimeHarness({ ...STOPPED_CONNECTOR, networkMode: mode })
    try {
      assert.equal(h.run('--pre-start').status, 1, `${mode} networking must be refused`)
    } finally { h.cleanup() }
  }
})

test('S5.5-LIFECYCLE-PRESTART-KEEPS-TOKEN-AND-FIREWALL-STRICT', () => {
  // Correction C: the Task 8 credential contract is unchanged.
  for (const statLine of ['directory|0|65532|440', 'symbolic link|0|65532|440',
    'regular file|1000|65532|440', 'regular file|0|0|440', 'regular file|0|65532|444',
    'regular file|0|65532|640']) {
    const h = runtimeHarness({ ...STOPPED_CONNECTOR, tokenStat: statLine })
    try {
      assert.equal(h.run('--pre-start').status, 1, `token metadata '${statLine}' must be refused`)
    } finally { h.cleanup() }
  }
  const missing = runtimeHarness({ ...STOPPED_CONNECTOR, tokenStat: null })
  try {
    assert.equal(missing.run('--pre-start').status, 1, 'a missing token file must be refused')
  } finally { missing.cleanup() }

  // Firewall still gates everything.
  const badFirewall = runtimeHarness({ ...STOPPED_CONNECTOR, firewallRc: 1 })
  try {
    assert.equal(badFirewall.run('--pre-start').status, 1, 'a failing firewall validate must refuse')
  } finally { badFirewall.cleanup() }
})

test('S5.5-LIFECYCLE-UNIT-STARTS-EXISTING never creates or recreates at start time', () => {
  const unit = readFile(nodePath.join(systemdDir, 'aegis-public-share-connector.service'), 'utf8')
  const execStart = unit.split(/\r?\n/).filter((l) => l.startsWith('ExecStart=')).join('\n')
  assert.ok(execStart, 'the connector unit must declare ExecStart')

  // It must START the already-validated container.
  assert.match(execStart, /\bstart public-share-connector\s*$/,
    'ExecStart must start the already-created, already-validated connector')

  // It must never create, recreate or bring anything up.
  for (const [pattern, label] of [
    [/\bup\b/, 'up'],
    [/\bup -d\b/, 'up -d'],
    [/\bcreate\b/, 'create'],
    [/\bdown\b/, 'down'],
    [/\brun\b/, 'run'],
    [/--force-recreate/, '--force-recreate'],
  ]) {
    assert.doesNotMatch(execStart, pattern,
      `ExecStart must not use ${label}: a new object could start unvalidated`)
  }

  // The validated-object guarantee: pre-start still gates, stop stays scoped.
  const pre = unit.split(/\r?\n/).filter((l) => l.startsWith('ExecStartPre=')).join('\n')
  assert.match(pre, /s5-5-runtime-check\.sh --pre-start/, 'pre-start must still gate the start')
  const stop = unit.split(/\r?\n/).filter((l) => l.startsWith('ExecStop=')).join('\n')
  assert.match(stop, /\bstop public-share-connector\s*$/, 'ExecStop stays service-scoped')
  assert.doesNotMatch(stop, /\bdown\b/, 'ExecStop must never tear the stack down')

  // Still the accepted project and all four layers.
  assert.match(execStart, /--project-name aegis-prod\b/)
  for (const layer of ['docker-compose.production.yml', 'drive-s5-3.yml',
    'drive-gateway-s5-4.yml', 'connector-s5-5.yml']) {
    assert.ok(execStart.includes(layer), `ExecStart must keep layer ${layer}`)
  }
})

test('S5.5-LIFECYCLE-RUNBOOK-BOOTSTRAP documents create-stopped before firewall apply', () => {
  const text = readFile(runbookPath, 'utf8')

  // The create-stopped step must exist and be service-scoped.
  assert.match(text, /create[^\n]*public-share-connector|public-share-connector[^\n]*create/,
    'the runbook must document a service-scoped Compose create for the connector')
  assert.match(text, /--project-name aegis-prod/, 'the bootstrap must use the accepted project')

  // Ordering: create-stopped, then prove stopped, then firewall apply.
  const createAt = text.search(/compose[\s\S]{0,400}?\bcreate\b[^\n]*public-share-connector/)
  const applyAt = text.indexOf('s5-5-firewall.sh apply')
  const prestartAt = text.indexOf('s5-5-runtime-check.sh --pre-start')
  assert.notEqual(createAt, -1, 'the runbook must contain the create step')
  assert.notEqual(applyAt, -1, 'the runbook must contain firewall apply')
  assert.ok(createAt < applyAt, 'the connector must be created BEFORE the firewall is applied')
  assert.ok(applyAt < prestartAt, 'the firewall must be applied before pre-start validation')

  // It must prove the stopped state and the materialised egress before applying.
  assert.match(text, /Running=false|State\.Running|\bcreated\b/,
    'the runbook must verify the connector is not running')
  assert.match(text, /network inspect aegis_public_share_egress/,
    'the runbook must verify the egress network now exists')

  // The old first-activation mistake must be explicitly forbidden.
  assert.match(text, /never[\s\S]{0,200}up -d[\s\S]{0,120}public-share-connector|up -d[\s\S]{0,80}public-share-connector[\s\S]{0,200}(never|forbidden|must not)/i,
    'the runbook must forbid first-activation via up -d public-share-connector')
})

// ---------------------------------------------------------------------------
// PRE-S5.5-F FINAL FAIL-CLOSED HARDENING (network metadata)
//
// Membership and fixed IPs were already pinned, but the networks themselves
// were not. An edge network recreated WITHOUT internal:true or without the
// isolated gateway mode would still hold the right members at the right
// addresses while no longer being isolated at all. Both --pre-start and
// --enforce-drift must fail closed on that.
//
// Network IDs and derived br-<id> names are deliberately NOT pinned: they
// legitimately change when a network is recreated.
// ---------------------------------------------------------------------------

const ISOLATED = 'com.docker.network.bridge.gateway_mode_ipv4'

function netDoc({ name, subnet, gateway, internal, options = {}, containers = {}, enableIPv6 = false }) {
  const doc = {
    Name: name,
    Id: 'f'.repeat(64),
    Driver: 'bridge',
    Internal: internal,
    Options: options,
    IPAM: { Config: [{ Subnet: subnet, Gateway: gateway }] },
    Containers: Object.fromEntries(Object.entries(containers).map(([n, ip]) => [
      `id-${n}`, { Name: n, IPv4Address: `${ip}/29` },
    ])),
  }
  if (enableIPv6 !== undefined) {
    doc.EnableIPv6 = enableIPv6
  }
  return [doc]
}

const edgeDoc = (over = {}) => netDoc({
  name: 'aegis_public_share_edge',
  subnet: '172.31.240.0/29',
  gateway: '172.31.240.1',
  internal: true,
  options: { [ISOLATED]: 'isolated' },
  containers: { 'aegis-prod-public-share-gateway-1': '172.31.240.2' },
  ...over,
})
const upstreamDoc = (over = {}) => netDoc({
  name: 'aegis_public_share_upstream',
  subnet: '172.31.241.0/29',
  gateway: '172.31.241.1',
  internal: true,
  options: { [ISOLATED]: 'isolated' },
  containers: {
    'aegis-prod-public-share-gateway-1': '172.31.241.2',
    'aegis-prod-drive-1': '172.31.241.3',
  },
  ...over,
})
const egressDoc = (over = {}) => netDoc({
  name: 'aegis_public_share_egress',
  subnet: '172.31.242.0/29',
  gateway: '172.31.242.1',
  internal: false,
  options: { 'com.docker.network.bridge.name': 'aegis-ps-eg' },
  ...over,
})

const STOPPED = {
  connectorNetworks: {
    aegis_public_share_edge: '172.31.240.3',
    aegis_public_share_egress: '172.31.242.2',
  },
  connectorState: 'created',
}

// Mutate one field of a fixture document.
const mutate = (doc, patch) => [{ ...doc[0], ...patch }]
const withIpam = (doc, subnet, gateway) =>
  [{ ...doc[0], IPAM: { Config: [{ Subnet: subnet, Gateway: gateway }] } }]

test('S5.5-NET-METADATA-EXACT accepts only the canonical topology', () => {
  const h = runtimeHarness({
    ...STOPPED,
    networks: {
      aegis_public_share_edge: edgeDoc(),
      aegis_public_share_upstream: upstreamDoc(),
      aegis_public_share_egress: egressDoc(),
    },
  })
  try {
    const result = h.run('--pre-start')
    assert.equal(result.status, 0,
      `the exact canonical topology must pass: ${result.stdout}${result.stderr}`)
  } finally { h.cleanup() }
})

test('S5.5-NET-EDGE-DRIFT fails closed on any edge metadata drift', () => {
  const drifts = {
    'wrong driver': mutate(edgeDoc(), { Driver: 'macvlan' }),
    'internal false': mutate(edgeDoc(), { Internal: false }),
    'wrong subnet': withIpam(edgeDoc(), '172.31.250.0/29', '172.31.240.1'),
    'wrong gateway': withIpam(edgeDoc(), '172.31.240.0/29', '172.31.240.9'),
    'missing gateway mode': mutate(edgeDoc(), { Options: {} }),
    'wrong gateway mode': mutate(edgeDoc(), { Options: { [ISOLATED]: 'nat' } }),
    'wrong name': mutate(edgeDoc(), { Name: 'somebody_elses_network' }),
  }
  for (const [label, doc] of Object.entries(drifts)) {
    const h = runtimeHarness({ ...STOPPED, networks: { aegis_public_share_edge: doc } })
    try {
      assert.equal(h.run('--pre-start').status, 1, `edge ${label} must fail closed`)
    } finally { h.cleanup() }
  }
})

test('S5.5-NET-UPSTREAM-DRIFT fails closed on any upstream metadata drift', () => {
  const drifts = {
    'wrong driver': mutate(upstreamDoc(), { Driver: 'overlay' }),
    'internal false': mutate(upstreamDoc(), { Internal: false }),
    'wrong subnet': withIpam(upstreamDoc(), '172.31.251.0/29', '172.31.241.1'),
    'wrong gateway': withIpam(upstreamDoc(), '172.31.241.0/29', '172.31.241.9'),
    'missing gateway mode': mutate(upstreamDoc(), { Options: {} }),
    'wrong gateway mode': mutate(upstreamDoc(), { Options: { [ISOLATED]: 'nat' } }),
  }
  for (const [label, doc] of Object.entries(drifts)) {
    const h = runtimeHarness({ ...STOPPED, networks: { aegis_public_share_upstream: doc } })
    try {
      assert.equal(h.run('--pre-start').status, 1, `upstream ${label} must fail closed`)
    } finally { h.cleanup() }
  }
})

test('S5.5-NET-EGRESS-DRIFT fails closed on any egress metadata drift', () => {
  const drifts = {
    'wrong driver': mutate(egressDoc(), { Driver: 'macvlan' }),
    'internal true': mutate(egressDoc(), { Internal: true }),
    'wrong subnet': withIpam(egressDoc(), '172.31.243.0/29', '172.31.242.1'),
    'wrong gateway': withIpam(egressDoc(), '172.31.242.0/29', '172.31.242.9'),
    'missing bridge name': mutate(egressDoc(), { Options: {} }),
    'wrong bridge name': mutate(egressDoc(), { Options: { 'com.docker.network.bridge.name': 'br-other' } }),
    'wrong name': mutate(egressDoc(), { Name: 'aegis_public_share_egress_v2' }),
  }
  for (const [label, doc] of Object.entries(drifts)) {
    const h = runtimeHarness({ ...STOPPED, networks: { aegis_public_share_egress: doc } })
    try {
      assert.equal(h.run('--pre-start').status, 1, `egress ${label} must fail closed`)
    } finally { h.cleanup() }
  }
})

test('S5.5-NET-DRIFT-MODE-ENFORCES-METADATA stops the connector on topology drift', () => {
  // The same metadata contract must hold for the running connector, not just at
  // start: a network recreated without isolation is drift.
  for (const [label, networks] of Object.entries({
    'edge lost isolation': { aegis_public_share_edge: mutate(edgeDoc(), { Internal: false }) },
    'upstream lost isolation': { aegis_public_share_upstream: mutate(upstreamDoc(), { Options: {} }) },
    'egress became internal': { aegis_public_share_egress: mutate(egressDoc(), { Internal: true }) },
  })) {
    const h = runtimeHarness({
      ...STOPPED, connectorState: 'running', connectorRunning: true, networks,
    })
    try {
      const result = h.run('--enforce-drift')
      assert.notEqual(result.status, 0, `${label} must be detected as drift`)
      assert.match(h.systemctlCalls(), /stop aegis-public-share-connector\.service/,
        `${label} must stop the connector`)
    } finally { h.cleanup() }
  }
})

test('S5.5-NET-IDS-NOT-PINNED network ids and derived bridges are never hard-coded', () => {
  const code = readFile(runtimeCheck, 'utf8')
  // A recreated network legitimately gets a new id and a new br-<id>.
  assert.doesNotMatch(code, /c76a975802719cac|a96e511142c99f2d/,
    'measured network ids must never be embedded')
  assert.doesNotMatch(code, /br-c76a97580271|br-a96e511142c9/,
    'derived bridge names must never be embedded')
})

test('S5.5-NET-EDGE-IPV6-FAIL-CLOSED edge network must explicitly require EnableIPv6=false', () => {
  // 1. Explicit EnableIPv6: false is accepted by pre-start
  const happyEdge = edgeDoc({ enableIPv6: false })
  const hHappy = runtimeHarness({
    ...STOPPED,
    networks: {
      aegis_public_share_edge: happyEdge,
      aegis_public_share_upstream: upstreamDoc(),
      aegis_public_share_egress: egressDoc(),
    },
  })
  try {
    const res = hHappy.run('--pre-start')
    assert.equal(res.status, 0, `explicit EnableIPv6: false must pass pre-start: ${res.stderr}`)
  } finally { hHappy.cleanup() }

  // 2. EnableIPv6: true must fail pre-start
  const trueEdge = edgeDoc({ enableIPv6: true })
  const hTrue = runtimeHarness({
    ...STOPPED,
    networks: {
      aegis_public_share_edge: trueEdge,
      aegis_public_share_upstream: upstreamDoc(),
      aegis_public_share_egress: egressDoc(),
    },
  })
  try {
    const result = hTrue.run('--pre-start')
    assert.equal(result.status, 1, 'EnableIPv6: true must fail pre-start')
    assert.match(result.stderr, /EnableIPv6=false/, 'failure message must explain EnableIPv6=false requirement')
  } finally { hTrue.cleanup() }

  // 3. Missing EnableIPv6 must fail pre-start (invariant cannot be proven)
  const missingDoc = edgeDoc()
  delete missingDoc[0].EnableIPv6
  const hMissing = runtimeHarness({
    ...STOPPED,
    networks: {
      aegis_public_share_edge: missingDoc,
      aegis_public_share_upstream: upstreamDoc(),
      aegis_public_share_egress: egressDoc(),
    },
  })
  try {
    const result = hMissing.run('--pre-start')
    assert.equal(result.status, 1, 'missing EnableIPv6 must fail closed')
    assert.match(result.stderr, /explicitly report EnableIPv6/, 'failure message must explain explicit presence requirement')
  } finally { hMissing.cleanup() }

  // 4. Drift enforcement must stop the connector if edge has EnableIPv6: true
  const hDriftTrue = runtimeHarness({
    ...STOPPED,
    connectorState: 'running',
    connectorRunning: true,
    networks: {
      aegis_public_share_edge: trueEdge,
      aegis_public_share_upstream: upstreamDoc(),
      aegis_public_share_egress: egressDoc(),
    },
  })
  try {
    const result = hDriftTrue.run('--enforce-drift')
    assert.notEqual(result.status, 0, 'EnableIPv6: true must be detected as drift')
    assert.match(hDriftTrue.systemctlCalls(), /stop aegis-public-share-connector\.service/,
      'EnableIPv6: true drift must stop the connector')
  } finally { hDriftTrue.cleanup() }

  // 5. Drift enforcement must stop the connector if edge EnableIPv6 is missing
  const hDriftMissing = runtimeHarness({
    ...STOPPED,
    connectorState: 'running',
    connectorRunning: true,
    networks: {
      aegis_public_share_edge: missingDoc,
      aegis_public_share_upstream: upstreamDoc(),
      aegis_public_share_egress: egressDoc(),
    },
  })
  try {
    const result = hDriftMissing.run('--enforce-drift')
    assert.notEqual(result.status, 0, 'missing EnableIPv6 must be detected as drift')
    assert.match(hDriftMissing.systemctlCalls(), /stop aegis-public-share-connector\.service/,
      'missing EnableIPv6 drift must stop the connector')
  } finally { hDriftMissing.cleanup() }
})

// ---------------------------------------------------------------------------
// Production-discovered (2026-09-12): a STOPPED connector carries its static
// addresses only in NetworkSettings.Networks.<net>.IPAMConfig.IPv4Address; the
// live IPAddress / Gateway / EndpointID fields are empty until it runs. The
// pre-start gate validates a stopped object, so it must read the configured
// address. Drift enforcement validates a running object and must keep reading
// the live address with no fallback to configured intent.
// ---------------------------------------------------------------------------

const PRODUCTION_STOPPED_NETWORKS = {
  aegis_public_share_edge: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.240.3' } },
  aegis_public_share_egress: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.242.2' } },
}

test('S5.5-PRESTART-STOPPED-IPAM pre-start accepts stopped connector whose static addresses are retained in IPAMConfig while live IPAddress fields are empty', () => {
  for (const state of ['created', 'exited']) {
    const h = runtimeHarness({
      ...STOPPED_CONNECTOR, connectorState: state, connectorNetworks: PRODUCTION_STOPPED_NETWORKS,
    })
    try {
      const r = h.run('--pre-start')
      assert.equal(r.status, 0, `${state}: stopped connector with configured static addresses must pass pre-start; stderr=${r.stderr}`)
      assert.match(r.stdout, /S5\.5-RUNTIME=PRESTART-OK/)
      assert.doesNotMatch(r.stderr, /connector must hold/)
    } finally { h.cleanup() }
  }
})

test('S5.5-PRESTART-STOPPED-IPAM negative: stopped connector with wrong or missing configured address is refused', () => {
  const cases = {
    'wrong configured edge address': {
      aegis_public_share_edge: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.240.4' } },
      aegis_public_share_egress: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.242.2' } },
    },
    'wrong configured egress address': {
      aegis_public_share_edge: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.240.3' } },
      aegis_public_share_egress: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.242.3' } },
    },
    'missing IPAMConfig on edge': {
      aegis_public_share_edge: { IPAddress: '' },
      aegis_public_share_egress: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.242.2' } },
    },
    'missing IPv4Address inside IPAMConfig on egress': {
      aegis_public_share_edge: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.240.3' } },
      aegis_public_share_egress: { IPAddress: '', IPAMConfig: {} },
    },
    'IPAMConfig null on both': {
      aegis_public_share_edge: { IPAddress: '', IPAMConfig: null },
      aegis_public_share_egress: { IPAddress: '', IPAMConfig: null },
    },
  }
  for (const [label, networks] of Object.entries(cases)) {
    const h = runtimeHarness({ ...STOPPED_CONNECTOR, connectorNetworks: networks })
    try {
      const r = h.run('--pre-start')
      assert.equal(r.status, 1, `${label} must be refused`)
      assert.match(r.stderr, /connector must hold 172\.31\.24[02]\.[23] on aegis_public_share_(edge|egress) \(configured IPAMConfig\.IPv4Address\)/,
        `${label}: refusal must name the configured-address evidence`)
      assert.match(r.stderr, /PRESTART-REFUSED/)
    } finally { h.cleanup() }
  }

  // A live IPAddress on a stopped object is NOT a substitute for the configured
  // address: pre-start reads configured intent only.
  const hLiveOnly = runtimeHarness({
    ...STOPPED_CONNECTOR,
    connectorNetworks: {
      aegis_public_share_edge: { IPAddress: '172.31.240.3' },
      aegis_public_share_egress: { IPAddress: '172.31.242.2' },
    },
  })
  try {
    const r = hLiveOnly.run('--pre-start')
    assert.equal(r.status, 1, 'a stopped object without configured addresses must be refused even if live fields are populated')
  } finally { hLiveOnly.cleanup() }
})

test('S5.5-PRESTART-STOPPED-IPAM negative: stopped connector with a forbidden third network is refused even with exact configured addresses', () => {
  for (const extra of ['aegis_public_share_upstream', 'aegis_internal', 'aegis_drive_proxy',
    'aegis_vlan10', 'aegis_vlan10_macvlan', 'bridge', 'monitor_net', 'twingate_net']) {
    const h = runtimeHarness({
      ...STOPPED_CONNECTOR,
      connectorNetworks: {
        ...PRODUCTION_STOPPED_NETWORKS,
        [extra]: { IPAddress: '', IPAMConfig: { IPv4Address: '10.9.9.9' } },
      },
    })
    try {
      const r = h.run('--pre-start')
      assert.equal(r.status, 1, `third network ${extra} must be refused`)
      assert.match(r.stderr, /connector attachments must be exactly \[aegis_public_share_edge aegis_public_share_egress\]/)
    } finally { h.cleanup() }
  }

  // Networks missing or malformed entirely: fail closed, never pass.
  for (const [label, opts] of Object.entries({
    'no networks object': { connectorNetworks: {} },
  })) {
    const h = runtimeHarness({ ...STOPPED_CONNECTOR, ...opts })
    try {
      assert.equal(h.run('--pre-start').status, 1, `${label} must be refused`)
    } finally { h.cleanup() }
  }
})

test('S5.5-DRIFT-LIVE-IP drift keeps validating the live IPAddress and never falls back to IPAMConfig', () => {
  const RUNNING = { ...STOPPED_CONNECTOR, connectorState: 'running', connectorRunning: true }

  // Baseline: running connector with correct live and configured addresses is OK.
  const hOk = runtimeHarness({
    ...RUNNING,
    connectorNetworks: {
      aegis_public_share_edge: { IPAddress: '172.31.240.3', IPAMConfig: { IPv4Address: '172.31.240.3' } },
      aegis_public_share_egress: { IPAddress: '172.31.242.2', IPAMConfig: { IPv4Address: '172.31.242.2' } },
    },
  })
  try {
    const r = hOk.run('--enforce-drift')
    assert.equal(r.status, 0, `running connector with exact live addresses must pass drift; stderr=${r.stderr}`)
    assert.doesNotMatch(hOk.systemctlCalls(), /stop/)
  } finally { hOk.cleanup() }

  // Configured intent correct but live address wrong => drift, connector stopped.
  const hWrong = runtimeHarness({
    ...RUNNING,
    connectorNetworks: {
      aegis_public_share_edge: { IPAddress: '172.31.240.9', IPAMConfig: { IPv4Address: '172.31.240.3' } },
      aegis_public_share_egress: { IPAddress: '172.31.242.2', IPAMConfig: { IPv4Address: '172.31.242.2' } },
    },
  })
  try {
    const r = hWrong.run('--enforce-drift')
    assert.equal(r.status, 1, 'wrong live edge address must be drift even when IPAMConfig is correct')
    assert.match(r.stderr, /connector must hold 172\.31\.240\.3 on aegis_public_share_edge \(live IPAddress\)/)
    assert.match(hWrong.systemctlCalls(), /stop aegis-public-share-connector\.service/)
  } finally { hWrong.cleanup() }

  // Configured intent correct but live address EMPTY => drift, connector stopped.
  // (A missing live endpoint on a running object is a broken attachment, not intent.)
  const hEmpty = runtimeHarness({
    ...RUNNING,
    connectorNetworks: {
      aegis_public_share_edge: { IPAddress: '172.31.240.3', IPAMConfig: { IPv4Address: '172.31.240.3' } },
      aegis_public_share_egress: { IPAddress: '', IPAMConfig: { IPv4Address: '172.31.242.2' } },
    },
  })
  try {
    const r = hEmpty.run('--enforce-drift')
    assert.equal(r.status, 1, 'empty live egress address must be drift even when IPAMConfig is correct')
    assert.match(r.stderr, /connector must hold 172\.31\.242\.2 on aegis_public_share_egress \(live IPAddress\)/)
    assert.match(hEmpty.systemctlCalls(), /stop aegis-public-share-connector\.service/)
  } finally { hEmpty.cleanup() }

  // Live address absent entirely (field missing) => drift.
  const hAbsent = runtimeHarness({
    ...RUNNING,
    connectorNetworks: {
      aegis_public_share_edge: { IPAMConfig: { IPv4Address: '172.31.240.3' } },
      aegis_public_share_egress: { IPAMConfig: { IPv4Address: '172.31.242.2' } },
    },
  })
  try {
    assert.equal(hAbsent.run('--enforce-drift').status, 1, 'absent live address fields must be drift')
  } finally { hAbsent.cleanup() }
})
