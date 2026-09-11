// PUBLIC-SHARE-7 S5.5: edge bridge firewall semantic / model contract.
//
// These tests never touch a real firewall, a real Docker daemon, or Production.
// `apply`, `validate`, and `remove` are exercised against disposable mock
// iptables, mock docker, and mock nftables binaries. Nothing requires root.

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const effectiveSource = () => source()
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')

const TABLE = 'aegis_s55_edge'
const FAMILY = 'bridge'
const CHAIN = 'forward'
const OWNER = 'AEGIS-PUBLIC-SHARE-S5.5'
const CONNECTOR = '172.31.240.3'
const GATEWAY = '172.31.240.2'
const CURRENT_MEASURED_BRIDGE = 'br-c76a97580271' // evidence only; source must not pin it
const EDGE_NETWORK_ID = 'c76a975802719cac673e9c4a9ed6d39eb1cd5820d90dcee8e4dfca590a40db50'
const EGRESS_BRIDGE = 'aegis-ps-eg'

const MOCK_IPTABLES = `#!/usr/bin/env bash
set -u
state="$MOCK_STATE"
: > "$state.lock" 2>/dev/null || true
touch "$state"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -t) shift 2 ;;
    -w|--wait) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
op="\${args[0]:-}"
chain="\${args[1]:-}"
rest=("\${args[@]:2}")
pos=""
if [ "$op" = "-I" ] && [ "\${#rest[@]}" -gt 0 ] && [[ "\${rest[0]}" =~ ^[0-9]+$ ]]; then
  pos="\${rest[0]}"; rest=("\${rest[@]:1}")
fi
rule="\${rest[*]:-}"
chain_exists() { grep -qxF "CHAIN|$chain" "$state"; }
case "$op" in
  -N)
    if chain_exists; then echo "iptables: Chain already exists." >&2; exit 1; fi
    echo "CHAIN|$chain" >> "$state"; exit 0 ;;
  -X)
    if ! chain_exists; then echo "iptables: No chain/target/match by that name." >&2; exit 1; fi
    grep -vxF "CHAIN|$chain" "$state" | grep -v "^RULE|$chain|" > "$state.tmp" || true
    mv "$state.tmp" "$state"; exit 0 ;;
  -F)
    if ! chain_exists; then echo "iptables: No chain/target/match by that name." >&2; exit 1; fi
    grep -v "^RULE|$chain|" "$state" > "$state.tmp" || true
    mv "$state.tmp" "$state"; exit 0 ;;
  -C)
    if ! chain_exists; then exit 1; fi
    grep -qxF "RULE|$chain|$rule" "$state" && exit 0 || exit 1 ;;
  -A)
    if ! chain_exists; then echo "iptables: No chain by that name." >&2; exit 1; fi
    echo "RULE|$chain|$rule" >> "$state"; exit 0 ;;
  -I)
    if ! chain_exists; then echo "iptables: No chain by that name." >&2; exit 1; fi
    awk -v line="RULE|$chain|$rule" -v ch="RULE|$chain|" '
      BEGIN { done=0 }
      { if (!done && index($0, ch)==1) { print line; done=1 } print }
      END { if (!done) print line }
    ' "$state" > "$state.tmp"; mv "$state.tmp" "$state"; exit 0 ;;
  -D)
    grep -vxF "RULE|$chain|$rule" "$state" > "$state.tmp" || true
    mv "$state.tmp" "$state"; exit 0 ;;
  -S)
    if [ -n "$chain" ]; then
      chain_exists || { echo "iptables: No chain/target/match by that name." >&2; exit 1; }
      echo "-N $chain"
      grep "^RULE|$chain|" "$state" | while IFS='|' read -r _ c r; do echo "-A $c $r"; done
      exit 0
    fi
    grep "^CHAIN|" "$state" | while IFS='|' read -r _ c; do echo "-N $c"; done
    grep "^RULE|" "$state" | while IFS='|' read -r _ c r; do echo "-A $c $r"; done
    exit 0 ;;
  --version|-V)
    cat "$MOCK_IPTABLES_VERSION_FILE"; exit 0 ;;
  *)
    echo "mock iptables: unsupported operation $op" >&2; exit 2 ;;
esac
`

