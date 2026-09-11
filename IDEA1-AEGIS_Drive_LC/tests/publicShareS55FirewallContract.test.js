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
  *)
    echo "mock iptables: unsupported operation \$op" >&2; exit 2 ;;
esac
`

const MOCK_DOCKER = `#!/usr/bin/env bash
# Disposable mock docker. Returns fixture JSON for 'network inspect'.
set -u
echo "\$*" >> "\$MOCK_DOCKER_LOG"
cat "\$MOCK_DOCKER_JSON"
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
  // Seed the builtin chains the Production baseline already has.
  writeFileSync(state, 'CHAIN|INPUT\nCHAIN|FORWARD\nCHAIN|DOCKER-USER\nCHAIN|DOCKER-FORWARD\n')

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

  const env = {
    ...process.env,
    MSYS_NO_PATHCONV: '1',
    MOCK_STATE: state,
    MOCK_DOCKER_JSON: dockerJson,
    MOCK_DOCKER_LOG: path.join(root, 'docker.log'),
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
  return { run, rules, chains, rawState, snapshot, writeState, cleanup, root, env }
}

const expectedEgressRules = () => {
  const { endpoints } = allowlist()
  return [
    '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
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
    assert.equal(egress[0].includes('ESTABLISHED,RELATED'), true, 'conntrack accept comes first')
    assert.equal(egress.at(-2), `-s ${CONNECTOR_EDGE} -j DROP`, 'terminal deny for the edge address')
    assert.equal(egress.at(-1), `-s ${CONNECTOR_EGRESS} -j DROP`, 'terminal deny for the egress address')
  } finally { h.cleanup() }
})

test('FIREWALL-ANCHOR-JUMPS DOCKER-USER and INPUT jump first', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    const dockerUser = h.rules('DOCKER-USER')
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
