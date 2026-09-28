import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(monitorRoot, '..')
const deploymentRoot = path.join(repositoryRoot, 'deploy', 'idea2')
const gatewayRoot = path.join(deploymentRoot, 'h1-gateway')
const probeRoot = path.join(deploymentRoot, 'h1-capacity-probe')
const gatewayDockerfilePath = path.join(gatewayRoot, 'Dockerfile')
const gatewayConfigPath = path.join(gatewayRoot, 'nginx.conf')
const composePath = path.join(deploymentRoot, 'h1-capacity-probe.compose.yml')
const watchdogPath = path.join(probeRoot, 'watchdog.py')
const runnerPath = path.join(probeRoot, 'run_probe.py')
const cleanupPath = path.join(probeRoot, 'cleanup_probe.py')

function requiredText(filePath) {
  assert.ok(fs.existsSync(filePath), `required H1 artifact is missing: ${path.relative(repositoryRoot, filePath)}`)
  return fs.readFileSync(filePath, 'utf8')
}

function pythonCommand() {
  if (process.env.AEGIS_TEST_PYTHON) {
    const result = spawnSync(process.env.AEGIS_TEST_PYTHON, ['--version'], { encoding: 'utf8' })
    if (result.status === 0) return { command: process.env.AEGIS_TEST_PYTHON, prefix: [] }
  }
  for (const command of ['python', 'py']) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version']
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.status === 0) return { command, prefix: command === 'py' ? ['-3'] : [] }
  }
  return null
}

