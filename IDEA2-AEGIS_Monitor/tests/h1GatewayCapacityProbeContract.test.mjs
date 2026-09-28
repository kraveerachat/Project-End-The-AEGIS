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
const dockerExecPath = path.join(probeRoot, 'docker_exec.py')
const monitorDockerignorePath = path.join(monitorRoot, '.dockerignore')
const h1SpecPath = path.join(repositoryRoot, 'docs', 'superpowers', 'specs', '2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md')
const h1PlanPath = path.join(repositoryRoot, 'docs', 'superpowers', 'plans', '2026-09-28-idea2-h1-isolated-nonproduction-environment.md')
const idea2StatusPath = path.join(repositoryRoot, 'Obsidian_AEGIS_Vault', 'AEGIS_Knowledge', 'idea2', 'idea2-status.md')

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

function runProbePython(python, source, env = {}) {
  return spawnSync(python.command, [...python.prefix, '-c', source], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

test('Docker execution mode is explicit and sudo-only mode uses a narrow non-interactive prefix', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(dockerExecPath)
  const source = [
    'import json, os, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import docker_exec',
    'plain = docker_exec.docker_command("ps")',
    'os.environ["AEGIS_CAPACITY_PROBE_COMPOSE_ENV_FILE"] = "/tmp/aegis-h1-probe.compose.env"',
    'compose = docker_exec.docker_command("config", compose=True)',
    'print(json.dumps({"plain": plain, "compose": compose}))',
  ].join('\n')

  const direct = runProbePython(python, source, { AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'direct' })
  assert.equal(direct.status, 0, direct.stderr)
  assert.deepEqual(JSON.parse(direct.stdout), {
    plain: ['docker', 'ps'],
    compose: ['docker', 'compose', '--env-file', '/tmp/aegis-h1-probe.compose.env', 'config'],
  })

  const sudo = runProbePython(python, source, { AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive' })
  assert.equal(sudo.status, 0, sudo.stderr)
  const sudoCommands = JSON.parse(sudo.stdout)
  assert.deepEqual(sudoCommands.plain, ['sudo', '-n', 'env', '-u', 'DOCKER_HOST', 'docker', 'ps'])
  assert.deepEqual(sudoCommands.compose, [
    'sudo', '-n', 'env', '-u', 'DOCKER_HOST', 'docker', 'compose',
    '--env-file', '/tmp/aegis-h1-probe.compose.env', 'config',
  ])
  assert.doesNotMatch(JSON.stringify(sudoCommands), /(?:^|\W)(?:-E|--preserve-env)(?:\W|$)/)
})

test('sudo-only Docker mode fails closed when the human sudo cache is unavailable', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(dockerExecPath)
  const source = [
    'import json, sys',
    'from types import SimpleNamespace',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import docker_exec',
    'calls = []',
    'def denied(command, **kwargs):',
    '    calls.append(command)',
    '    return SimpleNamespace(returncode=1, stdout="", stderr="sudo: a password is required")',
    'docker_exec.subprocess.run = denied',
    'try:',
    '    docker_exec.ensure_docker_authorized()',
    'except Exception as exc:',
    '    print(json.dumps({"calls": calls, "error": str(exc)}))',
    'else:',
    '    raise SystemExit("authorization unexpectedly passed")',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.deepEqual(evidence.calls, [[
    'sudo', '-n', 'env', '-u', 'DOCKER_HOST', 'docker',
    'version', '--format', '{{.Server.Version}}',
  ]])
  assert.match(evidence.error, /sudo -v|authorization.*unavailable|cache/i)
})

test('watchdog fails closed when its exact emergency stop command is denied', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, os, sys',
    'from types import SimpleNamespace',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'calls = []',
    'def denied(command, **kwargs):',
    '    calls.append(command)',
    '    return SimpleNamespace(returncode=1, stdout="", stderr="sudo: a password is required")',
    'watchdog.subprocess.run = denied',
    'try:',
    '    watchdog.stop_probe()',
    'except Exception as exc:',
    '    print(json.dumps({"calls": calls, "error": str(exc)}))',
    'else:',
    '    raise SystemExit("emergency stop failure was ignored")',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
    AEGIS_CAPACITY_PROBE_COMPOSE_ENV_FILE: '/tmp/aegis-h1-probe.compose.env',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.deepEqual(evidence.calls[0].slice(0, 6), [
    'sudo', '-n', 'env', '-u', 'DOCKER_HOST', 'docker',
  ])
  assert.match(evidence.error, /stop.*failed|stop.*unavailable|sudo -v/i)
})

test('Compose inputs use an owner-only file and are scrubbed from Docker child environments', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(dockerExecPath)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-h1-docker-exec-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const evidenceDir = path.join(tempRoot, 'aegis-h1-capacity-probe-security-test')
  fs.mkdirSync(evidenceDir)
  const source = [
    'import json, os, stat, sys',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import docker_exec',
    `evidence = Path(${JSON.stringify(evidenceDir)})`,
    'for name in docker_exec.COMPOSE_ENV_NAMES:',
    '    os.environ[name] = "ProbeSafeValue_123456789"',
    'os.environ["PROBE_POSTGRES_PASSWORD"] = "ProbePassword_123456789"',
    'os.environ["PROBE_SESSION_SECRET"] = "ProbeSessionSecret_123456789012345"',
    'path = docker_exec.prepare_compose_environment(evidence)',
    'mode = stat.S_IMODE(path.stat().st_mode)',
    'child = docker_exec.subprocess_environment()',
    'command = docker_exec.docker_command("config", compose=True)',
    'keys = [line.split("=", 1)[0] for line in path.read_text(encoding="utf-8").splitlines()]',
    'docker_exec.remove_compose_environment(path)',
    'print(json.dumps({"platform": os.name, "mode": mode, "keys": keys, "child_has_inputs": any(name in child for name in docker_exec.COMPOSE_ENV_NAMES), "command": command, "removed": not path.exists()}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  if (evidence.platform === 'posix') assert.equal(evidence.mode & 0o077, 0)
  assert.deepEqual(evidence.keys.sort(), [
    'DISK_SAFETY_RESERVE_BYTES',
    'EVIDENCE_LOG_CAP_BYTES',
    'GATEWAY_BASE_IMAGE',
    'GATEWAY_CANDIDATE_IMAGE',
    'GATEWAY_MEMORY_CEILING_BYTES',
    'HOST_RAM_RESERVE_BYTES',
    'INODE_SAFETY_RESERVE_COUNT',
    'MONITOR_BASE_IMAGE',
    'MONITOR_CANDIDATE_IMAGE',
    'MONITOR_MEMORY_CEILING_BYTES',
    'POSTGRES_GROWTH_BUDGET_BYTES',
    'POSTGRES_IMAGE',
    'POSTGRES_MEMORY_CEILING_BYTES',
    'PROBE_POSTGRES_PASSWORD',
    'PROBE_SERVICE_LOG_MAX_SIZE',
    'PROBE_SESSION_SECRET',
    'PROBE_TLS_CERT_FILE',
    'PROBE_TLS_KEY_FILE',
  ].sort())
  assert.equal(evidence.child_has_inputs, false)
  assert.equal(evidence.removed, true)
  assert.doesNotMatch(JSON.stringify(evidence.command), /ProbePassword|ProbeSessionSecret/)
})

test('watchdog measurements stay behind Docker authority and never read root-owned Docker paths', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, os, sys, tempfile',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'calls = []',
    'def fake_run(command):',
    '    calls.append(command)',
    '    joined = " ".join(command)',
    '    if " ps " in f" {joined} ": return "g|gateway\\nm|monitor\\np|postgres"',
    '    if " stats " in f" {joined} ": return "1MiB / 1GiB"',
    '    if "{{.SizeRw}}" in joined: return "1024"',
    '    if "HostConfig.LogConfig" in joined: return json.dumps({"Type":"json-file","Config":{"max-size":"16m","max-file":"1"}})',
    '    if " du -sk /var/lib/postgresql/data" in joined: return "42\\t/var/lib/postgresql/data"',
    '    raise RuntimeError(joined)',
    'watchdog._run = fake_run',
    'watchdog._host_metrics = lambda: (10_000, 1_000, 20_000)',
    'with tempfile.TemporaryDirectory(prefix="aegis-h1-capacity-probe-watchdog-") as root:',
    '    snapshot = watchdog.capture_snapshot(Path(root), 40 * 1024, 11_000)',
    'print(json.dumps({"snapshot": snapshot, "calls": calls}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
    AEGIS_CAPACITY_PROBE_COMPOSE_ENV_FILE: '/tmp/aegis-h1-probe.compose.env',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.snapshot.postgres_volume_bytes, 42 * 1024)
  assert.equal(evidence.snapshot.postgres_growth_bytes, 2 * 1024)
  assert.equal(evidence.snapshot.evidence_log_bytes, 3 * 16 * 1024 * 1024)
  const commands = JSON.stringify(evidence.calls)
  assert.match(commands, /du.*-sk.*postgresql\/data/)
  assert.doesNotMatch(commands, /Mountpoint|LogPath/)
})

