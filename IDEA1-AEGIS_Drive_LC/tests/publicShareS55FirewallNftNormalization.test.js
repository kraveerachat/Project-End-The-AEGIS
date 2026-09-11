import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const shell = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'

const root = fileURLToPath(new URL('../..', import.meta.url))
const production = path.join(root, 'gateway/public-share/production')
const script = path.join(production, 's5-5-firewall.sh')
const allowlistPath = path.join(production, 'cloudflare-endpoints.json')
const endpoints = JSON.parse(readFileSync(allowlistPath, 'utf8')).endpoints

const EDGE_ID = 'c76a975802719cac673e9c4a9ed6d39eb1cd5820d90dcee8e4dfca590a40db50'
const EDGE_BRIDGE = 'br-c76a97580271'
const EGRESS_BRIDGE = 'aegis-ps-eg'

function nftRules({ drift = null } = {}) {
  const egress = [
    '-d 172.31.240.3/32 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-d 172.31.242.2/32 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-s 172.31.240.3/32 -d 172.31.240.2/32 -p tcp -m tcp --dport 8080 -j ACCEPT',
    ...endpoints.map((ep) => `-s 172.31.242.2/32 -d ${ep} -p tcp -m tcp --dport 7844 -j ACCEPT`),
    '-s 172.31.240.3/32 -j DROP',
    '-s 172.31.242.2/32 -j DROP',
  ]
  const input = [
    `-s 172.31.240.3/32 -i ${EDGE_BRIDGE} -j DROP`,
    `-s 172.31.242.2/32 -i ${EGRESS_BRIDGE} -j DROP`,
    `-s 172.31.242.0/29 -i ${EGRESS_BRIDGE} -j DROP`,
    '-s 172.31.240.3/32 -j DROP',
    '-s 172.31.242.2/32 -j DROP',
  ]

  if (drift === 'wrong-port') egress[3] = egress[3].replace('--dport 7844', '--dport 7845')
  if (drift === 'extra-match') egress[3] = egress[3].replace(' -j ACCEPT', ' -m comment --comment unexpected -j ACCEPT')

  return { egress, input }
}

function harness(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aegis-s55-nft-'))
  const bin = path.join(dir, 'bin')
  const sysfs = path.join(dir, 'sys-class-net')
  mkdirSync(bin)
  mkdirSync(path.join(sysfs, EDGE_BRIDGE), { recursive: true })
  mkdirSync(path.join(sysfs, EGRESS_BRIDGE), { recursive: true })

  const state = path.join(dir, 'state.json')
  writeFileSync(state, JSON.stringify(nftRules(options)))

  const iptables = path.join(bin, 'iptables')
  writeFileSync(iptables, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = '--version' ]; then echo 'iptables v1.8.11 (nf_tables)'; exit 0; fi
if [ "\${1:-}" != '-S' ] || [ \$# -ne 2 ]; then echo 'unsupported mock invocation' >&2; exit 2; fi
chain="\$2"
case "\$chain" in
  INPUT)
    echo '-N INPUT'
    echo '-A INPUT -j AEGIS-PS-INPUT' ;;
  DOCKER-USER)
    echo '-N DOCKER-USER'
    echo '-A DOCKER-USER -j AEGIS-PS-EGRESS' ;;
  AEGIS-PS-EGRESS)
    echo '-N AEGIS-PS-EGRESS'
    STATE_FILE="${state}" node --input-type=commonjs -e '
      const fs = require("node:fs"); const s = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
      for (const r of s.egress) console.log("-A AEGIS-PS-EGRESS " + r)
    ' ;;
  AEGIS-PS-INPUT)
    echo '-N AEGIS-PS-INPUT'
    STATE_FILE="${state}" node --input-type=commonjs -e '
      const fs = require("node:fs"); const s = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
      for (const r of s.input) console.log("-A AEGIS-PS-INPUT " + r)
    ' ;;
  AEGIS-PS-EGRESS-NEW|AEGIS-PS-INPUT-NEW) exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
  chmodSync(iptables, 0o755)

  const docker = path.join(bin, 'docker')
  writeFileSync(docker, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = network ] && [ "\${2:-}" = inspect ] && [ "\${3:-}" = aegis_public_share_edge ]; then
  cat <<'JSON'
[{"Name":"aegis_public_share_edge","Id":"${EDGE_ID}","Driver":"bridge","Options":{}}]
JSON
  exit 0
