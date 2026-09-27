import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(monitorRoot, '..')
const specificationPath = path.join(
  repositoryRoot,
  'docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md',
)
const parentPlanPath = path.join(
  repositoryRoot,
  'docs/superpowers/plans/2026-09-19-idea2-machine-a-no-powershell-runtime.md',
)
const statusPath = path.join(
  repositoryRoot,
  'Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md',
)

function requiredText(filePath) {
  assert.ok(fs.existsSync(filePath), `required contract file is missing: ${path.relative(repositoryRoot, filePath)}`)
  return fs.readFileSync(filePath, 'utf8')
}

test('H1 design fixes candidate-only names and an isolated Compose topology', () => {
  const source = requiredText(specificationPath)

  for (const contract of [
    'COMPOSE_PROJECT_NAME=aegis-h1-lab',
    'CANDIDATE_NONPROD_HOSTNAME=idea2-h1.aegis-lab.internal',
    'CANDIDATE_STREAM_HOSTNAME=idea2-h1-stream.aegis-lab.internal',
    'CANDIDATE_HTTPS_PORT=18443',
    'DATABASE_ISOLATION=SEPARATE_DATABASE_VOLUME_AND_CREDENTIALS',
    'MONITOR_ISOLATION=SEPARATE_CONTAINER_NETWORK_AND_LIFECYCLE',
    'PRODUCTION_INTEGRATION=NONE',
  ]) {
    assert.match(source, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.match(source, /HOST_COLOCATION_SAFE=CONDITIONAL_ON_N0_PASS/)
  assert.match(source, /DEDICATED_HOST_REQUIRED=ONLY_IF_N0_CANNOT_PROVE_ISOLATION/)
  assert.match(source, /CANDIDATE_ONLY/g)
})

test('H1 gateway contract separates browser and exact Agent service routes', () => {
  const source = requiredText(specificationPath)

  assert.match(source, /BROWSER_ORIGIN=https:\/\/idea2-h1\.aegis-lab\.internal:18443/)
  assert.match(source, /AGENT_BASE_URL=https:\/\/idea2-h1\.aegis-lab\.internal:18443\/agent/)
  assert.match(source, /AUTH_AUDIENCE=https:\/\/idea2-h1\.aegis-lab\.internal:18443/)
  for (const route of [
    '/agent/internal/agent-auth/challenge',
    '/agent/internal/agent-auth/verify',
    '/agent/internal/heartbeat',
    '/agent/internal/detections',
    '/agent/internal/alerts',
    '/agent/internal/clips',
  ]) {
    assert.ok(source.includes(`\`${route}\``), `missing exact Agent ingress route ${route}`)
  }
  assert.match(source, /all other `\/agent\/internal\/\*` paths[^\n]*DENY/i)
  assert.match(source, /Production gateway[^\n]*unchanged/i)
})

test('H1 TLS model requires a managed CA bundle and keeps verification enabled', () => {
  const source = requiredText(specificationPath)

  assert.match(source, /AEGIS_AGENT_CA_BUNDLE/)
  assert.match(source, /CA_BUNDLE_IMPLEMENTATION=NOT_IMPLEMENTED/)
  assert.match(source, /TLS_VERIFY=REQUIRED/)
  assert.match(source, /REQUESTS_CA_BUNDLE=FORBIDDEN_UNMANAGED_INPUT/)
  assert.match(source, /verify=False=FORBIDDEN/)
  assert.match(source, /PRIVATE_CA_KEY_ALLOWED=NO/)
  assert.match(source, /N8[^\n]*blocked[^\n]*CA-bundle/i)
  assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/)
})

test('H1 registry and stream authority keep physical identity machine-owned', () => {
  const source = requiredText(specificationPath)

  for (const contract of [
    'operator -> CAM-01',
    'operator2 -> CAM-02',
    'PHYSICAL_CAMERA_ID=SERVER_GENERATED',
    'NODE_ID=OWNER_APPROVED_AFTER_REGISTRY_ENUMERATION',
    'KEY_VERSION=1_ONLY_FOR_CONFIRMED_FRESH_NODE',
    'AEGIS_MONITOR_STREAM_HOST=idea2-h1-stream.aegis-lab.internal',
    'MACHINE_A_REVERSE_PORT=18077_CONDITIONAL_ON_N0',
    'DIAGNOSTIC_PORT_18078=FORBIDDEN',
  ]) {
    assert.ok(source.includes(contract), `missing registry/stream contract: ${contract}`)
  }
  assert.match(
    source,
    /AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES[\s\S]{0,160}after[\s\S]{0,80}physical-camera/i,
  )
  assert.match(source, /both aliases[\s\S]{0,120}same Machine A physical[\s\S]{0,40}camera/i)
  assert.match(source, /browser[\s\S]{0,80}heartbeat[\s\S]{0,80}cannot[\s\S]{0,100}stream[\s\S]{0,40}destination/i)
})

test('H1 runbook defines every N0-N8 gate with bounded lifecycle fields', () => {
  const source = requiredText(specificationPath)

  for (let phase = 0; phase <= 8; phase += 1) {
    const heading = new RegExp(`^### N${phase} — `, 'm')
    assert.match(source, heading, `missing N${phase} heading`)
    const start = source.search(heading)
    const next = phase === 8 ? source.length : source.search(new RegExp(`^### N${phase + 1} — `, 'm'))
    const section = source.slice(start, next)
    for (const field of ['Prerequisite', 'Mutation scope', 'Expected result', 'Abort conditions', 'Rollback', 'Evidence']) {
      assert.ok(section.includes(`**${field}:**`), `N${phase} is missing ${field}`)
    }
  }
})

test('parent plan and canonical status preserve the H0/H1 gate', () => {
  const parentPlan = requiredText(parentPlanPath)
  const status = requiredText(statusPath)
  const designPath = 'docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md'

  assert.ok(parentPlan.includes(designPath), 'parent Machine A plan must link the H1 design/runbook')
  assert.match(parentPlan, /N0[^\n]*N7[^\n]*PASS/)
  assert.match(parentPlan, /AEGIS_AGENT_CA_BUNDLE[^\n]*implemented[^\n]*verified/i)
  assert.match(status, /H0_STATE=HUMAN_PROVEN_COMPLETE/)
  assert.match(status, /H1_STATE=BLOCKED_PREREQUISITES/)
  assert.match(status, /LIVE_PROVISIONING_PERFORMED=NO/)
  assert.match(status, /PRODUCTION_MUTATION=NO/)
  assert.match(status, /MACHINE_A_MUTATION=NO/)
  assert.doesNotMatch(status, /existing H0-2R continuation still pending/i)
  assert.doesNotMatch(status, /STOP before H0-2R continuation/i)
})