test('dedicated H1 gateway exposes only the browser surface and exact Agent allowlist', () => {
  const config = requiredText(gatewayConfigPath)
  const exactAgentLocations = [...config.matchAll(/location\s+=\s+(\/agent\/internal\/[^\s{]+)/g)].map((match) => match[1])

  assert.deepEqual(exactAgentLocations.sort(), [
    '/agent/internal/agent-auth/challenge',
    '/agent/internal/agent-auth/verify',
    '/agent/internal/alerts',
    '/agent/internal/clips',
    '/agent/internal/detections',
    '/agent/internal/heartbeat',
  ].sort())
  assert.match(config, /location\s+\/monitor\//)
  assert.match(config, /listen\s+443\s+ssl\s+default_server/)
  assert.match(config, /server_name\s+idea2-h1\.aegis-lab\.internal/)
  assert.match(config, /location\s+~\*\s+\^\/monitor\/internal/)
  assert.match(config, /location\s+~\*\s+\^\/internal/)
  assert.match(config, /location\s+~\*\s+\^\/agent/)
  assert.match(config, /proxy_pass\s+http:\/\/monitor:8002\/internal\//)
  assert.equal((config.match(/limit_except\s+POST\s*\{\s*deny all;\s*\}/g) ?? []).length, 6)
  assert.doesNotMatch(config, /location\s+\^~?\s+\/internal\//)
})

test('gateway is H1-only, digest-parameterized, and receives TLS material at runtime', () => {
  const dockerfile = requiredText(gatewayDockerfilePath)
  const config = requiredText(gatewayConfigPath)
  const compose = requiredText(composePath)
  const combined = `${dockerfile}\n${config}\n${compose}`

  assert.match(dockerfile, /^ARG NGINX_BASE_IMAGE$/m)
  assert.match(dockerfile, /^FROM \$\{NGINX_BASE_IMAGE\}$/m)
  assert.match(config, /listen\s+443\s+ssl/)
  assert.match(config, /ssl_certificate\s+\/run\/aegis-h1-tls\/tls\.crt/)
  assert.match(config, /ssl_certificate_key\s+\/run\/aegis-h1-tls\/tls\.key/)
  assert.match(compose, /NGINX_BASE_IMAGE:\s+\$\{GATEWAY_BASE_IMAGE:\?/)
  assert.match(compose, /read_only:\s*true/)
  assert.doesNotMatch(dockerfile, /COPY\s+.*\.(?:key|pem|crt)/i)
  assert.doesNotMatch(combined, /aegis-prod|aegis\.internal|172\.18\.0\.|18078/i)
  assert.doesNotMatch(combined, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/)
})

test('capacity probe compose is isolated, portless, and requires immutable inputs and owner limits', () => {
  const compose = requiredText(composePath)

  assert.match(compose, /^name:\s*aegis-h1-capacity-probe$/m)
  assert.doesNotMatch(compose, /^\s*ports:\s*$/m)
  assert.doesNotMatch(compose, /container_name:/)
  assert.match(compose, /name:\s*aegis-h1-capacity-probe_postgres_data/)
  assert.match(compose, /internal:\s*true/g)
  assert.match(compose, /POSTGRES_IMAGE:\?/)
  assert.match(compose, /MONITOR_BASE_IMAGE:\?/)
  assert.match(compose, /GATEWAY_BASE_IMAGE:\?/)
  assert.match(compose, /POSTGRES_GROWTH_BUDGET_BYTES:\?/)
  assert.match(compose, /HOST_RAM_RESERVE_BYTES:\?/)
  assert.match(compose, /DISK_SAFETY_RESERVE_BYTES:\?/)
  assert.match(compose, /EVIDENCE_LOG_CAP_BYTES:\?/)
  assert.match(compose, /INODE_SAFETY_RESERVE_COUNT:\?/)
  assert.doesNotMatch(compose, /aegis-h1-lab|aegis-prod|aegis\.internal|192\.168\.10\.10|18077|18078/i)
})

test('probe validator rejects tags, missing owner limits, and accidental N1 or Machine A inputs', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(runnerPath)

  const baseEnv = {
    ...process.env,
    POSTGRES_IMAGE: 'postgres:15-alpine',
    MONITOR_BASE_IMAGE: 'node:20-alpine',
    GATEWAY_BASE_IMAGE: 'nginx:alpine',
  }
  const result = spawnSync(python.command, [...python.prefix, runnerPath, '--validate-only'], {
    cwd: repositoryRoot,
    env: baseEnv,
    encoding: 'utf8',
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /immutable.*sha256|digest-form/i)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /probe validation passed/i)
})

test('probe validator accepts only a complete digest-bound, owner-bounded repository contract', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(runnerPath)
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout.trim()
  const evidenceDir = path.join(os.tmpdir(), `aegis-h1-capacity-probe-contract-${process.pid}`)
  const result = spawnSync(python.command, [...python.prefix, runnerPath, '--validate-only'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      MONITOR_SOURCE_SHA: head,
      MONITOR_BASE_IMAGE: `node:20-alpine@sha256:${'a'.repeat(64)}`,
      POSTGRES_IMAGE: `postgres:15-alpine@sha256:${'b'.repeat(64)}`,
      GATEWAY_BASE_IMAGE: `nginx:alpine@sha256:${'c'.repeat(64)}`,
      MONITOR_CANDIDATE_IMAGE: `aegis-h1-capacity-probe-monitor:${head.slice(0, 12)}`,
      GATEWAY_CANDIDATE_IMAGE: `aegis-h1-capacity-probe-gateway:${head.slice(0, 12)}`,
      POSTGRES_GROWTH_BUDGET_BYTES: '1',
      HOST_RAM_RESERVE_BYTES: '1',
      DISK_SAFETY_RESERVE_BYTES: '1',
      EVIDENCE_LOG_CAP_BYTES: '1',
      INODE_SAFETY_RESERVE_COUNT: '1',
      CHARACTERIZATION_MAX_NEW_BYTES: '1',
      GATEWAY_MEMORY_CEILING_BYTES: '1',
      MONITOR_MEMORY_CEILING_BYTES: '1',
      POSTGRES_MEMORY_CEILING_BYTES: '1',
      PROBE_SAMPLE_SECONDS: '1',
      PROBE_SERVICE_LOG_MAX_SIZE: '1m',
      PROBE_EVIDENCE_DIR: evidenceDir,
      PROBE_EXECUTION_SCOPE: 'DISPOSABLE_H1_CAPACITY_PROBE_ONLY',
      PROBE_POSTGRES_PASSWORD: 'ProbeOnlyPassword_123456789',
      PROBE_SESSION_SECRET: 'ProbeOnlySessionSecret_12345678901234567890',
      PROBE_TLS_CERT_FILE: path.join(evidenceDir, 'synthetic.crt'),
      PROBE_TLS_KEY_FILE: path.join(evidenceDir, 'synthetic.key'),
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /probe validation passed; no Docker action was performed/i)
})

test('watchdog policy fails closed on every governed resource boundary', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-h1-watchdog-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

  const limits = {
    disk_safety_reserve_bytes: 100,
    inode_safety_reserve_count: 10,
    host_ram_reserve_bytes: 100,
    evidence_log_cap_bytes: 100,
    postgres_growth_budget_bytes: 100,
    service_memory_ceiling_bytes: { gateway: 100, monitor: 100, postgres: 100 },
  }
  const safe = {
    host_available_bytes: 101,
    host_available_inodes: 11,
    host_mem_available_bytes: 101,
    evidence_log_bytes: 99,
    postgres_growth_bytes: 99,
    service_rss_bytes: { gateway: 99, monitor: 99, postgres: 99 },
  }

  function evaluate(snapshot) {
    const limitsPath = path.join(tempRoot, `limits-${Math.random()}.json`)
    const snapshotPath = path.join(tempRoot, `snapshot-${Math.random()}.json`)
    fs.writeFileSync(limitsPath, JSON.stringify(limits))
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot))
    return spawnSync(
      python.command,
      [...python.prefix, watchdogPath, '--evaluate', '--limits-json', limitsPath, '--snapshot-json', snapshotPath],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
  }

  assert.equal(evaluate(safe).status, 0)
  for (const unsafe of [
    { ...safe, host_available_bytes: 100 },
    { ...safe, host_available_inodes: 10 },
    { ...safe, host_mem_available_bytes: 100 },
    { ...safe, evidence_log_bytes: 101 },
    { ...safe, postgres_growth_bytes: 101 },
    { ...safe, service_rss_bytes: { ...safe.service_rss_bytes, monitor: 101 } },
  ]) {
    const result = evaluate(unsafe)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /BLOCKED/)
  }
})

test('cleanup implementation is exact and never uses broad Docker prune operations', () => {
  const cleanup = requiredText(cleanupPath)
  const runner = requiredText(runnerPath)
  const combined = `${cleanup}\n${runner}`

  assert.match(cleanup, /aegis-h1-capacity-probe/)
  assert.match(cleanup, /aegis-h1-capacity-probe_postgres_data/)
  assert.match(cleanup, /aegis-h1-capacity-builder/)
  assert.match(cleanup, /--project-name/)
  assert.doesNotMatch(combined, /docker\s+(?:system|image|container|volume|network|builder)\s+prune/)
  assert.doesNotMatch(cleanup, /aegis-prod|aegis-h1-lab|192\.168\.10\.10|18077|18078|18443/i)
})

test('cleanup plan names only the exact project, volume, and builder', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  const result = spawnSync(python.command, [...python.prefix, cleanupPath, '--plan'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /aegis-h1-capacity-probe/)
  assert.match(result.stdout, /aegis-h1-capacity-probe_postgres_data/)
  assert.match(result.stdout, /aegis-h1-capacity-builder/)
  assert.doesNotMatch(result.stdout, /prune|aegis-h1-lab|18078/i)
})

test('probe source never promotes N0 or N1 and final authority rejects tag-only identities', () => {
  const files = [requiredText(composePath), requiredText(watchdogPath), requiredText(runnerPath), requiredText(cleanupPath)]
  const combined = files.join('\n')

  assert.doesNotMatch(combined, /N0_(?:CAPACITY_)?(?:STATE\s*=\s*)?PASS|N1_STARTED\s*=\s*YES/)
  assert.match(combined, /@sha256:/)
  assert.match(combined, /REQUIRES_SEPARATE_READONLY_REGISTRY_LOOKUP|digest-form/i)
})
