// PUBLIC-SHARE-7 S5.5-D: firewall semantic / model contract.
//
// These tests never touch a real firewall, a real Docker daemon, or Production.
// `apply`, `validate` and `remove` are exercised against a disposable mock
// iptables that keeps its rule table in a temp file, and a mock
// `docker network inspect` that returns fixture JSON. Nothing here requires
// root, and no rule is ever installed on this workstation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const production = fileURLToPath(new URL('../../gateway/public-share/production/', import.meta.url))
const script = path.join(production, 's5-5-firewall.sh')
const allowlistPath = path.join(production, 'cloudflare-endpoints.json')
const shell = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'

const source = () => readFileSync(script, 'utf8')
// Static scans target executable lines. Comments are documentation, not
// directives, and must be free to name the things the script deliberately avoids.
const effectiveSource = () => source()
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')
const allowlist = () => JSON.parse(readFileSync(allowlistPath, 'utf8'))

const EGRESS_CHAIN = 'AEGIS-PS-EGRESS'
const INPUT_CHAIN = 'AEGIS-PS-INPUT'
const CONNECTOR_EDGE = '172.31.240.3/32'
const CONNECTOR_EGRESS = '172.31.242.2/32'
const GATEWAY_EDGE = '172.31.240.2/32'
const EGRESS_BRIDGE = 'aegis-ps-eg'
// Measured Production evidence only. The resolver must derive this, never embed it.
//
// Read-only preflight measured the edge bridge as br-c76a97580271 and the
// upstream bridge as br-a96e511142c9. Both carry NO IPv4 host address (IPv6
// link-local only; internal=true, gateway_mode_ipv4=isolated), so 172.31.240.1
// is a DESIGNED address and NOT a current Production host-local bridge gateway.
// aegis_public_share_egress is still ABSENT, so 172.31.242.1 and the bridge
// aegis-ps-eg are DESIGNED FUTURE topology targets, not measured runtime facts.
//
// Measured host listeners: 192.168.10.10 on 22/80/443, 172.18.0.1:18077, and
// the resolver stubs 127.0.0.53:53 / 127.0.0.54:53. TCP 2375, 2376, 5432, 8001,
// 8080 and 7844 were NOT observed listening - which is not a claim that the
// Docker API is absent, only that those TCP ports were not listening.
const EDGE_NETWORK_ID = 'c76a975802719cac673e9c4a9ed6d39eb1cd5820d90dcee8e4dfca590a40db50'
const DERIVED_EDGE_BRIDGE = 'br-c76a97580271'

// ---------------------------------------------------------------------------
// Disposable mock harness
// ---------------------------------------------------------------------------

const MOCK_IPTABLES = `#!/usr/bin/env bash
# Disposable mock iptables. Keeps rules in \$MOCK_STATE; touches no real firewall.
set -u
state="\$MOCK_STATE"
: > "\$state.lock" 2>/dev/null || true
touch "\$state"
args=()
while [ \$# -gt 0 ]; do
  case "\$1" in
    -t) shift 2 ;;
    -w|--wait) shift ;;
    *) args+=("\$1"); shift ;;
  esac
done
op="\${args[0]:-}"
chain="\${args[1]:-}"
rest=("\${args[@]:2}")
pos=""
if [ "\$op" = "-I" ] && [ "\${#rest[@]}" -gt 0 ] && [[ "\${rest[0]}" =~ ^[0-9]+\$ ]]; then
  pos="\${rest[0]}"; rest=("\${rest[@]:1}")
fi
rule="\${rest[*]:-}"
chain_exists() { grep -qxF "CHAIN|\$chain" "\$state"; }
case "\$op" in
  -N)
    if chain_exists; then echo "iptables: Chain already exists." >&2; exit 1; fi
    echo "CHAIN|\$chain" >> "\$state"; exit 0 ;;
  -X)
    if ! chain_exists; then echo "iptables: No chain/target/match by that name." >&2; exit 1; fi
    grep -vxF "CHAIN|\$chain" "\$state" | grep -v "^RULE|\$chain|" > "\$state.tmp" || true
    mv "\$state.tmp" "\$state"; exit 0 ;;
  -F)
    if ! chain_exists; then echo "iptables: No chain/target/match by that name." >&2; exit 1; fi
    grep -v "^RULE|\$chain|" "\$state" > "\$state.tmp" || true
    mv "\$state.tmp" "\$state"; exit 0 ;;
  -C)
    if ! chain_exists; then exit 1; fi
    grep -qxF "RULE|\$chain|\$rule" "\$state" && exit 0 || exit 1 ;;
  -A)
    if ! chain_exists; then echo "iptables: No chain by that name." >&2; exit 1; fi
    echo "RULE|\$chain|\$rule" >> "\$state"; exit 0 ;;
  -I)
    if ! chain_exists; then echo "iptables: No chain by that name." >&2; exit 1; fi
    awk -v line="RULE|\$chain|\$rule" -v ch="RULE|\$chain|" '
      BEGIN { done=0 }
      { if (!done && index(\$0, ch)==1) { print line; done=1 } print }
      END { if (!done) print line }
    ' "\$state" > "\$state.tmp"; mv "\$state.tmp" "\$state"; exit 0 ;;
  -D)
    grep -vxF "RULE|\$chain|\$rule" "\$state" > "\$state.tmp" || true
    mv "\$state.tmp" "\$state"; exit 0 ;;
  -S)
    if [ -n "\$chain" ]; then
      chain_exists || { echo "iptables: No chain/target/match by that name." >&2; exit 1; }
      echo "-N \$chain"
      grep "^RULE|\$chain|" "\$state" | while IFS='|' read -r _ c r; do echo "-A \$c \$r"; done
      exit 0
    fi
    grep "^CHAIN|" "\$state" | while IFS='|' read -r _ c; do echo "-N \$c"; done
    grep "^RULE|" "\$state" | while IFS='|' read -r _ c r; do echo "-A \$c \$r"; done
    exit 0 ;;
  --version|-V)
    cat "\$MOCK_IPTABLES_VERSION_FILE"; exit 0 ;;
  *)
    echo "mock iptables: unsupported operation \$op" >&2; exit 2 ;;
esac
`

const MOCK_DOCKER = `#!/usr/bin/env bash
# Disposable mock docker: fixture JSON for 'network inspect', container state for
# 'inspect', plus a failure mode that is NOT "no such object".
set -u
if [ "\${1:-}" = "network" ]; then cat "\$MOCK_DOCKER_JSON"; exit 0; fi
if [ "\${1:-}" = "inspect" ]; then
  if [ "\${MOCK_DOCKER_MODE:-ok}" = "error" ]; then
    echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2
    exit 1
  fi
  if [ ! -f "\$MOCK_CONNECTOR_JSON" ]; then
    echo "Error response from daemon: No such object: \${2:-}" >&2
    exit 1
  fi
  cat "\$MOCK_CONNECTOR_JSON"; exit 0
fi
exit 0
`