const MOCK_DOCKER = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "network" ]; then cat "$MOCK_DOCKER_JSON"; exit 0; fi
if [ "\${1:-}" = "inspect" ]; then
  if [ "\${MOCK_DOCKER_MODE:-ok}" = "error" ]; then
    echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2
    exit 1
  fi
  if [ ! -f "$MOCK_CONNECTOR_JSON" ]; then
    echo "Error response from daemon: No such object: \${2:-}" >&2
    exit 1
  fi
  cat "$MOCK_CONNECTOR_JSON"; exit 0
fi
exit 0
`

const MOCK_NFT = `#!/usr/bin/env bash
# Disposable mock nftables CLI.
set -euo pipefail

log="$MOCK_NFT_LOG"
state_dir="$MOCK_NFT_STATE_DIR"
json_file="$state_dir/table.json"
text_file="$state_dir/table.nft"

echo "$*" >> "$log"

if [ "\${MOCK_NFT_FAIL_ALL:-0}" = "1" ]; then
  echo "mock nft: synthetic general failure" >&2
  exit 1
fi

args=("$@")
is_json=0
if [ "\${1:-}" = "-j" ]; then
  is_json=1
  args=("\${args[@]:1}")
fi

cmd="\${args[0]:-}"

case "$cmd" in
  --check)
    # nft --check -f <file>
    if [ "\${args[1]:-}" = "-f" ]; then
      candidate="\${args[2]:-}"
      [ -f "$candidate" ] || { echo "nft: file not found: $candidate" >&2; exit 1; }
      if [ "\${MOCK_NFT_CHECK_FAIL:-0}" = "1" ]; then
        echo "Error: Syntax error in candidate batch" >&2
        exit 1
      fi
      exit 0
    fi
    echo "mock nft: unsupported --check usage: \${args[*]}" >&2
    exit 2
    ;;

  -f)
    # nft -f <file>
    candidate="\${args[1]:-}"
    [ -f "$candidate" ] || { echo "nft: file not found: $candidate" >&2; exit 1; }
    if [ "\${MOCK_NFT_COMMIT_FAIL:-0}" = "1" ]; then
      echo "Error: Could not commit candidate batch" >&2
      exit 1
    fi
    # Run parser to update mock state
    node "$MOCK_NFT_PARSER" "$candidate" "$json_file" "$text_file"
    exit 0
    ;;

  list)
    sub="\${args[1]:-}"
    if [ "$sub" = "tables" ]; then
      if [ "\${MOCK_NFT_LIST_TABLES_FAIL:-0}" = "1" ]; then
        echo "Error: Could not list tables" >&2
        exit 1
      fi
      if [ -f "$json_file" ]; then
        node -e '
          const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
          const t = data.nftables.find(x => x.table)?.table
          if (t) console.log("table " + t.family + " " + t.name)
        ' "$json_file"
      fi
      exit 0
    fi
    if [ "$sub" = "table" ]; then
      family="\${args[2]:-}"
      tname="\${args[3]:-}"
      if [ ! -f "$json_file" ]; then
        echo "Error: No such file or directory; did you mean table ‘$tname’ in family $family?" >&2
        exit 1
      fi
      if [ "$is_json" = "1" ]; then
        cat "$json_file"
        exit 0
      else
        if [ -f "$text_file" ]; then
          cat "$text_file"
        else
          cat "$json_file"
        fi
        exit 0
      fi
    fi
    echo "mock nft: unsupported list command: \${args[*]}" >&2
    exit 2
    ;;

  delete)
    sub="\${args[1]:-}"
    if [ "$sub" = "table" ]; then
      family="\${args[2]:-}"
      tname="\${args[3]:-}"
      if [ ! -f "$json_file" ]; then
        echo "Error: No such file or directory; did you mean table ‘$tname’ in family $family?" >&2
        exit 1
      fi
      rm -f "$json_file" "$text_file"
      exit 0
    fi
    echo "mock nft: unsupported delete command: \${args[*]}" >&2
    exit 2
    ;;

  *)
    echo "mock nft: unsupported command \${args[*]}" >&2
    exit 2
    ;;