fi
exit 2
`, { mode: 0o755 })
  chmodSync(docker, 0o755)

  const nftJson = path.join(dir, 'nft.json')
  writeFileSync(nftJson, JSON.stringify({
    nftables: [
      { metainfo: { version: '1.0.9', release_name: 'Community Plus', json_schema_version: 1 } },
      { table: { family: 'bridge', name: 'aegis_s55_edge', handle: 1, comment: 'AEGIS-PUBLIC-SHARE-S5.5' } },
      { chain: { family: 'bridge', table: 'aegis_s55_edge', name: 'forward', handle: 1, type: 'filter', hook: 'forward', prio: 0, policy: 'accept' } },
      {
        rule: {
          family: 'bridge', table: 'aegis_s55_edge', chain: 'forward', handle: 2,
          comment: 'AEGIS-S55 edge connector-to-gateway-http',
          expr: [
            { match: { op: '==', left: { meta: { key: 'iifname' } }, right: EDGE_BRIDGE } },
            { match: { op: '==', left: { meta: { key: 'oifname' } }, right: EDGE_BRIDGE } },
            { match: { op: '==', left: { payload: { protocol: 'ether', field: 'type' } }, right: 'ip' } },
            { match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: '172.31.240.3' } },
            { match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: '172.31.240.2' } },
            { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 8080 } },
            { counter: { packets: 0, bytes: 0 } },
            { accept: null },
          ],
        },
      },
      {
        rule: {
          family: 'bridge', table: 'aegis_s55_edge', chain: 'forward', handle: 3,
          comment: 'AEGIS-S55 edge gateway-http-return',
          expr: [
            { match: { op: '==', left: { meta: { key: 'iifname' } }, right: EDGE_BRIDGE } },
            { match: { op: '==', left: { meta: { key: 'oifname' } }, right: EDGE_BRIDGE } },
            { match: { op: '==', left: { payload: { protocol: 'ether', field: 'type' } }, right: 'ip' } },
            { match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: '172.31.240.2' } },
            { match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: '172.31.240.3' } },
            { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'sport' } }, right: 8080 } },
            { counter: { packets: 0, bytes: 0 } },
            { accept: null },
          ],
        },
      },
      {
        rule: {
          family: 'bridge', table: 'aegis_s55_edge', chain: 'forward', handle: 4,
          comment: 'AEGIS-S55 edge connector-source-deny',
          expr: [
            { match: { op: '==', left: { meta: { key: 'iifname' } }, right: EDGE_BRIDGE } },
            { match: { op: '==', left: { payload: { protocol: 'ether', field: 'type' } }, right: 'ip' } },
            { match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: '172.31.240.3' } },
            { counter: { packets: 0, bytes: 0 } },
            { drop: null },
          ],
        },
      },
      {
        rule: {
          family: 'bridge', table: 'aegis_s55_edge', chain: 'forward', handle: 5,
          comment: 'AEGIS-S55 edge connector-destination-deny',
          expr: [
            { match: { op: '==', left: { meta: { key: 'oifname' } }, right: EDGE_BRIDGE } },
            { match: { op: '==', left: { payload: { protocol: 'ether', field: 'type' } }, right: 'ip' } },
            { match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: '172.31.240.3' } },
            { counter: { packets: 0, bytes: 0 } },
            { drop: null },
          ],
        },
      },
    ],
  }, null, 2))

  const nft = path.join(bin, 'nft')
  writeFileSync(nft, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "list" ] && [ "\${2:-}" = "tables" ]; then echo "table bridge aegis_s55_edge"; exit 0; fi
if [ "\${1:-}" = "-j" ] && [ "\${2:-}" = "list" ] && [ "\${3:-}" = "table" ]; then cat "${nftJson}"; exit 0; fi
if [ "\${1:-}" = "list" ] && [ "\${2:-}" = "table" ]; then
  cat <<'NFT'
table bridge aegis_s55_edge {
  comment "AEGIS-PUBLIC-SHARE-S5.5"
  chain forward {
  }
}
NFT
  exit 0
fi
exit 0
`, { mode: 0o755 })
  chmodSync(nft, 0o755)

  const result = spawnSync(shell, [script, 'validate'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AEGIS_IPTABLES_BIN: iptables,
      AEGIS_DOCKER_BIN: docker,
      AEGIS_NFT_BIN: nft,
      AEGIS_SYSFS_NET: sysfs,
      AEGIS_ENDPOINTS_FILE: allowlistPath,
    },
    timeout: 30000,
  })
  return { result, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('S5.5-FW-NFT-NORMALIZATION accepts iptables-nft serialization of the exact policy', () => {
  const h = harness()
  try {
    assert.equal(h.result.status, 0,
      `semantic policy must validate despite nft serialization:\n${h.result.stdout}${h.result.stderr}`)
    assert.match(h.result.stdout, /S5\.5-FIREWALL=VALID/)
  } finally { h.cleanup() }
})

test('S5.5-FW-NFT-NORMALIZATION still rejects a wrong destination port', () => {
  const h = harness({ drift: 'wrong-port' })
  try {
    assert.equal(h.result.status, 1, 'real policy drift must still fail closed')
    assert.match(h.result.stderr, /drifted chain AEGIS-PS-EGRESS/)
  } finally { h.cleanup() }
})

test('S5.5-FW-NFT-NORMALIZATION still rejects an unrecognized extra match', () => {
  const h = harness({ drift: 'extra-match' })
  try {
    assert.equal(h.result.status, 1, 'unknown extra semantics must not be normalized away')
    assert.match(h.result.stderr, /drifted chain AEGIS-PS-EGRESS/)
  } finally { h.cleanup() }
})