function harness(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aegis-s55-fw-'))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const sysfs = path.join(root, 'sys-class-net')
  mkdirSync(sysfs)

  const iptables = path.join(bin, 'iptables')
  const docker = path.join(bin, 'docker')
  writeFileSync(iptables, MOCK_IPTABLES, { mode: 0o755 })
  writeFileSync(docker, MOCK_DOCKER, { mode: 0o755 })

  const state = path.join(root, 'iptables-state')
  // Seed the builtin chains the Production baseline already has. A scenario may
  // omit one to model a host that is not ready for S5.5.
  const omit = options.omitChains ?? []
  const seeded = ['INPUT', 'FORWARD', 'DOCKER-USER', 'DOCKER-FORWARD']
    .filter((chain) => !omit.includes(chain))
    .map((chain) => 'CHAIN|' + chain)
    .join('\n')
  writeFileSync(state, seeded + '\n')

  const bridgeName = options.bridgeName ?? null
  const networkId = options.networkId ?? EDGE_NETWORK_ID
  const dockerJson = path.join(root, 'network.json')
  writeFileSync(dockerJson, JSON.stringify([{
    Name: 'aegis_public_share_edge',
    Id: networkId,
    Driver: 'bridge',
    Options: bridgeName ? { 'com.docker.network.bridge.name': bridgeName } : {},
  }]))

  // The interfaces the firewall expects to exist on the host.
  const present = options.interfaces
    ?? [bridgeName ?? `br-${networkId.slice(0, 12)}`, EGRESS_BRIDGE]
  for (const iface of present) mkdirSync(path.join(sysfs, iface), { recursive: true })

  // Backend string lives in a file so a scenario can change it mid-test.
  const versionFile = path.join(root, 'iptables-version')
  writeFileSync(versionFile, (options.iptablesVersion ?? 'iptables v1.8.11 (nf_tables)') + '\n')

  // Connector fixture. Present and stopped unless the scenario says otherwise;
  // absent models a rolled-back or never-created connector.
  const connectorJson = path.join(root, 'connector.json')
  if (!options.connectorAbsent) {
    const cstate = options.connectorState ?? 'exited'
    writeFileSync(connectorJson, JSON.stringify([{
      Name: '/aegis-prod-public-share-connector-1',
      State: {
        Status: cstate,
        Running: cstate === 'running',
        Restarting: cstate === 'restarting',
        Paused: cstate === 'paused',
        Dead: cstate === 'dead',
      },
      Config: {
        Labels: options.connectorLabels ?? {
          'com.docker.compose.project': 'aegis-prod',
          'com.docker.compose.service': 'public-share-connector',
        },
      },
    }]))
  }

  const env = {
    ...process.env,
    MSYS_NO_PATHCONV: '1',
    MOCK_STATE: state,
    MOCK_IPTABLES_VERSION_FILE: versionFile,
    MOCK_DOCKER_JSON: dockerJson,
    MOCK_CONNECTOR_JSON: connectorJson,
    MOCK_DOCKER_MODE: options.dockerError ? 'error' : 'ok',
    AEGIS_IPTABLES_BIN: iptables,
    AEGIS_DOCKER_BIN: docker,
    AEGIS_SYSFS_NET: sysfs,
    AEGIS_ENDPOINTS_FILE: options.endpointsFile ?? allowlistPath,
  }

  const run = (...args) => spawnSync(shell, [script, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  })
  const rules = (chain) => readFileSync(state, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`RULE|${chain}|`))
    .map((line) => line.slice(`RULE|${chain}|`.length))
  const chains = () => readFileSync(state, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('CHAIN|'))
    .map((line) => line.slice('CHAIN|'.length))
  const rawState = () => readFileSync(state, 'utf8')
  // Firewall state is the set of chains and each chain's ordered rules. The
  // order of lines in the mock's backing file is an artifact, not policy.
  const snapshot = () => {
    const lines = readFileSync(state, 'utf8').split('\n').filter(Boolean)
    const chainList = lines.filter((l) => l.startsWith('CHAIN|')).map((l) => l.slice(6)).sort()
    const perChain = {}
    for (const line of lines) {
      if (!line.startsWith('RULE|')) continue
      const sep = line.indexOf('|', 5)
      const chain = line.slice(5, sep)
      ;(perChain[chain] ??= []).push(line.slice(sep + 1))
    }
    return { chains: chainList, rules: perChain }
  }
  const writeState = (text) => writeFileSync(state, text)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  const setBackend = (version) => writeFileSync(versionFile, version + '\n')
  return { run, rules, chains, rawState, snapshot, writeState, setBackend, cleanup, root, env }
}

const expectedEgressRules = () => {
  const { endpoints } = allowlist()
  return [
    `-d ${CONNECTOR_EDGE} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
    `-d ${CONNECTOR_EGRESS} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
    `-s ${CONNECTOR_EDGE} -d ${GATEWAY_EDGE} -p tcp --dport 8080 -j ACCEPT`,
    ...endpoints.map((ep) => `-s ${CONNECTOR_EGRESS} -d ${ep} -p tcp --dport 7844 -j ACCEPT`),
    `-s ${CONNECTOR_EDGE} -j DROP`,
    `-s ${CONNECTOR_EGRESS} -j DROP`,
  ]
}

// ---------------------------------------------------------------------------
// Static source contract
// ---------------------------------------------------------------------------