esac
`

const MOCK_NFT_PARSER = `
const fs = require('fs')

const candidatePath = process.argv[2]
const jsonOut = process.argv[3]
const textOut = process.argv[4]

const text = fs.readFileSync(candidatePath, 'utf8')

// If candidate deletes table first, handle it
// Parse table declaration
const tableMatch = text.match(/table\\s+([a-zA-Z0-9_]+)\\s+([a-zA-Z0-9_]+)\\s*\\{/)
if (!tableMatch) {
  process.exit(0)
}

const family = tableMatch[1]
const tableName = tableMatch[2]

const commentMatch = text.match(/comment\\s+"([^"]+)"/)
const tableComment = commentMatch ? commentMatch[1] : undefined

// Parse chain declaration
const chainMatch = text.match(/chain\\s+([a-zA-Z0-9_]+)\\s*\\{([\\s\\S]*?)\\}/)
let chainName = 'forward'
let chainType = 'filter'
let chainHook = 'forward'
let chainPrio = 0
let chainPolicy = 'accept'
let rulesBlock = ''

if (chainMatch) {
  chainName = chainMatch[1]
  rulesBlock = chainMatch[2]
  const typeMatch = rulesBlock.match(/type\\s+([a-zA-Z0-9_]+)\\s+hook\\s+([a-zA-Z0-9_]+)\\s+priority\\s+(-?[0-9]+);/)
  if (typeMatch) {
    chainType = typeMatch[1]
    chainHook = typeMatch[2]
    chainPrio = parseInt(typeMatch[3], 10)
  }
  const policyMatch = rulesBlock.match(/policy\\s+([a-zA-Z0-9_]+);/)
  if (policyMatch) {
    chainPolicy = policyMatch[1]
  }
}

// Parse individual rules
const lines = rulesBlock.split(/\\r?\\n/)
const rules = []
let handleCounter = 2

for (const rawLine of lines) {
  const line = rawLine.trim()
  if (!line || line.startsWith('type ') || line.startsWith('policy ')) continue
  if (line.startsWith('//') || line.startsWith('#')) continue

  const expr = []
  const iif = line.match(/iifname\\s+"([^"]+)"/)
  if (iif) {
    expr.push({ match: { op: '==', left: { meta: { key: 'iifname' } }, right: iif[1] } })
  }
  const oif = line.match(/oifname\\s+"([^"]+)"/)
  if (oif) {
    expr.push({ match: { op: '==', left: { meta: { key: 'oifname' } }, right: oif[1] } })
  }
  const eth = line.match(/ether\\s+type\\s+([a-zA-Z0-9_]+)/)
  if (eth) {
    expr.push({ match: { op: '==', left: { payload: { protocol: 'ether', field: 'type' } }, right: eth[1] } })
  }
  const saddr = line.match(/ip\\s+saddr\\s+([0-9.]+)/)
  if (saddr) {
    expr.push({ match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: saddr[1] } })
  }
  const daddr = line.match(/ip\\s+daddr\\s+([0-9.]+)/)
  if (daddr) {
    expr.push({ match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: daddr[1] } })
  }
  const sport = line.match(/tcp\\s+sport\\s+([0-9]+)/)
  if (sport) {
    expr.push({ match: { op: '==', left: { payload: { protocol: 'tcp', field: 'sport' } }, right: parseInt(sport[1], 10) } })
  }
  const dport = line.match(/tcp\\s+dport\\s+([0-9]+)/)
  if (dport) {
    expr.push({ match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: parseInt(dport[1], 10) } })
  }
  if (/\\bcounter\\b/.test(line)) {
    expr.push({ counter: { packets: 0, bytes: 0 } })
  }
  if (/\\baccept\\b/.test(line)) {
    expr.push({ accept: null })
  } else if (/\\bdrop\\b/.test(line)) {
    expr.push({ drop: null })
  }

  const commentM = line.match(/comment\\s+"([^"]+)"/)
  const rComment = commentM ? commentM[1] : undefined

  rules.push({
    rule: {
      family,
      table: tableName,
      chain: chainName,
      handle: handleCounter++,
      ...(rComment ? { comment: rComment } : {}),
      expr
    }
  })
}