test('H1 runbook records the exact sudo-only human flow without broad privilege changes', () => {
  const spec = requiredText(h1SpecPath)
  const plan = requiredText(h1PlanPath)
  const status = requiredText(idea2StatusPath)
  const combined = `${spec}\n${plan}\n${status}`

  for (const text of [spec, plan, status]) {
    assert.match(text, /CAPACITY_PROBE_DOCKER_EXECUTION=EXPLICIT_DIRECT_OR_SUDO_NONINTERACTIVE/)
  }
  assert.match(spec, /sudo -v/)
  assert.match(spec, /AEGIS_CAPACITY_PROBE_DOCKER_MODE=sudo-noninteractive/)
  assert.match(spec, /run_probe\.py --validate-only/)
  assert.match(spec, /AEGIS_CAPACITY_PROBE_AUTHORIZED=YES python3 .*run_probe\.py --run/)
  assert.match(spec, /AEGIS_CAPACITY_PROBE_CLEANUP_AUTHORIZED=YES python3 .*cleanup_probe\.py --execute/)
  assert.match(spec, /sudo -n env -u DOCKER_HOST docker/)
  assert.doesNotMatch(combined, /sudo -E python3|--preserve-env|usermod|gpasswd|chmod\s+.*docker\.sock/)
  assert.match(combined, /ACTIVE_CAPACITY_PROBE=NOT_RUN/)
  assert.match(combined, /N1_STARTED=NO/)
})

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
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'direct',
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
      AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
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
      PROBE_WORKLOAD_REQUEST_COUNT: '1',
      PROBE_WORKLOAD_POSTGRES_ROWS: '1',
      PROBE_WORKLOAD_POSTGRES_PAYLOAD_BYTES: '1',
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
    characterization_max_new_bytes: 100,
    service_memory_ceiling_bytes: { gateway: 100, monitor: 100, postgres: 100 },
  }
  const safe = {
    host_available_bytes: 101,
    host_available_inodes: 11,
    host_mem_available_bytes: 101,
    evidence_log_bytes: 99,
    postgres_growth_bytes: 99,
    probe_new_bytes: 99,
    service_memory_usage_bytes: { gateway: 99, monitor: 99, postgres: 99 },
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
    { ...safe, probe_new_bytes: 101 },
    { ...safe, service_memory_usage_bytes: { ...safe.service_memory_usage_bytes, monitor: 101 } },
  ]) {
    const result = evaluate(unsafe)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /BLOCKED/)
  }
})