test('FIREWALL-CHAIN-NAMES the script owns exactly the two S5.5 chains', () => {
  const text = source()
  assert.match(text, /^#!\/usr\/bin\/env bash$/m, 'must use the env bash shebang')
  assert.match(text, /^set -euo pipefail$/m, 'must fail closed on error and unset vars')
  assert.match(text, new RegExp(EGRESS_CHAIN), 'must declare the egress chain')
  assert.match(text, new RegExp(INPUT_CHAIN), 'must declare the host input chain')
})

test('FIREWALL-SUBCOMMANDS apply, validate and remove are supported', () => {
  const h = harness()
  try {
    for (const sub of ['apply', 'validate', 'remove']) {
      const result = h.run(sub, '--help')
      assert.notEqual(result.status, 127, `${sub} must be a recognised subcommand`)
    }
    const unknown = h.run('definitely-not-a-subcommand')
    assert.notEqual(unknown.status, 0, 'an unknown subcommand must fail closed')
  } finally { h.cleanup() }
})

test('FIREWALL-NO-GLOBAL-FLUSH the script never flushes shared chains', () => {
  const text = effectiveSource()
  // Flushing or policy-setting a shared chain would take down unrelated traffic.
  assert.doesNotMatch(text, /-F\s+INPUT\b/, 'must never flush INPUT')
  assert.doesNotMatch(text, /-F\s+FORWARD\b/, 'must never flush FORWARD')
  assert.doesNotMatch(text, /-F\s+DOCKER-USER\b/, 'must never flush DOCKER-USER')
  assert.doesNotMatch(text, /-F\s+DOCKER-FORWARD\b/, 'must never flush Docker chains')
  assert.doesNotMatch(text, /iptables[^\n]*\s-F\s*$/m, 'must never flush every chain')
  assert.doesNotMatch(text, /-P\s+(INPUT|FORWARD|OUTPUT)\b/, 'must never set a builtin policy')
  assert.doesNotMatch(text, /\bufw\b/i, 'must never drive UFW')
  assert.doesNotMatch(text, /iptables-restore/, 'must never restore a whole ruleset')
})

test('FIREWALL-BRIDGE-RESOLUTION is dynamic and never hard-coded', () => {
  const text = effectiveSource()
  // A Docker network name is not a Linux interface name.
  assert.doesNotMatch(text, /-i\s+aegis_public_share_edge/,
    'the Docker network name must never be used as an interface')
  assert.doesNotMatch(text, new RegExp(`-i\\s+${DERIVED_EDGE_BRIDGE}`),
    'the observed edge bridge must never be hard-coded')
  assert.doesNotMatch(text, new RegExp(`["'\\s]${DERIVED_EDGE_BRIDGE}["'\\s]`),
    'the observed edge bridge name must not appear as a literal default')
  // Resolution must actually call `network inspect` on the edge network. The
  // network name may be held in a variable, so assert both facts, not one line.
  assert.match(text, /network\s+inspect/, 'the edge bridge must come from docker network inspect')
  assert.match(text, /aegis_public_share_edge/, 'the edge network must be named')
  assert.match(text, /com\.docker\.network\.bridge\.name/,
    'an explicitly configured bridge name must be honoured')
  assert.match(text, /br-|slice\(0,\s*12\)|:0:12/,
    'the bridge must otherwise be derived from the first 12 chars of the network id')
  // The egress bridge is explicitly configured, so it is stable and allowed.
  assert.match(text, new RegExp(EGRESS_BRIDGE), 'the stable egress bridge may be used directly')
})

test('FIREWALL-ALLOWLIST-CONSUMPTION reads endpoints instead of embedding them', () => {
  const text = effectiveSource()
  assert.match(text, /cloudflare-endpoints\.json/, 'must consume the reviewed allowlist artifact')
  // No endpoint literal may be baked into the script.
  for (const endpoint of allowlist().endpoints) {
    assert.equal(text.includes(endpoint.replace('/32', '')), false,
      `${endpoint} must come from the allowlist, not from a literal in the script`)
  }

  // Detecting a forbidden transport is allowed; emitting one as an ACCEPT is not.
  const accepts = text.split(/\r?\n/).filter((line) => /ACCEPT/.test(line))
  for (const line of accepts) {
    assert.doesNotMatch(line, /--dport\s+443\b/, `TCP/443 must never be accepted: ${line.trim()}`)
    assert.doesNotMatch(line, /-p\s+udp/, `UDP must never be accepted: ${line.trim()}`)
    assert.doesNotMatch(line, /-d\s+0\.0\.0\.0\/0/, `no broad Internet accept: ${line.trim()}`)
  }
  // The only accepted destination port for the tunnel is 7844 over TCP.
  assert.match(text, /TUNNEL_PORT=['"]?7844/, 'the tunnel port must be pinned to 7844')
})

// ---------------------------------------------------------------------------
// Functional apply / validate / remove against the mock
// ---------------------------------------------------------------------------

test('FIREWALL-APPLY builds the exact egress policy in order', () => {
  const h = harness()
  try {
    const result = h.run('apply')
    assert.equal(result.status, 0, `apply failed: ${result.stdout}${result.stderr}`)
    assert.deepEqual(h.rules(EGRESS_CHAIN), expectedEgressRules(),
      'the egress chain must match the reviewed policy exactly and in order')

    const egress = h.rules(EGRESS_CHAIN)
    assert.equal(egress[0].includes('ESTABLISHED,RELATED'), true, 'return-direction accepts come first')
    assert.match(egress[0], /^-d /, 'the first rule must be destination-scoped, never a blanket accept')
    assert.equal(egress.at(-2), `-s ${CONNECTOR_EDGE} -j DROP`, 'terminal deny for the edge address')
    assert.equal(egress.at(-1), `-s ${CONNECTOR_EGRESS} -j DROP`, 'terminal deny for the egress address')
  } finally { h.cleanup() }
})

test('FIREWALL-ANCHOR-JUMPS DOCKER-USER and INPUT jump first', () => {
  const h = harness()
  try {
    // Seed the traversal the Production baseline already has: DOCKER-USER ->
    // DOCKER-FORWARD, and UFW's chains hanging off INPUT. Our anchors must land
    // ahead of both, or a permissive UFW rule could be evaluated first.
    h.writeState(h.rawState()
      + 'CHAIN|ufw-before-input\n'
      + 'CHAIN|ufw-after-input\n'
      + 'RULE|DOCKER-USER|-j DOCKER-FORWARD\n'
      + 'RULE|INPUT|-j ufw-before-input\n'
      + 'RULE|INPUT|-j ufw-after-input\n')

    assert.equal(h.run('apply').status, 0)
    const dockerUser = h.rules('DOCKER-USER')
    assert.equal(dockerUser.indexOf(`-j ${EGRESS_CHAIN}`) < dockerUser.indexOf('-j DOCKER-FORWARD'), true,
      'the egress anchor must precede Docker forwarding')

    const seededInput = h.rules('INPUT')
    assert.equal(seededInput.indexOf(`-j ${INPUT_CHAIN}`) < seededInput.indexOf('-j ufw-before-input'), true,
      'the input anchor must precede the existing UFW chains')
    assert.equal(seededInput.includes('-j ufw-before-input'), true, 'UFW chains must be preserved')
    assert.equal(seededInput.includes('-j ufw-after-input'), true, 'UFW chains must be preserved')
    assert.equal(dockerUser[0], `-j ${EGRESS_CHAIN}`,
      'the egress anchor must be first in DOCKER-USER, before Docker forwarding')
    assert.equal(dockerUser.filter((r) => r === `-j ${EGRESS_CHAIN}`).length, 1,
      'exactly one egress anchor')

    const input = h.rules('INPUT')
    assert.equal(input[0], `-j ${INPUT_CHAIN}`, 'the input anchor must be first in INPUT')
    assert.equal(input.filter((r) => r === `-j ${INPUT_CHAIN}`).length, 1,
      'exactly one input anchor')
  } finally { h.cleanup() }
})

test('FIREWALL-APPLY-IDEMPOTENT repeated applies converge', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const first = h.snapshot()
    assert.equal(h.run('apply').status, 0)
    assert.equal(h.run('apply').status, 0)
    const third = h.snapshot()
    assert.deepEqual(third, first, 'apply must converge: same chains, same ordered rules')

    // The real idempotency risk is silent accumulation.
    for (const [chain, rules] of Object.entries(third.rules)) {
      assert.deepEqual([...new Set(rules)], rules, `${chain} must not accumulate duplicate rules`)
    }
    assert.equal(third.rules['DOCKER-USER'].filter((r) => r.includes('AEGIS-PS')).length, 1,
      'exactly one S5.5 anchor may remain in DOCKER-USER')
    assert.equal(third.rules['INPUT'].filter((r) => r.includes('AEGIS-PS')).length, 1,
      'exactly one S5.5 anchor may remain in INPUT')
    // No staging chain may survive a completed apply.
    assert.equal(third.chains.some((c) => c.endsWith('-NEW')), false, 'no staging chain may leak')
    assert.equal(h.run('validate').status, 0, 'validate must pass after repeated applies')
  } finally { h.cleanup() }
})

test('FIREWALL-VALIDATE passes only on the complete policy', () => {
  const h = harness()
  try {
    assert.equal(h.run('validate').status, 1, 'validate must fail before apply')
    assert.equal(h.run('apply').status, 0)
    const ok = h.run('validate')
    assert.equal(ok.status, 0, `validate should pass: ${ok.stdout}${ok.stderr}`)
  } finally { h.cleanup() }
})

test('FIREWALL-VALIDATE-FAIL-CLOSED detects every drift class', () => {
  const drifts = {
    'missing custom chain': (s) => s.replace(`CHAIN|${EGRESS_CHAIN}\n`, ''),
    'missing anchor': (s) => s.replace(`RULE|DOCKER-USER|-j ${EGRESS_CHAIN}\n`, ''),
    'missing input anchor': (s) => s.replace(`RULE|INPUT|-j ${INPUT_CHAIN}\n`, ''),
    'duplicate anchor': (s) => s.replace(
      `RULE|DOCKER-USER|-j ${EGRESS_CHAIN}\n`,
      `RULE|DOCKER-USER|-j ${EGRESS_CHAIN}\nRULE|DOCKER-USER|-j ${EGRESS_CHAIN}\n`,
    ),
    'wrong anchor order': (s) => s.replace(
      `RULE|DOCKER-USER|-j ${EGRESS_CHAIN}\n`, '',
    ).replace('CHAIN|DOCKER-FORWARD\n',
      `CHAIN|DOCKER-FORWARD\nRULE|DOCKER-USER|-j DOCKER-FORWARD\nRULE|DOCKER-USER|-j ${EGRESS_CHAIN}\n`),
    'missing terminal deny': (s) => s.replace(`RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EGRESS} -j DROP\n`, ''),
    'unauthorized endpoint': (s) => s.replace(
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EGRESS} -j DROP\n`,
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EGRESS} -d 203.0.113.9/32 -p tcp --dport 7844 -j ACCEPT\n`
      + `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EGRESS} -j DROP\n`,
    ),
    'tcp/443 allowed': (s) => s.replace(
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EDGE} -j DROP\n`,
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EGRESS} -p tcp --dport 443 -j ACCEPT\n`
      + `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EDGE} -j DROP\n`,
    ),
    'udp/7844 allowed': (s) => s.replace(
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EDGE} -j DROP\n`,
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EGRESS} -p udp --dport 7844 -j ACCEPT\n`
      + `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EDGE} -j DROP\n`,
    ),
    'overly broad destination': (s) => s.replace(
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EDGE} -j DROP\n`,
      `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EGRESS} -d 0.0.0.0/0 -p tcp --dport 7844 -j ACCEPT\n`
      + `RULE|${EGRESS_CHAIN}|-s ${CONNECTOR_EDGE} -j DROP\n`,
    ),
    'partial policy': (s) => s.replace(
      new RegExp(`RULE\\|${EGRESS_CHAIN}\\|-s 172\\.31\\.242\\.2/32 -d 198\\.41\\.192\\.7/32[^\\n]*\\n`), '',
    ),
    'wrong interface binding': (s) => s.replace(`-i ${EGRESS_BRIDGE} `, '-i eth0 '),
  }

  for (const [label, mutate] of Object.entries(drifts)) {
    const h = harness()
    try {
      assert.equal(h.run('apply').status, 0, `${label}: apply should succeed first`)
      assert.equal(h.run('validate').status, 0, `${label}: baseline should be valid`)
      h.writeState(mutate(h.rawState()))
      const result = h.run('validate')
      assert.equal(result.status, 1,
        `validate must reject drift: ${label} (stdout=${result.stdout} stderr=${result.stderr})`)
    } finally { h.cleanup() }
  }
})

test('FIREWALL-BRIDGE-RESOLUTION-RUNTIME derives, honours and fails closed', () => {
  // 1. Derived from the network ID when no explicit bridge name is configured.
  let h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const rules = h.rules(INPUT_CHAIN).join('\n')
    assert.match(rules, new RegExp(`-i ${DERIVED_EDGE_BRIDGE} `),
      'the edge bridge must be derived as br-<first 12 of network id>')
  } finally { h.cleanup() }

  // 2. An explicitly configured bridge name wins over the derived one.
  h = harness({ bridgeName: 'aegis-ps-edge' })
  try {
    assert.equal(h.run('apply').status, 0)
    const rules = h.rules(INPUT_CHAIN).join('\n')
    assert.match(rules, /-i aegis-ps-edge /, 'a configured bridge name must be honoured')
    assert.doesNotMatch(rules, new RegExp(DERIVED_EDGE_BRIDGE), 'the derived name must not be used too')
  } finally { h.cleanup() }

  // 3. A different network ID yields a different bridge: nothing is hard-coded.
  const otherId = 'abcdef0123456789'.repeat(4);
  h = harness({ networkId: otherId })
  try {
    assert.equal(h.run('apply').status, 0)
    assert.match(h.rules(INPUT_CHAIN).join('\n'), new RegExp(`-i br-${otherId.slice(0, 12)} `),
      'the bridge must track the actual network id')
  } finally { h.cleanup() }

  // 4. Fail closed when the resolved interface does not exist on the host.
  h = harness({ interfaces: [EGRESS_BRIDGE] })
  try {
    const result = h.run('apply')
    assert.equal(result.status, 1, 'apply must fail closed when the edge bridge is absent')
    assert.equal(h.rules(EGRESS_CHAIN).length, 0,
      'no partial policy may be left behind when resolution fails')
  } finally { h.cleanup() }
})

test('FIREWALL-REMOVE-SCOPE removes only S5.5-owned anchors and chains', () => {
  const h = harness()
  try {
    // Unrelated neighbours that must survive untouched.
    h.writeState(h.rawState()
      + 'RULE|DOCKER-USER|-j UNRELATED-NEIGHBOUR\n'
      + 'RULE|INPUT|-p tcp --dport 22 -j ACCEPT\n'
      + 'CHAIN|UNRELATED-NEIGHBOUR\n'
      + 'RULE|UNRELATED-NEIGHBOUR|-j ACCEPT\n')

    assert.equal(h.run('apply').status, 0)
    assert.equal(h.run('remove').status, 0)

    assert.equal(h.chains().includes(EGRESS_CHAIN), false, 'the egress chain must be deleted')
    assert.equal(h.chains().includes(INPUT_CHAIN), false, 'the input chain must be deleted')
    assert.equal(h.rules('DOCKER-USER').includes(`-j ${EGRESS_CHAIN}`), false, 'anchor removed')
    assert.equal(h.rules('INPUT').includes(`-j ${INPUT_CHAIN}`), false, 'anchor removed')

    // Everything not owned by S5.5 survives.
    assert.deepEqual(h.rules('DOCKER-USER'), ['-j UNRELATED-NEIGHBOUR'], 'neighbour anchor preserved')
    assert.deepEqual(h.rules('INPUT'), ['-p tcp --dport 22 -j ACCEPT'], 'unrelated INPUT rule preserved')
    assert.equal(h.chains().includes('UNRELATED-NEIGHBOUR'), true, 'unrelated chain preserved')
    assert.equal(h.chains().includes('DOCKER-FORWARD'), true, 'Docker chains preserved')
    assert.equal(h.chains().includes('INPUT'), true, 'builtin chains preserved')

    assert.equal(h.run('validate').status, 1, 'validate must fail once the policy is removed')
    assert.equal(h.run('remove').status, 0, 'remove must be idempotent')
  } finally { h.cleanup() }
})

test('FIREWALL-ALLOWLIST-GATE apply refuses an unverified allowlist', () => {
  const bad = mkdtempSync(path.join(tmpdir(), 'aegis-s55-badlist-'))
  try {
    const file = path.join(bad, 'endpoints.json')
    writeFileSync(file, JSON.stringify({
      ...allowlist(), endpoints: ['0.0.0.0/0'],
    }))
    const h = harness({ endpointsFile: file })
    try {
      const result = h.run('apply')
      assert.equal(result.status, 1, 'apply must refuse a broad or unverified allowlist')
      assert.equal(h.rules(EGRESS_CHAIN).length, 0, 'no rule may be installed from a rejected allowlist')
    } finally { h.cleanup() }

    const missing = path.join(bad, 'absent.json')
    const h2 = harness({ endpointsFile: missing })
    try {
      assert.equal(h2.run('apply').status, 1, 'apply must fail closed with no allowlist at all')
    } finally { h2.cleanup() }
  } finally { rmSync(bad, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// TASK 7: host INPUT guard and forwarding isolation, asserted by evaluating the
// rules the script actually installs against representative packets.
// ---------------------------------------------------------------------------

// Minimal iptables semantics: first matching rule wins; an unmatched packet
// falls through, which the DROP-policy Production baseline denies anyway.
function inCidr(ip, cidr) {
  const [network, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw ?? 32)
  const toInt = (a) => a.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0)
  if (bits === 0) return true
  const size = 2 ** (32 - bits)
  const base = Math.floor(toInt(network) / size) * size
  return toInt(ip) >= base && toInt(ip) < base + size
}

function evaluate(rules, packet) {
  for (const rule of rules) {
    const tokens = rule.split(/\s+/)
    let matches = true
    for (let i = 0; i < tokens.length && matches; i += 1) {
      const flag = tokens[i]
      const value = tokens[i + 1]
      if (flag === '-i') matches = packet.iface === value
      else if (flag === '-s') matches = inCidr(packet.src, value)
      else if (flag === '-d') matches = inCidr(packet.dst, value)
      else if (flag === '-p') matches = packet.proto === value
      else if (flag === '--dport') matches = String(packet.dport) === value
      else if (flag === '--ctstate') matches = value.split(',').includes(packet.ctstate ?? 'NEW')
    }
    if (matches) {
      const target = tokens[tokens.indexOf('-j') + 1]
      if (target) return target
    }
  }
  return 'FALLTHROUGH'
}

const CONNECTOR_EDGE_IP = '172.31.240.3'
const CONNECTOR_EGRESS_IP = '172.31.242.2'

test('FIREWALL-INPUT-GUARD denies every host-local destination from the connector', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const rules = h.rules(INPUT_CHAIN)

    // MEASURED: host surfaces actually observed listening on the Production
    // host by read-only preflight. These are the real acceptance targets.
    const measuredHostTargets = [
      ['measured host SSH', '192.168.10.10', 'tcp', 22],
      ['measured host HTTP', '192.168.10.10', 'tcp', 80],
      ['measured host HTTPS', '192.168.10.10', 'tcp', 443],
      ['measured host service on the default docker bridge', '172.18.0.1', 'tcp', 18077],
      ['measured host stub resolver', '127.0.0.53', 'udp', 53],
      ['measured host stub resolver (secondary)', '127.0.0.54', 'udp', 53],
    ]

    // SYNTHETIC / MODEL-ONLY: not observed listening on Production. Retained
    // only to prove the generic source-based deny holds for ANY destination,
    // including ports that must never be reachable if something later listens.
    // Their presence here is NOT evidence that such a listener exists.
    const syntheticHostTargets = [
      ['SYNTHETIC/MODEL-ONLY unencrypted Docker API port', '192.168.10.10', 'tcp', 2375],
      ['SYNTHETIC/MODEL-ONLY Docker API TLS port', '192.168.10.10', 'tcp', 2376],
      ['SYNTHETIC/MODEL-ONLY administrative listener', '192.168.10.10', 'tcp', 9090],
      ['SYNTHETIC/MODEL-ONLY host loopback service', '127.0.0.1', 'tcp', 8080],
    ]

    const hostTargets = [...measuredHostTargets, ...syntheticHostTargets]

    for (const iface of [DERIVED_EDGE_BRIDGE, EGRESS_BRIDGE, 'eth0']) {
      for (const src of [CONNECTOR_EDGE_IP, CONNECTOR_EGRESS_IP]) {
        for (const target of hostTargets) {
          const [label, dst, proto, dport] = target
          const verdict = evaluate(rules, { iface, src, dst, proto, dport })
          assert.equal(verdict, 'DROP',
            `connector ${src} on ${iface} must not reach ${label} (${dst}:${dport}/${proto})`)
        }
      }
    }

    // MODEL-ONLY: aegis_public_share_egress does not exist on Production yet, so
    // 172.31.242.1 is the DESIGNED FUTURE EGRESS GATEWAY address, not measured
    // runtime evidence. This asserts the designed topology, not current state.
    assert.equal(
      evaluate(rules, { iface: EGRESS_BRIDGE, src: '172.31.242.3', dst: '172.31.242.1', proto: 'udp', dport: 53 }),
      'DROP', 'any egress-network address must be denied host INPUT (designed future topology)')

    // The guard must not reach beyond S5.5: the S5.4 gateway keeps its
    // behaviour. Destination is MODEL-ONLY - the measured edge bridge carries no
    // IPv4 host address (internal=true, gateway_mode_ipv4=isolated), so
    // 172.31.240.1 is a designed address, not a Production host-local surface.
    assert.notEqual(
      evaluate(rules, { iface: DERIVED_EDGE_BRIDGE, src: '172.31.240.2', dst: '172.31.240.1', proto: 'tcp', dport: 53 }),
      'DROP', 'S5.5 must not add a new denial for the S5.4 gateway')
  } finally { h.cleanup() }
})

test('FIREWALL-FORWARD-ISOLATION denies private, upstream and non-allowlisted egress', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const rules = h.rules(EGRESS_CHAIN)
    const allowed = allowlist().endpoints[0].replace('/32', '')

    // Exactly one forwarded path into the estate, and one out to Cloudflare.
    assert.equal(
      evaluate(rules, { src: CONNECTOR_EDGE_IP, dst: '172.31.240.2', proto: 'tcp', dport: 8080 }),
      'ACCEPT', 'the connector must reach the gateway on TCP/8080')
    assert.equal(
      evaluate(rules, { src: CONNECTOR_EGRESS_IP, dst: allowed, proto: 'tcp', dport: 7844 }),
      'ACCEPT', 'the connector must reach a reviewed Cloudflare endpoint on TCP/7844')

    const denied = [
      ['Drive directly', CONNECTOR_EDGE_IP, '172.31.241.3', 'tcp', 8001],
      ['Drive from the egress side', CONNECTOR_EGRESS_IP, '172.31.241.3', 'tcp', 8001],
      ['the upstream subnet', CONNECTOR_EDGE_IP, '172.31.241.2', 'tcp', 8080],
      ['PostgreSQL', CONNECTOR_EDGE_IP, '172.31.241.3', 'tcp', 5432],
      ['SYNTHETIC/MODEL-ONLY PostgreSQL on any host', CONNECTOR_EGRESS_IP, '192.168.10.10', 'tcp', 5432],
      ['the gateway on another port', CONNECTOR_EDGE_IP, '172.31.240.2', 'tcp', 22],
      ['the private estate', CONNECTOR_EGRESS_IP, '172.18.0.3', 'tcp', 8001],
      ['the drive proxy network', CONNECTOR_EGRESS_IP, '172.19.255.3', 'tcp', 8080],
      ['the VLAN10 network', CONNECTOR_EGRESS_IP, '192.168.10.11', 'tcp', 443],
      ['UDP/7844 (QUIC)', CONNECTOR_EGRESS_IP, allowed, 'udp', 7844],
      ['TCP/443 to an allowed endpoint', CONNECTOR_EGRESS_IP, allowed, 'tcp', 443],
      ['a non-allowlisted Internet host', CONNECTOR_EGRESS_IP, '203.0.113.9', 'tcp', 7844],
      ['arbitrary Internet HTTPS', CONNECTOR_EGRESS_IP, '1.1.1.1', 'tcp', 443],
      ['external DNS', CONNECTOR_EGRESS_IP, '1.1.1.1', 'udp', 53],
    ]
    for (const entry of denied) {
      const [label, src, dst, proto, dport] = entry
      assert.equal(
        evaluate(rules, { src, dst, proto, dport }), 'DROP',
        `the connector must not reach ${label} (${dst}:${dport}/${proto})`)
    }

    // Established return traffic is still accepted, or the tunnel cannot work.
    assert.equal(
      evaluate(rules, { src: CONNECTOR_EGRESS_IP, dst: allowed, proto: 'tcp', dport: 7844, ctstate: 'ESTABLISHED' }),
      'ACCEPT', 'established flows must be accepted')
  } finally { h.cleanup() }
})

test('FIREWALL-DNS-FAIL-CLOSED no DNS exception exists in S5.5-D', () => {
  const text = effectiveSource()
  assert.doesNotMatch(text, /--dport\s+53\b[^\n]*ACCEPT/, 'no DNS accept may be emitted')
  assert.doesNotMatch(text, /-p\s+udp[^\n]*53[^\n]*ACCEPT/, 'no UDP/53 accept may be emitted')

  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const egress = h.rules(EGRESS_CHAIN)
    // 8.8.8.8 and 1.1.1.1 are the MEASURED systemd-resolved uplinks on the host;
    // 127.0.0.53/.54 are the MEASURED host stubs. The two 172.31.x.1 entries are
    // MODEL-ONLY designed bridge addresses, not measured host surfaces. Host
    // resolver configuration is measured; the future CONNECTOR/container DNS
    // path is NOT, so every one of these stays denied.
    const dnsTargets = [
      ['MEASURED host uplink resolver', '8.8.8.8'],
      ['MEASURED host uplink resolver', '1.1.1.1'],
      ['MEASURED host stub resolver', '127.0.0.53'],
      ['MEASURED host stub resolver', '127.0.0.54'],
      ['MODEL-ONLY designed future egress gateway', '172.31.242.1'],
      ['MODEL-ONLY designed edge address', '172.31.240.1'],
    ]
    for (const [label, dst] of dnsTargets) {
      for (const proto of ['udp', 'tcp']) {
        assert.equal(
          evaluate(egress, { src: CONNECTOR_EGRESS_IP, dst, proto, dport: 53 }), 'DROP',
          `DNS to ${label} ${dst}/${proto} must stay denied until the Production connector resolver path is measured`)
      }
    }
  } finally { h.cleanup() }
})

// ---------------------------------------------------------------------------
// S5.5-E TASK 9: systemd firewall and connector lifecycle units.
//
// Units are parsed statically. No unit is ever installed, enabled, started or
// reloaded by this suite, and systemd is never invoked.
// ---------------------------------------------------------------------------

const systemdDir = path.join(production, 'systemd')
const firewallUnitPath = path.join(systemdDir, 'aegis-public-share-s5-5-firewall.service')
const connectorUnitPath = path.join(systemdDir, 'aegis-public-share-connector.service')

const RUNTIME_DIR = '/opt/aegis/runtime'
const PUBLIC_SHARE_DIR = `${RUNTIME_DIR}/public-share`
const COMPOSE_PROJECT = 'aegis-prod'

// Parse a unit file into { Section: { Key: [values...] } }.
function parseUnit(file) {
  const sections = {}
  let current = null
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)]$/.exec(line)
    if (header) { current = header[1]; sections[current] ??= {}; continue }
    const kv = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line)
    if (kv && current) {
      sections[current][kv[1]] ??= []
      sections[current][kv[1]].push(kv[2].trim())
    }
  }
  return sections
}

const only = (section, key) => {
  assert.ok(section?.[key], `missing ${key}`)
  assert.equal(section[key].length, 1, `${key} must be declared exactly once`)
  return section[key][0]
}

test('S5.5-UNIT-FIREWALL applies and removes only S5.5-owned firewall policy', () => {
  const unit = parseUnit(firewallUnitPath)

  assert.equal(only(unit.Service, 'Type'), 'oneshot')
  assert.equal(only(unit.Service, 'RemainAfterExit'), 'yes')

  const after = (unit.Unit.After ?? []).join(' ')
  assert.match(after, /\bdocker\.service\b/, 'must order after docker.service')
  assert.match(after, /\bufw\.service\b/, 'must order after ufw.service')

  const start = only(unit.Service, 'ExecStart')
  const stop = only(unit.Service, 'ExecStop')
  assert.equal(start, `${PUBLIC_SHARE_DIR}/s5-5-firewall.sh apply`)
  assert.equal(stop, `${PUBLIC_SHARE_DIR}/s5-5-firewall.sh remove`)

  // Isolation must be proven before anything is allowed to depend on it.
  const post = (unit.Service.ExecStartPost ?? []).join(' ')
  assert.match(post, /s5-5-firewall\.sh validate/,
    'apply must be followed by a validate gate')

  // The unit must drive nothing but the S5.5 tooling.
  const body = readFileSync(firewallUnitPath, 'utf8')
  for (const forbidden of [/\bufw\s+(enable|disable|reload)/, /systemctl\s+(restart|stop)\s+docker/,
    /iptables\s+-F/, /docker\s+compose\s+down/, /iptables-restore/]) {
    assert.doesNotMatch(body, forbidden, `firewall unit must not run ${forbidden}`)
  }
})

test('S5.5-UNIT-CONNECTOR starts only the connector behind the safety gates', () => {
  const unit = parseUnit(connectorUnitPath)

  const requires = (unit.Unit.Requires ?? []).join(' ')
  const after = (unit.Unit.After ?? []).join(' ')
  assert.match(requires, /aegis-public-share-s5-5-firewall\.service/,
    'the connector must require the firewall unit')
  assert.match(after, /aegis-public-share-s5-5-firewall\.service/,
    'the connector must start after the firewall unit')
  assert.match(after, /\bdocker\.service\b/, 'the connector must start after docker.service')

  const pre = (unit.Service.ExecStartPre ?? []).join(' ')
  assert.match(pre, new RegExp(`${PUBLIC_SHARE_DIR}/s5-5-runtime-check\\.sh --pre-start`),
    'the pre-start validator must gate the connector')

  const start = only(unit.Service, 'ExecStart')
  const stop = only(unit.Service, 'ExecStop')

  // Exactly one service is started, through the accepted four-layer stack.
  assert.match(start, /docker compose/, 'must use docker compose')
  assert.match(start, new RegExp(`--project-name ${COMPOSE_PROJECT}\\b`),
    'must reuse the accepted Compose project, never invent a second one')
  for (const layer of [
    `${RUNTIME_DIR}/docker-compose.production.yml`,
    `${PUBLIC_SHARE_DIR}/drive-s5-3.yml`,
    `${PUBLIC_SHARE_DIR}/drive-gateway-s5-4.yml`,
    `${PUBLIC_SHARE_DIR}/connector-s5-5.yml`,
  ]) {
    assert.ok(start.includes(`-f ${layer}`), `ExecStart must layer ${layer}`)
  }
  // Since the create-before-start correction the unit STARTS an already-created,
  // already-validated container; it must never bring one up. The stronger
  // property is pinned by S5.5-LIFECYCLE-UNIT-STARTS-EXISTING.
  assert.match(start, /\bstart public-share-connector\s*$/,
    'ExecStart must start only the already-validated public-share-connector')
  assert.doesNotMatch(start, /\bup\b/, 'ExecStart must never bring the connector up')
  assert.match(stop, /\bstop public-share-connector\s*$/,
    'ExecStop must stop only public-share-connector')

  // Never a whole-stack operation, and never another service.
  const body = readFileSync(connectorUnitPath, 'utf8')
  assert.doesNotMatch(body, /compose[^\n]*\bdown\b/, 'docker compose down is forbidden')
  assert.doesNotMatch(body, /\bprune\b/, 'prune is forbidden')
  for (const service of ['drive', 'public-share-gateway', 'postgres', 'db', 'monitor', 'twingate']) {
    assert.doesNotMatch(body, new RegExp(`(stop|rm|restart|up)[^\\n]*\\b${service}\\b`),
      `the connector unit must never operate ${service}`)
  }

  assert.equal(only(unit.Service, 'Restart'), 'on-failure')
  assert.equal(only(unit.Service, 'RestartSec'), '5s')
  // StartLimit* are [Unit] directives in modern systemd.
  assert.equal(only(unit.Unit, 'StartLimitBurst'), '5')
  assert.equal(only(unit.Unit, 'StartLimitIntervalSec'), '60s')
})

test('S5.5-UNIT-ORDERING firewall precedes the connector and both fail closed', () => {
  const firewall = parseUnit(firewallUnitPath)
  const connector = parseUnit(connectorUnitPath)

  // A connector may never come up without its isolation layer.
  assert.match((connector.Unit.Requires ?? []).join(' '), /aegis-public-share-s5-5-firewall/)
  assert.equal((firewall.Unit.Requires ?? []).some((r) => r.includes('connector')), false,
    'the firewall unit must not depend on the connector')

  // Stopping isolation must take the connector with it.
  const boundBy = (firewall.Unit.PartOf ?? []).concat(connector.Unit.PartOf ?? []).join(' ')
  const bindsTo = (connector.Unit.BindsTo ?? []).join(' ')
  assert.ok(
    /aegis-public-share-s5-5-firewall/.test(bindsTo) || /aegis-public-share/.test(boundBy),
    'the connector must be bound to the firewall unit so isolation cannot be removed under it',
  )

  for (const file of [firewallUnitPath, connectorUnitPath]) {
    const unit = parseUnit(file)
    assert.ok(unit.Install, `${path.basename(file)} needs an [Install] section to be enabled`)
  }
})

// ---------------------------------------------------------------------------
// PRE-S5.5-F SECURITY CORRECTION: established/related scope, and a fail-closed
// backend/host-chain preflight before any mutation.
//
// AEGIS-PS-EGRESS is anchored FIRST in DOCKER-USER, so anything it ACCEPTs is
// authorised for the whole host before Docker and UFW policy ever runs. A
// blanket ESTABLISHED,RELATED accept there would silently grant forwarding to
// every unrelated container on the box. S5.5 may only ever speak for the
// connector.
// ---------------------------------------------------------------------------

const BROAD_ESTABLISHED = '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'

test('S5.5-FW-NO-BROAD-ESTABLISHED never globally accepts established forwarding', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const rules = h.rules(EGRESS_CHAIN)

    assert.equal(rules.includes(BROAD_ESTABLISHED), false,
      'an unqualified ESTABLISHED,RELATED accept authorises unrelated forwarding')

    // Every conntrack accept must be pinned to a connector destination.
    for (const rule of rules) {
      if (!/ctstate/.test(rule)) continue
      assert.match(rule, /-d (172\.31\.240\.3|172\.31\.242\.2)\/32/,
        `conntrack accept must be scoped to a connector destination: ${rule}`)
      assert.doesNotMatch(rule, /-d 0\.0\.0\.0\/0/, 'never a default-route conntrack accept')
      // Scoping by SOURCE would let an already-established unauthorised
      // connector flow survive a reconciliation.
      assert.doesNotMatch(rule, /^-s /, 'conntrack accepts must be return-direction, not source-scoped')
    }

    // The generator must never emit a rule that STARTS with the conntrack match,
    // i.e. one with no destination scope at all. Qualified "-d <connector> -m
    // conntrack ..." rules are exactly what we want, so match on the opening.
    for (const line of effectiveSource().split(/\r?\n/)) {
      assert.doesNotMatch(line, /echo\s+"-m conntrack/,
        `the generator must not emit an unqualified established accept: ${line.trim()}`)
    }
  } finally { h.cleanup() }
})

test('S5.5-FW-RETURN-DIRECTION accepts return traffic toward each connector address', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const rules = h.rules(EGRESS_CHAIN)
    for (const address of ['172.31.240.3/32', '172.31.242.2/32']) {
      assert.ok(
        rules.some((r) => r.includes(`-d ${address}`) && /ctstate ESTABLISHED,RELATED/.test(r) && /-j ACCEPT$/.test(r)),
        `a return-direction conntrack accept is required for ${address}`,
      )
    }
    // Return rules must precede the terminal drops to be reachable.
    const firstReturn = rules.findIndex((r) => /ctstate/.test(r))
    const firstDrop = rules.findIndex((r) => /-j DROP$/.test(r))
    assert.ok(firstReturn !== -1 && firstReturn < firstDrop, 'return accepts must precede terminal drops')
  } finally { h.cleanup() }
})

test('S5.5-FW-SCOPE-SEMANTICS proves the exact allow/deny/fallthrough behaviour', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const rules = h.rules(EGRESS_CHAIN)
    const allowed = allowlist().endpoints[0].replace('/32', '')

    // 3 + 4: the two authorised forward flows still work.
    assert.equal(
      evaluate(rules, { src: '172.31.240.3', dst: '172.31.240.2', proto: 'tcp', dport: 8080 }),
      'ACCEPT', 'connector -> gateway TCP/8080 must remain accepted')
    assert.equal(
      evaluate(rules, { src: '172.31.242.2', dst: allowed, proto: 'tcp', dport: 7844 }),
      'ACCEPT', 'connector -> reviewed endpoint TCP/7844 must remain accepted')

    // 2: return traffic toward the connector is accepted.
    assert.equal(
      evaluate(rules, { src: allowed, dst: '172.31.242.2', proto: 'tcp', ctstate: 'ESTABLISHED' }),
      'ACCEPT', 'return traffic toward the connector must be accepted')
    assert.equal(
      evaluate(rules, { src: '172.31.240.2', dst: '172.31.240.3', proto: 'tcp', ctstate: 'ESTABLISHED' }),
      'ACCEPT', 'gateway return traffic toward the connector must be accepted')

    // 5: an unauthorised connector-originated flow is dropped even as ESTABLISHED.
    for (const [label, dst, proto, dport] of [
      ['a non-allowlisted Internet host', '203.0.113.9', 'tcp', 7844],
      ['arbitrary HTTPS', '1.1.1.1', 'tcp', 443],
      ['Drive directly', '172.31.241.3', 'tcp', 8001],
      ['PostgreSQL', '172.31.241.3', 'tcp', 5432],
    ]) {
      assert.equal(
        evaluate(rules, { src: '172.31.242.2', dst, proto, dport, ctstate: 'ESTABLISHED' }),
        'DROP', `established connector flow to ${label} must still be dropped`)
    }

    // 6 + 7: unrelated traffic is neither accepted nor dropped here - it must
    // fall through to the pre-existing Docker/UFW policy.
    for (const ctstate of ['ESTABLISHED', 'RELATED', 'NEW']) {
      assert.equal(
        evaluate(rules, { src: '172.18.0.7', dst: '172.19.255.9', proto: 'tcp', dport: 443, ctstate }),
        'FALLTHROUGH', `unrelated ${ctstate} traffic must fall through, not be authorised by S5.5`)
    }
    assert.equal(
      evaluate(rules, { src: '10.4.5.6', dst: '8.8.8.8', proto: 'udp', dport: 53, ctstate: 'ESTABLISHED' }),
      'FALLTHROUGH', 'unrelated container egress must not be authorised by S5.5')

    // 8: terminal source drops remain.
    assert.equal(rules.at(-2), '-s 172.31.240.3/32 -j DROP')
    assert.equal(rules.at(-1), '-s 172.31.242.2/32 -j DROP')
  } finally { h.cleanup() }
})

test('S5.5-FW-BACKEND-PREFLIGHT fails closed before any mutation', () => {
  // Production runs iptables-nft. Mutating an unexpected backend could write
  // rules into a table that is never consulted, which would look like success.
  const wrongBackend = harness({ iptablesVersion: 'iptables v1.8.11 (legacy)' })
  try {
    const result = wrongBackend.run('apply')
    assert.equal(result.status, 1, 'a non-nft backend must fail closed')
    assert.equal(wrongBackend.chains().includes(EGRESS_CHAIN), false,
      'no chain may be created when the backend check fails')
    assert.equal(wrongBackend.rules('DOCKER-USER').length, 0, 'no anchor may be inserted')
  } finally { wrongBackend.cleanup() }

  const nft = harness({ iptablesVersion: 'iptables v1.8.11 (nf_tables)' })
  try {
    assert.equal(nft.run('apply').status, 0, 'the nf_tables backend must be accepted')
  } finally { nft.cleanup() }
})

test('S5.5-FW-HOST-CHAIN-PREFLIGHT refuses to mutate without the required host chains', () => {
  for (const missing of ['DOCKER-USER', 'INPUT']) {
    const h = harness({ omitChains: [missing] })
    try {
      const result = h.run('apply')
      assert.equal(result.status, 1, `a missing ${missing} chain must fail closed`)
      assert.equal(h.chains().includes(EGRESS_CHAIN), false,
        `no S5.5 chain may be created when ${missing} is absent`)
      assert.equal(h.chains().includes(INPUT_CHAIN), false,
        `no S5.5 chain may be created when ${missing} is absent`)
      assert.equal(h.chains().some((c) => c.endsWith('-NEW')), false,
        'no staging chain may be created either')
    } finally { h.cleanup() }
  }

  // UFW and builtin policies are never touched by the preflight.
  const code = effectiveSource()
  assert.doesNotMatch(code, /\bufw\b/i, 'the preflight must never drive UFW')
  assert.doesNotMatch(code, /-P\s+(INPUT|FORWARD|OUTPUT)/, 'builtin policies must never be set')
})

// ---------------------------------------------------------------------------
// PRE-S5.5-F FINAL FAIL-CLOSED HARDENING (firewall side)
//
// A. validate must enforce the nf_tables backend and the required host chains,
//    because s5-5-runtime-check.sh --pre-start treats a successful validate as
//    its firewall safety gate. A validate that passes on the wrong backend
//    would let pre-start approve a start against rules nothing consults.
//
// C. remove must refuse while the connector is still active, because the script
//    exposes `remove` directly and systemd ordering cannot be the only boundary.
// ---------------------------------------------------------------------------

test('S5.5-FW-VALIDATE-BACKEND fails closed on the wrong backend, mutating nothing', () => {
  // Build a valid policy on the correct backend first.
  const good = harness()
  try {
    assert.equal(good.run('apply').status, 0)
    assert.equal(good.run('validate').status, 0, 'nf_tables + valid rules must pass')
  } finally { good.cleanup() }

  // Same valid state, legacy backend: validate must refuse and change nothing.
  const legacy = harness()
  try {
    assert.equal(legacy.run('apply').status, 0)
    const before = legacy.snapshot()
    legacy.setBackend('iptables v1.8.11 (legacy)')
    const result = legacy.run('validate')
    assert.equal(result.status, 1, 'validate must fail closed on a non-nft backend')
    assert.deepEqual(legacy.snapshot(), before, 'validate must never mutate')
  } finally { legacy.cleanup() }
})

test('S5.5-FW-VALIDATE-HOST-CHAINS fails closed when a host chain is missing', () => {
  for (const missing of ['DOCKER-USER', 'INPUT']) {
    const h = harness()
    try {
      assert.equal(h.run('apply').status, 0)
      assert.equal(h.run('validate').status, 0)

      // Remove the host chain out from under the policy.
      const state = h.rawState()
        .split('\n')
        .filter((line) => line !== `CHAIN|${missing}`)
        .join('\n')
      h.writeState(state)

      const before = h.snapshot()
      const result = h.run('validate')
      assert.equal(result.status, 1, `validate must fail when ${missing} is absent`)
      assert.deepEqual(h.snapshot(), before, 'validate must never mutate')
    } finally { h.cleanup() }
  }
})

test('S5.5-FW-REMOVE-REFUSES-ACTIVE-CONNECTOR leaves the firewall intact', () => {
  for (const state of ['running', 'restarting', 'paused']) {
    const h = harness({ connectorState: state })
    try {
      assert.equal(h.run('apply').status, 0)
      const before = h.snapshot()

      const result = h.run('remove')
      assert.equal(result.status, 1, `remove must refuse while the connector is ${state}`)
      assert.deepEqual(h.snapshot(), before,
        `the firewall must be completely unchanged when remove refuses (${state})`)

      // Isolation must still be intact and provable.
      assert.equal(h.chains().includes(EGRESS_CHAIN), true, 'egress chain must survive')
      assert.equal(h.chains().includes(INPUT_CHAIN), true, 'input chain must survive')
      assert.equal(h.rules('DOCKER-USER').includes(`-j ${EGRESS_CHAIN}`), true, 'anchor must survive')
      assert.equal(h.run('validate').status, 0, 'the policy must still validate after a refused remove')
    } finally { h.cleanup() }
  }
})

test('S5.5-FW-REMOVE-ALLOWED-WHEN-STOPPED proceeds for stopped or absent connectors', () => {
  for (const state of ['created', 'exited']) {
    const h = harness({ connectorState: state })
    try {
      assert.equal(h.run('apply').status, 0)
      assert.equal(h.run('remove').status, 0, `remove must proceed for a ${state} connector`)
      assert.equal(h.chains().includes(EGRESS_CHAIN), false, 'egress chain removed')
      assert.equal(h.chains().includes(INPUT_CHAIN), false, 'input chain removed')
    } finally { h.cleanup() }
  }

  // Absent connector: rollback and idempotence must still work.
  const absent = harness({ connectorAbsent: true })
  try {
    assert.equal(absent.run('apply').status, 0)
    assert.equal(absent.run('remove').status, 0, 'remove must proceed when the connector is absent')
    assert.equal(absent.run('remove').status, 0, 'remove must stay idempotent')
  } finally { absent.cleanup() }
})

test('S5.5-FW-REMOVE-FAILS-CLOSED-ON-UNKNOWN-DOCKER-STATE', () => {
  // A docker failure that is NOT "no such object" must not be read as "absent".
  const h = harness({ dockerError: true })
  try {
    assert.equal(h.run('apply').status, 0)
    const before = h.snapshot()
    const result = h.run('remove')
    assert.equal(result.status, 1,
      'remove must fail closed when connector state cannot be determined')
    assert.deepEqual(h.snapshot(), before, 'the firewall must be unchanged')
  } finally { h.cleanup() }

  // The guard must refuse, never stop containers itself.
  const code = effectiveSource()
  assert.doesNotMatch(code, /docker[^\n]*\bstop\b/i, 'firewall.sh must never stop a container')
  assert.doesNotMatch(code, /docker[^\n]*\bkill\b/i, 'firewall.sh must never kill a container')
  assert.doesNotMatch(code, /systemctl/i, 'firewall.sh must never drive systemd')
})

test('S5.5-FW-UNIT-ORDERING-STOPS-CONNECTOR-BEFORE-TEARDOWN', () => {
  // The direct-invocation guard is the backstop; normal unit lifecycle must
  // already stop the connector before the firewall unit runs its ExecStop.
  const connector = parseUnit(connectorUnitPath)
  const firewall = parseUnit(firewallUnitPath)

  const requires = (connector.Unit.Requires ?? []).join(' ')
  const bindsTo = (connector.Unit.BindsTo ?? []).join(' ')
  const after = (connector.Unit.After ?? []).join(' ')
  assert.match(requires, /aegis-public-share-s5-5-firewall\.service/)
  assert.match(bindsTo, /aegis-public-share-s5-5-firewall\.service/,
    'BindsTo makes systemd stop the connector when the firewall unit stops')
  assert.match(after, /aegis-public-share-s5-5-firewall\.service/,
    'After means teardown happens in reverse: connector stops first')

  assert.match((firewall.Service.ExecStop ?? []).join(' '), /s5-5-firewall\.sh remove/)
  // The firewall unit must not depend on the connector, or teardown would loop.
  assert.equal((firewall.Unit.Requires ?? []).some((r) => r.includes('connector')), false)
  assert.equal((firewall.Unit.After ?? []).some((r) => r.includes('connector')), false)
})

// ---------------------------------------------------------------------------
// PRE-S5.5-F TEARDOWN IDENTITY CORRECTION
//
// An object existing at the connector's name with the wrong Compose identity is
// an anomaly, not a clearance. Treating "not our container" as permission to
// tear down isolation is fail-open: the safe reading is that we cannot account
// for what is there, so we refuse.
//
// Likewise only `created` and `exited` are positively safe stopped states.
// `dead` is not - it is an object in an indeterminate condition, and removal is
// refused rather than assumed safe.
// ---------------------------------------------------------------------------

const EXACT_LABELS = {
  'com.docker.compose.project': 'aegis-prod',
  'com.docker.compose.service': 'public-share-connector',
}

test('S5.5-FW-TEARDOWN-IDENTITY fails closed on any identity drift', () => {
  const drifts = {
    'wrong project label': {
      'com.docker.compose.project': 'someone-elses-project',
      'com.docker.compose.service': 'public-share-connector',
    },
    'wrong service label': {
      'com.docker.compose.project': 'aegis-prod',
      'com.docker.compose.service': 'some-other-service',
    },
    'missing service label': { 'com.docker.compose.project': 'aegis-prod' },
    'missing project label': { 'com.docker.compose.service': 'public-share-connector' },
    'no labels at all': {},
  }

  for (const [label, labels] of Object.entries(drifts)) {
    // Stopped, so state alone would otherwise have permitted removal.
    const h = harness({ connectorState: 'exited', connectorLabels: labels })
    try {
      assert.equal(h.run('apply').status, 0)
      const before = h.snapshot()

      const result = h.run('remove')
      assert.equal(result.status, 1,
        `remove must fail closed on ${label}, even for a stopped object`)
      assert.deepEqual(h.snapshot(), before,
        `the firewall must be completely unchanged on ${label}`)
      assert.equal(h.chains().includes(EGRESS_CHAIN), true, 'egress chain must survive')
      assert.equal(h.chains().includes(INPUT_CHAIN), true, 'input chain must survive')
      assert.equal(h.rules('DOCKER-USER').includes(`-j ${EGRESS_CHAIN}`), true,
        'the egress anchor must survive')
      assert.equal(h.run('validate').status, 0,
        'isolation must still validate after a refused teardown')
    } finally { h.cleanup() }
  }
})

test('S5.5-FW-TEARDOWN-POSITIVE-STATES accepts only created and exited', () => {
  // Positively safe stopped states, with the exact identity.
  for (const state of ['created', 'exited']) {
    const h = harness({ connectorState: state, connectorLabels: EXACT_LABELS })
    try {
      assert.equal(h.run('apply').status, 0)
      const result = h.run('remove')
      assert.equal(result.status, 0,
        `remove must proceed for an exact-identity ${state} connector: ${result.stderr}`)
      assert.equal(h.chains().includes(EGRESS_CHAIN), false, 'egress chain removed')
      assert.equal(h.chains().includes(INPUT_CHAIN), false, 'input chain removed')
    } finally { h.cleanup() }
  }

  // Everything else refuses, including dead.
  for (const state of ['running', 'restarting', 'paused', 'dead', 'removing', 'unknown']) {
    const h = harness({ connectorState: state, connectorLabels: EXACT_LABELS })
    try {
      assert.equal(h.run('apply').status, 0)
      const before = h.snapshot()
      assert.equal(h.run('remove').status, 1,
        `remove must refuse an exact-identity connector in state '${state}'`)
      assert.deepEqual(h.snapshot(), before,
        `the firewall must be unchanged when refusing state '${state}'`)
    } finally { h.cleanup() }
  }
})

test('S5.5-FW-TEARDOWN-ABSENT stays idempotent for a genuinely absent connector', () => {
  const h = harness({ connectorAbsent: true })
  try {
    assert.equal(h.run('apply').status, 0)
    assert.equal(h.run('remove').status, 0, 'an absent connector must permit rollback')
    assert.equal(h.run('remove').status, 0, 'remove must stay idempotent')
    assert.equal(h.chains().includes(EGRESS_CHAIN), false, 'egress chain removed')
  } finally { h.cleanup() }
})

test('S5.5-FW-TEARDOWN-REFUSES-ONLY never stops or kills anything', () => {
  const code = effectiveSource()
  assert.doesNotMatch(code, /docker[^\n]*\bstop\b/i, 'firewall.sh must never stop a container')
  assert.doesNotMatch(code, /docker[^\n]*\bkill\b/i, 'firewall.sh must never kill a container')
  assert.doesNotMatch(code, /docker[^\n]*\brm\b/i, 'firewall.sh must never remove a container')
  assert.doesNotMatch(code, /systemctl/i, 'firewall.sh must never drive systemd')
})
