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
const h1PlanPath = path.join(
  repositoryRoot,
  'docs/superpowers/plans/2026-09-28-idea2-h1-isolated-nonproduction-environment.md',
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
  assert.match(source, /CA_BUNDLE_IMPLEMENTATION=IMPLEMENTED_SOURCE_ONLY/)
  assert.match(source, /CA_BUNDLE_MANAGED_LOCATION=%ProgramData%\\AEGIS\\IdentityAgentConfiguration\\agent-ca-bundle\.pem/)
  assert.match(source, /H1_STATE=BLOCKED_PREREQUISITES/)
  assert.match(source, /N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION/)
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

test('N0 capacity stays fail-closed until repository-derived demand is characterized', () => {
  const source = requiredText(specificationPath)
  const h1Plan = requiredText(h1PlanPath)
  const status = requiredText(statusPath)

  for (const contract of [
    'N0_CAPACITY_CRITERION=NOT_DEFINED',
    'N0_CAPACITY=NOT_PROVEN',
    'N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION',
    'DISK_HEADROOM_CRITERION=NOT_DEFINED',
    'RAM_HEADROOM_CRITERION=NOT_DEFINED',
    'POSTGRES_GROWTH_ALLOWANCE=NOT_DEFINED',
    'IMAGE_CONTAINER_OVERHEAD=NOT_MEASURED',
    'ROLLBACK_EVIDENCE_HEADROOM=NOT_DEFINED',
    'CURRENT_ROOT_AVAILABLE=7.3_GiB',
    'CURRENT_RAM_AVAILABLE_APPROX=5.4_GiB',
    'PRESERVE_EXISTING_FORWARD=172.18.0.1:18077',
    'CANDIDATE_REVERSE_TUPLE=192.168.10.10:18077_AVAILABLE',
    'CANDIDATE_HTTPS_TUPLE=192.168.10.10:18443_AVAILABLE',
    'DIAGNOSTIC_PORT_18078=FORBIDDEN',
  ]) {
    assert.ok(source.includes(contract), `missing N0 capacity/port contract: ${contract}`)
  }

  for (const measurement of [
    'CANDIDATE_IMAGE_UNIQUE_BYTES',
    'CANDIDATE_WRITABLE_LAYER_PEAK_BYTES',
    'POSTGRES_INITIAL_VOLUME_BYTES',
    'POSTGRES_APPROVED_GROWTH_BYTES',
    'ROLLBACK_ARTIFACT_BYTES',
    'EVIDENCE_LOG_ALLOWANCE_BYTES',
    'LAB_PEAK_RSS_BYTES',
  ]) {
    assert.match(source, new RegExp(`\\b${measurement}\\b`), `missing required capacity measurement ${measurement}`)
  }

  assert.match(source, /no Docker prune/i)
  assert.match(source, /N1[\s\S]{0,80}(?:must not|cannot)[\s\S]{0,80}(?:start|begin)/i)
  assert.match(h1Plan, /N0_CAPACITY_CRITERION=NOT_DEFINED/)
  assert.match(h1Plan, /capacity characterization/i)
  assert.match(status, /N0_CAPACITY=NOT_PROVEN/)
  assert.match(status, /N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION/)
})

test('N0 capacity characterization fixes artifacts, read-only probes, formulas, and active-probe bounds', () => {
  const source = requiredText(specificationPath)
  const h1Plan = requiredText(h1PlanPath)
  const status = requiredText(statusPath)

  for (const artifact of [
    'MONITOR_BUILD_CONTEXT=IDEA2-AEGIS_Monitor',
    'MONITOR_DOCKERFILE=IDEA2-AEGIS_Monitor/Dockerfile',
    'MONITOR_IMMUTABLE_IMAGE_ID=NOT_SELECTED',
    'POSTGRES_IMAGE_TAG=postgres:15-alpine',
    'POSTGRES_REPO_DIGEST=NOT_PINNED',
    'H1_GATEWAY_ARTIFACT=NOT_IMPLEMENTED',
    'H1_COMPOSE_ARTIFACT=NOT_IMPLEMENTED',
  ]) {
    assert.ok(source.includes(artifact), `missing candidate artifact classification: ${artifact}`)
  }

  for (const command of [
    'docker ps --filter label=com.docker.compose.project=aegis-prod',
    'docker image inspect',
    'docker manifest inspect --verbose',
    'docker stats --no-stream',
    'docker inspect --size',
    'docker volume inspect',
    'du -sb',
    'df -B1',
    'df -i',
    'docker system df -v',
    'docker builder du',
    'free -b',
    'vmstat 1 5',
    '/proc/pressure/memory',
    'swapon --show --bytes',
  ]) {
    assert.ok(source.includes(command), `missing owner-run read-only command: ${command}`)
  }
  assert.doesNotMatch(source, /docker image history/, 'read-only evidence must not dump image build history')

  assert.match(source, /DISK_REQUIRED_BYTES\s*=/)
  for (const diskTerm of [
    'CANDIDATE_IMAGE_UNIQUE_BYTES',
    'CANDIDATE_BUILD_TRANSIENT_BYTES',
    'POSTGRES_INITIAL_VOLUME_BYTES',
    'POSTGRES_APPROVED_GROWTH_BYTES',
    'CANDIDATE_WRITABLE_LAYER_PEAK_BYTES',
    'ROLLBACK_ARTIFACT_BYTES',
    'EVIDENCE_LOG_ALLOWANCE_BYTES',
    'DISK_SAFETY_RESERVE_BYTES',
  ]) {
    assert.match(source, new RegExp(`DISK_REQUIRED_BYTES[\\s\\S]{0,500}\\b${diskTerm}\\b`))
  }
  assert.match(source, /RAM_REQUIRED_BYTES\s*=\s*LAB_PEAK_RSS_BYTES\s*\+\s*HOST_RAM_RESERVE_BYTES/)
  assert.match(source, /INODE_REQUIRED_COUNT\s*=\s*CHARACTERIZED_PEAK_NEW_INODES\s*\+\s*INODE_SAFETY_RESERVE_COUNT/)
  assert.match(source, /POSTGRES_APPROVED_GROWTH_BYTES=OWNER_DECISION_REQUIRED/)
  assert.match(source, /HOST_RAM_RESERVE_BYTES=OWNER_DECISION_REQUIRED/)
  assert.match(source, /DISK_SAFETY_RESERVE_BYTES=OWNER_DECISION_REQUIRED/)
  assert.match(source, /INODE_SAFETY_RESERVE_COUNT=OWNER_DECISION_REQUIRED/)

  for (const bound of [
    'BOUNDED_ACTIVE_CHARACTERIZATION_REQUIRED=YES',
    'CAPACITY_PROBE_PROJECT=aegis-h1-capacity-probe',
    'CAPACITY_PROBE_HOST_PORTS=NONE',
    'CAPACITY_PROBE_PRODUCTION_NETWORKS=NONE',
    'CAPACITY_PROBE_PRODUCTION_VOLUMES=NONE',
    'CAPACITY_PROBE_STORAGE_WATCHDOG=REQUIRED_NOT_IMPLEMENTED',
    'N1_STARTED=NO',
  ]) {
    assert.ok(source.includes(bound), `missing bounded characterization guardrail: ${bound}`)
  }
  assert.match(source, /HOST_AVAILABLE_BYTES\s*<=\s*DISK_SAFETY_RESERVE_BYTES[\s\S]{0,120}(?:abort|stop)/i)
  assert.match(source, /HOST_MEM_AVAILABLE_BYTES\s*<=\s*HOST_RAM_RESERVE_BYTES[\s\S]{0,120}(?:abort|stop)/i)
  assert.match(source, /Production[\s\S]{0,120}REFERENCE_ONLY/)
  assert.match(h1Plan, /aegis-h1-capacity-probe/)
  assert.match(h1Plan, /owner-run read-only/i)
  assert.match(status, /BOUNDED_ACTIVE_CHARACTERIZATION_REQUIRED=YES/)
  assert.match(status, /N1_STARTED=NO/)
})

test('capacity-probe inputs fail closed on mutable images, missing gateway, and undecided owner budgets', () => {
  const source = requiredText(specificationPath)
  const h1Plan = requiredText(h1PlanPath)
  const status = requiredText(statusPath)

  for (const frozenInput of [
    'CAPACITY_INPUT_FREEZE_SOURCE_SHA=9e39fe5786a5ac7428d2e5eb47cb2285a63bc606',
    'MONITOR_BASE_IMAGE=node:20-alpine',
    'MONITOR_BASE_IMAGE_DIGESTS=REQUIRES_FUTURE_READONLY_REGISTRY_RESOLUTION',
    'POSTGRES_DIGEST=REQUIRES_FUTURE_READONLY_OR_PROBE_RESOLUTION',
    'H1_GATEWAY_ARTIFACT=NOT_IMPLEMENTED',
    'GATEWAY_IMPLEMENTATION_REQUIRED=YES',
    'ACTIVE_CAPACITY_PROBE_READY=NO',
  ]) {
    assert.ok(source.includes(frozenInput), `missing capacity-probe input classification: ${frozenInput}`)
  }

  for (const ownerOption of [
    'POSTGRES_GROWTH_MINIMUM_OPTION',
    'POSTGRES_GROWTH_CONSERVATIVE_OPTION',
    'HOST_RAM_RESERVE_MINIMUM_OPTION',
    'HOST_RAM_RESERVE_CONSERVATIVE_OPTION',
    'DISK_SAFETY_RESERVE_MINIMUM_OPTION',
    'DISK_SAFETY_RESERVE_CONSERVATIVE_OPTION',
    'EVIDENCE_LOG_CAP_MINIMUM_OPTION',
    'EVIDENCE_LOG_CAP_CONSERVATIVE_OPTION',
  ]) {
    assert.match(source, new RegExp(`\\b${ownerOption}\\b`), `missing owner decision option: ${ownerOption}`)
  }

  assert.match(source, /7\.3\s*GiB[\s\S]{0,300}POSTGRES_GROWTH/i)
  assert.match(source, /5\.4\s*GiB[\s\S]{0,300}HOST_RAM_RESERVE/i)
  assert.match(source, /gateway[\s\S]{0,200}(?:must|requires)[\s\S]{0,120}(?:implemented|implementation)[\s\S]{0,200}(?:before|prior to)[\s\S]{0,100}(?:probe|characterization)/i)
  assert.match(h1Plan, /ACTIVE_CAPACITY_PROBE_READY=NO/)
  assert.match(status, /ACTIVE_CAPACITY_PROBE_READY=NO/)
  assert.match(status, /N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION/)
})

test('parent plan and canonical status preserve the H0/H1 gate', () => {
  const parentPlan = requiredText(parentPlanPath)
  const status = requiredText(statusPath)
  const designPath = 'docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md'

  assert.ok(parentPlan.includes(designPath), 'parent Machine A plan must link the H1 design/runbook')
  assert.match(parentPlan, /N0[^\n]*N7[^\n]*PASS/)
  assert.match(parentPlan, /AEGIS_AGENT_CA_BUNDLE[\s\S]{0,180}implemented[\s\S]{0,100}verified/i)
  assert.match(status, /H0_STATE=HUMAN_PROVEN_COMPLETE/)
  assert.match(status, /H1_STATE=BLOCKED_PREREQUISITES/)
  assert.match(status, /LIVE_PROVISIONING_PERFORMED=NO/)
  assert.match(status, /PRODUCTION_MUTATION=NO/)
  assert.match(status, /MACHINE_A_MUTATION=NO/)
  assert.doesNotMatch(status, /existing H0-2R continuation still pending/i)
  assert.doesNotMatch(status, /STOP before H0-2R continuation/i)
})