const nftablesJson = {
  nftables: [
    {
      metainfo: {
        version: '1.0.9',
        release_name: 'Community Plus',
        json_schema_version: 1
      }
    },
    {
      table: {
        family,
        name: tableName,
        handle: 1,
        ...(tableComment ? { comment: tableComment } : {})
      }
    },
    {
      chain: {
        family,
        table: tableName,
        name: chainName,
        handle: 1,
        type: chainType,
        hook: chainHook,
        prio: chainPrio,
        policy: chainPolicy
      }
    },
    ...rules
  ]
}

fs.writeFileSync(jsonOut, JSON.stringify(nftablesJson, null, 2))
fs.writeFileSync(textOut, text)
`

function harness(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aegis-s55-bridge-fw-'))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const sysfs = path.join(root, 'sys-class-net')
  mkdirSync(sysfs)
  const nftStateDir = path.join(root, 'nft-state')
  mkdirSync(nftStateDir)

  const iptables = path.join(bin, 'iptables')
  const docker = path.join(bin, 'docker')
  const nft = path.join(bin, 'nft')
  const nftParser = path.join(root, 'parse-candidate.cjs')
  const nftLog = path.join(root, 'nft.log')

  writeFileSync(iptables, MOCK_IPTABLES, { mode: 0o755 })
  writeFileSync(docker, MOCK_DOCKER, { mode: 0o755 })
  writeFileSync(nft, MOCK_NFT, { mode: 0o755 })
  writeFileSync(nftParser, MOCK_NFT_PARSER, { mode: 0o644 })
  chmodSync(iptables, 0o755)
  chmodSync(docker, 0o755)
  chmodSync(nft, 0o755)

  const state = path.join(root, 'iptables-state')
  const seeded = ['INPUT', 'FORWARD', 'DOCKER-USER', 'DOCKER-FORWARD']
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

  const present = options.interfaces
    ?? [bridgeName ?? `br-${networkId.slice(0, 12)}`, EGRESS_BRIDGE]
  for (const iface of present) mkdirSync(path.join(sysfs, iface), { recursive: true })

  const versionFile = path.join(root, 'iptables-version')
  writeFileSync(versionFile, (options.iptablesVersion ?? 'iptables v1.8.11 (nf_tables)') + '\n')

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

  // Pre-seed NFT state if requested
  if (options.seedNftJson) {
    writeFileSync(path.join(nftStateDir, 'table.json'), JSON.stringify(options.seedNftJson, null, 2))
  }
  if (options.seedNftText) {
    writeFileSync(path.join(nftStateDir, 'table.nft'), options.seedNftText)
  }

  const defaultAllowlist = path.join(root, 'endpoints.json')
  writeFileSync(defaultAllowlist, JSON.stringify({
    snapshotType: 'reviewed-point-in-time-snapshot',
    snapshotUtc: '2026-09-11T00:00:00Z',
    reviewNote: 'requires re-verification',
    transport: {
      ipVersion: 'ipv4',
      port: 7844,
      protocols: ['tcp'],
    },
    excluded: [
      { transport: 'udp/7844' },
      { transport: 'tcp/443' },
    ],
    regions: [
      {
        hostname: 'region1.v2.argotunnel.com',
        endpoints: ['198.41.192.167/32'],
      },
      {
        hostname: 'region2.v2.argotunnel.com',
        endpoints: ['198.41.192.227/32'],
      },
    ],
    endpoints: [
      '198.41.192.167/32',
      '198.41.192.227/32',
    ],
    provenance: {
      sources: [
        { method: 'dns', detail: 'test' },
        { method: 'doc', detail: 'test' },
      ],
    },
  }, null, 2))

  const env = {
    ...process.env,
    MSYS_NO_PATHCONV: '1',
    MOCK_STATE: state,
    MOCK_IPTABLES_VERSION_FILE: versionFile,
    MOCK_DOCKER_JSON: dockerJson,
    MOCK_CONNECTOR_JSON: connectorJson,
    MOCK_DOCKER_MODE: options.dockerError ? 'error' : 'ok',
    MOCK_NFT_LOG: nftLog,
    MOCK_NFT_STATE_DIR: nftStateDir,
    MOCK_NFT_PARSER: nftParser,
    MOCK_NFT_CHECK_FAIL: options.nftCheckFail ? '1' : '0',
    MOCK_NFT_COMMIT_FAIL: options.nftCommitFail ? '1' : '0',
    MOCK_NFT_LIST_TABLES_FAIL: options.nftListTablesFail ? '1' : '0',
    AEGIS_IPTABLES_BIN: iptables,
    AEGIS_DOCKER_BIN: docker,
    AEGIS_NFT_BIN: options.nftBin ?? nft,
    AEGIS_SYSFS_NET: sysfs,
    AEGIS_ENDPOINTS_FILE: options.endpointsFile ?? defaultAllowlist,
  }

  const run = (...args) => spawnSync(shell, [script, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  })

  const nftJsonPath = path.join(nftStateDir, 'table.json')
  const nftTextPath = path.join(nftStateDir, 'table.nft')

  const readNftJson = () => {
    if (!existsSync(nftJsonPath)) return null
    return JSON.parse(readFileSync(nftJsonPath, 'utf8'))
  }
  const readNftText = () => {
    if (!existsSync(nftTextPath)) return null
    return readFileSync(nftTextPath, 'utf8')
  }
  const readNftLog = () => {
    if (!existsSync(nftLog)) return ''
    return readFileSync(nftLog, 'utf8')
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true })

  return {
    run,
    readNftJson,
    readNftText,
    readNftLog,
    nftJsonPath,
    nftTextPath,
    cleanup,
  }
}

// ---------------------------------------------------------------------------
// RED tests: bridge firewall contract
// ---------------------------------------------------------------------------

test('apply requires native nft bridge enforcement', () => {
  const h = harness()
  try {
    const r = h.run('apply')
    assert.equal(r.status, 0)
    const json = h.readNftJson()
    assert.ok(json, 'native bridge table must be created by apply')
    assert.equal(json.nftables.find((x) => x.table)?.table?.name, TABLE)
  } finally {
    h.cleanup()
  }
})

test('source never mutates global bridge netfilter settings', () => {
  const text = effectiveSource()
  assert.doesNotMatch(text, /modprobe\s+br_netfilter/)
  assert.doesNotMatch(text, /bridge-nf-call-iptables/)
  assert.doesNotMatch(text, /\/proc\/sys\/net\/bridge/)
})

test('missing nft binary -> apply fails before any nft commit', () => {
  const h = harness({ nftBin: '/nonexistent/bin/nft' })
  try {
    const r = h.run('apply')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /nft/i)
    assert.equal(h.readNftJson(), null)
  } finally {
    h.cleanup()
  }
})

test('nft --check failure -> apply fails before nft -f commit', () => {
  const h = harness({ nftCheckFail: true })
  try {
    const r = h.run('apply')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /nft.*--check|candidate/i)
    assert.equal(h.readNftJson(), null)
  } finally {
    h.cleanup()
  }
})

test('edge bridge derives from Docker network ID/options, never hard-coded measured suffix', () => {
  const text = effectiveSource()
  // The source must not pin the measured production bridge suffix
  assert.doesNotMatch(text, new RegExp(CURRENT_MEASURED_BRIDGE))

  // Test apply with custom bridge option
  const h = harness({ bridgeName: 'custom-edge-br' })
  try {
    const r = h.run('apply')
    assert.equal(r.status, 0)
    const json = h.readNftJson()
    assert.ok(json, 'table json must be created')
    const raw = JSON.stringify(json)
    assert.match(raw, /custom-edge-br/)
  } finally {
    h.cleanup()
  }
})

test('owned table exact family/table/comment/chain/hook/priority/policy', () => {
  const h = harness()
  try {
    const r = h.run('apply')
    assert.equal(r.status, 0)
    const json = h.readNftJson()
    assert.ok(json, 'table json must be present')

    const tableObj = json.nftables.find((x) => x.table)?.table
    assert.ok(tableObj, 'table must exist')
    assert.equal(tableObj.family, FAMILY)
    assert.equal(tableObj.name, TABLE)
    assert.equal(tableObj.comment, OWNER)

    const chainObj = json.nftables.find((x) => x.chain)?.chain
    assert.ok(chainObj, 'chain must exist')
    assert.equal(chainObj.family, FAMILY)
    assert.equal(chainObj.table, TABLE)
    assert.equal(chainObj.name, CHAIN)
    assert.equal(chainObj.type, 'filter')
    assert.equal(chainObj.hook, 'forward')
    assert.equal(chainObj.prio, 0)
    assert.equal(chainObj.policy, 'accept')
  } finally {
    h.cleanup()
  }
})

test('exact forward and reverse HTTP rules plus terminal drops', () => {
  const h = harness()
  try {
    const r = h.run('apply')
    assert.equal(r.status, 0)
    const json = h.readNftJson()
    assert.ok(json)

    const rules = json.nftables.filter((x) => x.rule).map((x) => x.rule)
    assert.equal(rules.length, 4, 'must contain exactly 4 rules in forward chain')

    // Rule 1: connector -> gateway tcp dport 8080 accept
    assert.equal(rules[0].comment, 'AEGIS-S55 edge connector-to-gateway-http')
    const r1 = rules[0].expr
    assert.ok(r1.some((e) => e.accept !== undefined))
    assert.ok(r1.some((e) => e.match?.left?.payload?.field === 'saddr' && e.match?.right === CONNECTOR))
    assert.ok(r1.some((e) => e.match?.left?.payload?.field === 'daddr' && e.match?.right === GATEWAY))
    assert.ok(r1.some((e) => e.match?.left?.payload?.field === 'dport' && e.match?.right === 8080))

    // Rule 2: gateway tcp sport 8080 -> connector accept
    assert.equal(rules[1].comment, 'AEGIS-S55 edge gateway-http-return')
    const r2 = rules[1].expr
    assert.ok(r2.some((e) => e.accept !== undefined))
    assert.ok(r2.some((e) => e.match?.left?.payload?.field === 'saddr' && e.match?.right === GATEWAY))
    assert.ok(r2.some((e) => e.match?.left?.payload?.field === 'daddr' && e.match?.right === CONNECTOR))
    assert.ok(r2.some((e) => e.match?.left?.payload?.field === 'sport' && e.match?.right === 8080))

    // Rule 3: connector source deny (ether type ip)
    assert.equal(rules[2].comment, 'AEGIS-S55 edge connector-source-deny')
    const r3 = rules[2].expr
    assert.ok(r3.some((e) => e.drop !== undefined))
    assert.ok(r3.some((e) => e.match?.left?.payload?.field === 'saddr' && e.match?.right === CONNECTOR))
    assert.ok(r3.some((e) => e.match?.left?.payload?.protocol === 'ether' && e.match?.right === 'ip'))

    // Rule 4: connector destination deny (ether type ip)
    assert.equal(rules[3].comment, 'AEGIS-S55 edge connector-destination-deny')
    const r4 = rules[3].expr
    assert.ok(r4.some((e) => e.drop !== undefined))
    assert.ok(r4.some((e) => e.match?.left?.payload?.field === 'daddr' && e.match?.right === CONNECTOR))
    assert.ok(r4.some((e) => e.match?.left?.payload?.protocol === 'ether' && e.match?.right === 'ip'))
  } finally {
    h.cleanup()
  }
})

test('ARP is not denied by terminal rules', () => {
  const h = harness()
  try {
    const r = h.run('apply')
    assert.equal(r.status, 0)
    const json = h.readNftJson()
    assert.ok(json)
    const rules = json.nftables.filter((x) => x.rule).map((x) => x.rule)
    const dropRules = rules.filter((r) => r.expr.some((e) => e.drop !== undefined))
    assert.equal(dropRules.length, 2)
    for (const dr of dropRules) {
      const hasEtherIp = dr.expr.some((e) => e.match?.left?.payload?.protocol === 'ether' && e.match?.right === 'ip')
      assert.ok(hasEtherIp, 'terminal drop rule must explicitly match ether type ip so ARP is not dropped')
    }
  } finally {
    h.cleanup()
  }
})

test('extra/broad ACCEPT makes validate fail', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    assert.equal(h.run('validate').status, 0)

    // Tamper by injecting an extra accept rule
    const json = h.readNftJson()
    json.nftables.push({
      rule: {
        family: FAMILY,
        table: TABLE,
        chain: CHAIN,
        handle: 99,
        comment: 'unauthorized-extra-accept',
        expr: [{ accept: null }]
      }
    })
    writeFileSync(h.nftJsonPath, JSON.stringify(json, null, 2))

    const v = h.run('validate')
    assert.notEqual(v.status, 0)
    assert.match(v.stderr + v.stdout, /invalid|drift|rule/i)
  } finally {
    h.cleanup()
  }
})

test('wrong port/bridge makes validate fail', () => {
  const h = harness()
  try {
    assert.equal(h.run('apply').status, 0)
    assert.equal(h.run('validate').status, 0)

    // Tamper by altering port to 8081
    const json = h.readNftJson()
    const r1 = json.nftables.find((x) => x.rule?.comment === 'AEGIS-S55 edge connector-to-gateway-http')?.rule
    assert.ok(r1)
    const dportMatch = r1.expr.find((e) => e.match?.left?.payload?.field === 'dport')
    assert.ok(dportMatch)
    dportMatch.match.right = 8081
    writeFileSync(h.nftJsonPath, JSON.stringify(json, null, 2))

    const v = h.run('validate')
    assert.notEqual(v.status, 0)
    assert.match(v.stderr + v.stdout, /invalid|drift|port|bridge/i)
  } finally {
    h.cleanup()
  }
})

test('foreign same-name table makes apply/remove fail closed', () => {
  // Pre-seed a foreign table without S5.5 ownership comment
  const foreignJson = {
    nftables: [
      {
        table: {
          family: FAMILY,
          name: TABLE,
          handle: 1,
          comment: 'FOREIGN-ADMIN-TABLE'
        }
      }
    ]
  }
  const h = harness({ seedNftJson: foreignJson })
  try {
    const applyRes = h.run('apply')
    assert.notEqual(applyRes.status, 0)
    assert.match(applyRes.stderr, /ownership|unowned|foreign/i)

    const removeRes = h.run('remove')
    assert.notEqual(removeRes.status, 0)
    assert.match(removeRes.stderr, /ownership|unowned|foreign/i)

    // Foreign table must not have been deleted
    assert.ok(h.readNftJson())
    assert.equal(h.readNftJson().nftables[0].table.comment, 'FOREIGN-ADMIN-TABLE')
  } finally {
    h.cleanup()
  }
})

test('owned table absent during remove is idempotent', () => {
  const h = harness()
  try {
    // Table is not present initially
    assert.equal(h.readNftJson(), null)
    const r = h.run('remove')
    assert.equal(r.status, 0)
    assert.match(r.stdout, /REMOVED/)
  } finally {
    h.cleanup()
  }
})

test('connector active makes remove refuse', () => {
  const h = harness({ connectorState: 'running' })
  try {
    const r = h.run('remove')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /connector is active/i)
  } finally {
    h.cleanup()
  }
})