test('probe enforces a bounded workload, immutable clean build context, immediate stop, and finally-safe cleanup', () => {
  const runner = requiredText(runnerPath)
  const dockerignore = requiredText(monitorDockerignorePath)

  assert.match(runner, /git["']?,\s*["']status["']?[\s\S]{0,180}--porcelain/)
  assert.match(runner, /source_tree/)
  assert.match(dockerignore, /^node_modules\/?$/m)
  assert.match(dockerignore, /^dist\/?$/m)
  assert.match(dockerignore, /^\.env/m)
  for (const ignoredPattern of [
    '*.log',
    '*.pt',
    '*.h5',
    '*.onnx',
    '*.pth',
    '*.weights',
    '*.local',
    '.pytest_cache',
  ]) {
    const escapedPattern = ignoredPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(dockerignore, new RegExp(`^${escapedPattern}/?$`, 'm'))
  }

  assert.match(runner, /def _run_bounded_workload\(/)
  assert.match(runner, /def _run_workload_guarded\(/)
  assert.match(runner, /PROBE_WORKLOAD_REQUEST_COUNT/)
  assert.match(runner, /PROBE_WORKLOAD_POSTGRES_ROWS/)
  assert.match(runner, /PROBE_WORKLOAD_POSTGRES_PAYLOAD_BYTES/)
  assert.match(runner, /\/healthz/)
  assert.match(runner, /capacity_probe\.synthetic_events/)
  assert.match(runner, /_run_workload_guarded\([\s\S]{0,500}postgres_initial_volume_bytes/)
  assert.match(runner, /_run_workload_guarded\([\s\S]{0,500}peak_snapshot/)
  assert.match(runner, /while time\.monotonic\(\) < deadline:[\s\S]{0,180}_guard_host\(/)

  assert.doesNotMatch(runner, /except Exception:\s*\n\s*pass/)
  assert.match(runner, /watchdog\.stop_probe\(\)[\s\S]{0,180}probe services did not become measurable/)
  assert.match(runner, /finally:[\s\S]{0,400}_record_introduced_images/)
  assert.match(runner, /capacity-measurements\.json[\s\S]{0,500}evaluate_snapshot/)
  assert.match(runner, /postgres_initial_volume_bytes/)
  for (const peakMetric of [
    'evidence_log_bytes',
    'postgres_growth_bytes',
    'postgres_volume_bytes',
    'probe_new_bytes',
  ]) {
    assert.match(runner, new RegExp(`peak_snapshot\\["${peakMetric}"\\]\\s*=\\s*max`))
  }
  for (const minimumMetric of [
    'host_available_bytes',
    'host_available_inodes',
    'host_mem_available_bytes',
  ]) {
    assert.match(runner, new RegExp(`peak_snapshot\\["${minimumMetric}"\\]\\s*=\\s*min`))
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
  const evidenceDir = path.join(os.tmpdir(), `aegis-h1-capacity-probe-cleanup-${process.pid}`)
  const result = spawnSync(
    python.command,
    [...python.prefix, cleanupPath, '--plan', '--evidence-dir', evidenceDir],
    {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
    },
    encoding: 'utf8',
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /aegis-h1-capacity-probe/)
  assert.match(result.stdout, /aegis-h1-capacity-probe_postgres_data/)
  assert.match(result.stdout, /aegis-h1-capacity-builder/)
  assert.doesNotMatch(result.stdout, /prune|aegis-h1-lab|18078/i)
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const command = JSON.parse(line)
    if (command[0] === 'remove-tree') continue
    assert.deepEqual(command.slice(0, 6), ['sudo', '-n', 'env', '-u', 'DOCKER_HOST', 'docker'])
  }
})

test('probe source never promotes N0 or N1 and final authority rejects tag-only identities', () => {
  const files = [requiredText(composePath), requiredText(watchdogPath), requiredText(runnerPath), requiredText(cleanupPath)]
  const combined = files.join('\n')

  assert.doesNotMatch(combined, /N0_(?:CAPACITY_)?(?:STATE\s*=\s*)?PASS|N1_STARTED\s*=\s*YES/)
  assert.match(combined, /@sha256:/)
  assert.match(combined, /REQUIRES_SEPARATE_READONLY_REGISTRY_LOOKUP|digest-form/i)
})
