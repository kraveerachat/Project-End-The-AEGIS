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
    'import json, sys, tempfile',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'calls = []',
    'def fake_run(command, **kwargs):',
    '    calls.append(command)',
    '    joined = " ".join(command)',
    '    if " ps " in f" {joined} ": return "g\\nm\\np"',
    '    if " inspect " in f" {joined} " and "HostConfig.LogConfig" not in joined and "{{.SizeRw}}" not in joined: return "g|/probe-gateway|gateway|running|0|none\\nm|/probe-monitor|monitor|running|0|none\\np|/probe-postgres|postgres|running|0|healthy"',
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

test('service discovery reports an expected container that exited after Compose start', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'calls = []',
    'def fake_run(command, **kwargs):',
    '    calls.append(command)',
    '    if " ps " in f" {" ".join(command)} ":',
    '        return "gateway-id\\nmonitor-id\\npostgres-id"',
    '    if " inspect " in f" {" ".join(command)} ":',
    '        return "gateway-id|/probe-gateway|gateway|exited|2|none\\nmonitor-id|/probe-monitor|monitor|running|0|none\\npostgres-id|/probe-postgres|postgres|running|0|healthy"',
    '    raise RuntimeError(command)',
    'watchdog._run = fake_run',
    'try:',
    '    watchdog._probe_containers()',
    'except watchdog.ProbeServicesUnavailable as exc:',
    '    print(json.dumps({"error":str(exc),"evidence":exc.evidence,"calls":calls}))',
    'else:',
    '    raise SystemExit("exited gateway was accepted as measurable")',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.deepEqual(evidence.evidence.missing_services, ['gateway'])
  assert.deepEqual(evidence.evidence.containers[0], {
    container_id: 'gateway-id',
    name: 'probe-gateway',
    service: 'gateway',
    state: 'exited',
    exit_code: 2,
    health: 'none',
  })
  assert.match(evidence.error, /gateway.*exited.*exit_code=2/i)
  assert.ok(evidence.calls[0].includes('--all'))
  assert.ok(evidence.calls[0].includes('--quiet'))
})

test('container inspection treats absent Health as neutral while preserving health and state failures', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'rows = ["gateway-id|/probe-gateway|gateway|running|0|none\\nmonitor-id|/probe-monitor|monitor|running|0|healthy\\npostgres-id|/probe-postgres|postgres|running|0|healthy"]',
    'templates = []',
    'def fake_run(command, **kwargs):',
    '    joined = " ".join(command)',
    '    if " ps " in f" {joined} ":',
    '        return "gateway-id\\nmonitor-id\\npostgres-id"',
    '    if " inspect " in f" {joined} ":',
    '        template = command[command.index("--format") + 1]',
    '        templates.append(template)',
    '        if ".State.Health" in template:',
    '            raise RuntimeError("unsafe direct Health lookup")',
    '        if "index .State \\"Health\\"" not in template:',
    '            raise RuntimeError("optional Health lookup missing")',
    '        return rows[0]',
    '    raise RuntimeError(command)',
    'watchdog._run = fake_run',
    'accepted = watchdog._probe_containers()',
    'rows[0] = "gateway-id|/probe-gateway|gateway|running|0|unhealthy\\nmonitor-id|/probe-monitor|monitor|running|0|none\\npostgres-id|/probe-postgres|postgres|running|0|healthy"',
    'try:',
    '    watchdog._probe_containers()',
    'except watchdog.ProbeServicesUnavailable as exc:',
    '    unhealthy = exc.evidence',
    'else:',
    '    raise SystemExit("unhealthy gateway was accepted")',
    'rows[0] = "gateway-id|/probe-gateway|gateway|exited|2|none\\nmonitor-id|/probe-monitor|monitor|running|0|none\\npostgres-id|/probe-postgres|postgres|running|0|healthy"',
    'try:',
    '    watchdog._probe_containers()',
    'except watchdog.ProbeServicesUnavailable as exc:',
    '    exited = exc.evidence',
    'else:',
    '    raise SystemExit("exited gateway without Health was accepted")',
    'print(json.dumps({"accepted":accepted,"unhealthy":unhealthy,"exited":exited,"templates":templates}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.deepEqual(evidence.accepted, {
    gateway: 'gateway-id',
    monitor: 'monitor-id',
    postgres: 'postgres-id',
  })
  assert.equal(evidence.unhealthy.containers[0].health, 'unhealthy')
  assert.deepEqual(evidence.unhealthy.missing_services, ['gateway'])
  assert.equal(evidence.exited.containers[0].state, 'exited')
  assert.equal(evidence.exited.containers[0].exit_code, 2)
  assert.equal(evidence.exited.containers[0].health, 'none')
  assert.deepEqual(evidence.exited.missing_services, ['gateway'])
  assert.ok(evidence.templates.every((template) => template.includes('index .State "Health"')))
  assert.doesNotMatch(JSON.stringify(evidence), /password|secret|private.?key|environment/i)
})

test('service discovery rejects an unlabelled project container even when all expected services run', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'def fake_run(command, **kwargs):',
    '    if " ps " in f" {" ".join(command)} ":',
    '        return "gateway-id\\nmonitor-id\\npostgres-id\\norphan-id"',
    '    if " inspect " in f" {" ".join(command)} ":',
    '        return "gateway-id|/probe-gateway|gateway|running|0|none\\nmonitor-id|/probe-monitor|monitor|running|0|none\\npostgres-id|/probe-postgres|postgres|running|0|healthy\\norphan-id|/probe-orphan||running|0|none"',
    '    raise RuntimeError(command)',
    'watchdog._run = fake_run',
    'try:',
    '    watchdog._probe_containers()',
    'except watchdog.ProbeServicesUnavailable as exc:',
    '    print(json.dumps({"error":str(exc),"evidence":exc.evidence}))',
    'else:',
    '    raise SystemExit("unlabelled project container was accepted")',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'direct',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.deepEqual(evidence.evidence.missing_services, [])
  assert.equal(evidence.evidence.invalid_containers[0].service, null)
  assert.deepEqual(evidence.evidence.invalid_containers[0].reasons, ['unexpected-service-label'])
  assert.match(evidence.error, /service=unlabelled/i)
})

test('service discovery rejects a nameless expected project container', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'def fake_run(command, **kwargs):',
    '    if " ps " in f" {" ".join(command)} ":',
    '        return "gateway-id\\nmonitor-id\\npostgres-id"',
    '    if " inspect " in f" {" ".join(command)} ":',
    '        return "gateway-id||gateway|running|0|none\\nmonitor-id|/probe-monitor|monitor|running|0|none\\npostgres-id|/probe-postgres|postgres|running|0|healthy"',
    '    raise RuntimeError(command)',
    'watchdog._run = fake_run',
    'try:',
    '    watchdog._probe_containers()',
    'except watchdog.ProbeServicesUnavailable as exc:',
    '    print(json.dumps({"error":str(exc),"evidence":exc.evidence}))',
    'else:',
    '    raise SystemExit("nameless gateway container was accepted")',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'direct',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.deepEqual(evidence.evidence.missing_services, [])
  assert.deepEqual(evidence.evidence.invalid_containers[0].reasons, ['missing-container-name'])
  assert.match(evidence.error, /name=missing/i)
})

test('startup diagnostics capture only bounded redacted gateway and monitor logs', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(runnerPath)
  const source = [
    'import json, os, sys, tempfile',
    'from pathlib import Path',
    'from types import SimpleNamespace',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import run_probe',
    'calls = []',
    'gateway_id = "a" * 64',
    'monitor_id = "b" * 64',
    'postgres_id = "c" * 64',
    'timeouts = []',
    'clock = iter((0, 0, 6))',
    'def fake_run(command, *, timeout, byte_cap):',
    '    calls.append(command)',
    '    timeouts.append(timeout)',
    '    assert byte_cap == 32768',
    '    container_id = command[-1]',
    '    if container_id == gateway_id:',
    '        output = (("Ã¢â€šÂ¬" * 20000) + "\\nprivate-material\\n-----END PRIVATE KEY-----").encode("utf-8")',
    '    elif container_id == monitor_id:',
    '        output = "SESSION_SECRET=ProbeSessionSecret123456789012345\\n-----BEGIN PRIVATE KEY-----\\nprivate-material".encode("utf-8")',
    '    else:',
    '        raise RuntimeError("unexpected container log request")',
    '    return SimpleNamespace(returncode=0, stdout=output, truncated=True)',
    'run_probe._run_bounded_command_output = fake_run',
    'run_probe.time.monotonic = lambda: next(clock)',
    'readiness = {"containers": [',
    '    {"container_id":gateway_id,"name":"probe-gateway","service":"gateway","state":"exited","exit_code":1,"health":"none"},',
    '    {"container_id":monitor_id,"name":"probe-monitor","service":"monitor","state":"exited","exit_code":1,"health":"none"},',
    '    {"container_id":postgres_id,"name":"probe-postgres","service":"postgres","state":"running","exit_code":0,"health":"healthy"},',
    ']}',
    'with tempfile.TemporaryDirectory(prefix="aegis-h1-capacity-probe-startup-logs-") as root:',
    '    evidence_dir = Path(root)',
    '    path = run_probe._capture_service_startup_diagnostics(evidence_dir, readiness)',
    '    evidence = json.loads(path.read_text(encoding="utf-8"))',
    'print(json.dumps({"calls":calls,"timeouts":timeouts,"evidence":evidence}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
    PROBE_POSTGRES_PASSWORD: 'ProbePassword1234567890',
    PROBE_SESSION_SECRET: 'ProbeSessionSecret123456789012345',
  })

  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.calls.length, 2)
  assert.deepEqual(observed.timeouts, [10, 4])
  assert.ok(observed.calls.every((command) => command.slice(-4, -1).join(' ') === 'logs --tail 200'))
  assert.ok(observed.calls.every((command) => !command.includes('c'.repeat(64))))
  assert.deepEqual(Object.keys(observed.evidence.services).sort(), ['gateway', 'monitor'])
  assert.equal(observed.evidence.per_service_byte_cap, 32768)
  assert.equal(observed.evidence.services.gateway.truncated, true)
  assert.ok(Buffer.byteLength(observed.evidence.services.gateway.log, 'utf8') <= 32768)
  assert.ok(Buffer.byteLength(observed.evidence.services.monitor.log, 'utf8') <= 32768)
  assert.doesNotMatch(JSON.stringify(observed.evidence), /ProbePassword1234567890|ProbeSessionSecret123456789012345|private-material/)
  assert.match(observed.evidence.services.gateway.log, /\[REDACTED PRIVATE KEY\]/)
  assert.match(observed.evidence.services.monitor.log, /\[REDACTED PRIVATE KEY\]/)
  assert.doesNotMatch(JSON.stringify(observed.evidence), /postgres-id|environment/i)
})

test('startup diagnostic bounded collector preserves caller session and uses a POSIX process group', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(runnerPath)
  const source = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import run_probe',
    'observed = {}',
    'run_probe.os.name = "posix"',
    'def fake_popen(command, **kwargs):',
    '    observed["start_new_session"] = kwargs.get("start_new_session")',
    '    observed["process_group"] = kwargs.get("process_group")',
    '    raise RuntimeError("captured-popen")',
    'run_probe.subprocess.Popen = fake_popen',
    'try:',
    '    run_probe._run_bounded_command_output(["sudo","-n","docker","version"], timeout=1, byte_cap=32)',
    'except RuntimeError as exc:',
    '    assert str(exc) == "captured-popen"',
    'print(json.dumps(observed))',
  ].join('\n')

  const result = runProbePython(python, source)

  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout)
  assert.notEqual(observed.start_new_session, true)
  assert.equal(observed.process_group, 0)
})
test('startup diagnostic stream collector never retains more than its byte cap', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(runnerPath)
  const source = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import run_probe',
    'chunks = [b"x" * 65536, ("Ã¢â€šÂ¬" * 20000).encode("utf-8")]',
    'tail, truncated = run_probe._bounded_bytes_tail(chunks, 32768)',
    'text, text_truncated = run_probe._bounded_log_tail(tail.decode("utf-8", errors="replace"))',
    'print(json.dumps({"tail_bytes":len(tail),"text_bytes":len(text.encode("utf-8")),"truncated":truncated,"text_truncated":text_truncated}))',
  ].join('\n')
  const result = runProbePython(python, source)

  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.tail_bytes, 32768)
  assert.ok(observed.text_bytes <= 32768)
  assert.equal(observed.truncated, true)
  assert.equal(observed.text_truncated, true)
  assert.doesNotMatch(requiredText(runnerPath), /subprocess\.run\([\s\S]{0,500}docker_command\([\s\S]{0,200}["']logs["']/)
})

test('readiness timeout preserves safe service state and exact cleanup without accepting a snapshot', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(runnerPath)
  const source = [
    'import json, sys, tempfile',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import run_probe, watchdog',
    'events = []',
    'clock = iter((0, 1, 121))',
    'baseline = {"host_available_bytes":10000,"host_available_inodes":1000,"host_mem_available_bytes":20000,"evidence_log_bytes":0,"postgres_growth_bytes":0,"probe_new_bytes":0,"service_memory_usage_bytes":{"gateway":0,"monitor":0,"postgres":0}}',
    'failure = watchdog.ProbeServicesUnavailable(["gateway"], [{"container_id":"gateway-id","name":"probe-gateway","service":"gateway","state":"exited","exit_code":2,"health":"none"}])',
    'watchdog.limits_from_environment = lambda: {}',
    'watchdog.capture_snapshot = lambda *args, **kwargs: (_ for _ in ()).throw(failure)',
    'watchdog.stop_probe = lambda: events.append("stop")',
    'run_probe.time.monotonic = lambda: next(clock)',
    'run_probe.time.sleep = lambda seconds: None',
    'run_probe._assert_no_probe_collision = lambda: None',
    'run_probe._image_id = lambda reference: None',
    'run_probe._image_size = lambda reference: 1',
    'run_probe._guard_host = lambda *args, **kwargs: dict(baseline)',
    'run_probe._run = lambda *args, **kwargs: ""',
    'run_probe._run_guarded = lambda *args, **kwargs: None',
    'run_probe._record_introduced_images = lambda before, evidence, **kwargs: evidence / "introduced-images.json"',
    'run_probe._capture_service_startup_diagnostics = lambda evidence, readiness: events.append("diagnostic")',
    'def exact_cleanup(**kwargs):',
    '    events.append("cleanup")',
    '    assert kwargs["execute"] is True',
    '    assert kwargs["delete_evidence"] is False',
    'run_probe.cleanup_probe.cleanup = exact_cleanup',
    'with tempfile.TemporaryDirectory(prefix="aegis-h1-capacity-probe-readiness-") as root:',
    '    evidence_dir = Path(root)',
    '    try:',
    '        run_probe._run_probe_authorized({"source_sha":"a"*40,"source_tree":"b"*40}, evidence_dir)',
    '    except watchdog.ProbeServicesUnavailable as exc:',
    '        error = str(exc)',
    '    else:',
    '        raise SystemExit("incomplete readiness was accepted as PASS")',
    '    readiness_path = evidence_dir / "service-readiness.json"',
    '    readiness = json.loads(readiness_path.read_text(encoding="utf-8")) if readiness_path.exists() else None',
    '    probe_log = (evidence_dir / "probe.log").read_text(encoding="utf-8")',
    '    complete = (evidence_dir / "capacity-measurements.json").exists()',
    'print(json.dumps({"complete":complete,"error":error,"events":events,"readiness":readiness,"probe_log":probe_log}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
    AEGIS_CAPACITY_PROBE_COMPOSE_ENV_FILE: '/tmp/aegis-h1-probe.compose.env',
    MONITOR_CANDIDATE_IMAGE: `aegis-h1-capacity-probe-monitor:${'a'.repeat(12)}`,
    GATEWAY_CANDIDATE_IMAGE: `aegis-h1-capacity-probe-gateway:${'a'.repeat(12)}`,
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.complete, false)
  assert.deepEqual(evidence.events, ['diagnostic', 'stop', 'cleanup'])
  assert.deepEqual(evidence.readiness.missing_services, ['gateway'])
  assert.equal(evidence.readiness.containers[0].exit_code, 2)
  assert.match(evidence.error, /gateway.*exited.*exit_code=2/i)
  assert.match(evidence.probe_log, /gateway.*exited.*exit_code=2/i)
  assert.doesNotMatch(JSON.stringify(evidence.readiness), /password|secret|private.?key|environment/i)
})

test('PostgreSQL volume measurement uses the discovered container directly and captures exact bytes', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'calls = []',
    'def measured(command, **kwargs):',
    '    calls.append(command)',
    '    return "42\\t/var/lib/postgresql/data"',
    'watchdog._run = measured',
    'value = watchdog._postgres_volume_bytes("postgres-container-id")',
    'print(json.dumps({"calls": calls, "value": value}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.value, 42 * 1024)
  assert.deepEqual(evidence.calls, [[
    'sudo', '-n', 'env', '-u', 'DOCKER_HOST', 'docker',
    'exec', 'postgres-container-id', 'du', '-sk', '/var/lib/postgresql/data',
  ]])
})

test('PostgreSQL volume measurement timeout remains bounded and fails closed', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, subprocess, sys',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'observed = {}',
    'def timed_out(command, **kwargs):',
    '    observed["command"] = command',
    '    observed["timeout"] = kwargs.get("timeout")',
    '    raise subprocess.TimeoutExpired(command, kwargs.get("timeout"))',
    'watchdog.subprocess.run = timed_out',
    'try:',
    '    watchdog._postgres_volume_bytes("postgres-container-id")',
    'except watchdog.ProbeBlocked as exc:',
    '    print(json.dumps({"error": str(exc), "observed": observed}))',
    'else:',
    '    raise SystemExit("incomplete PostgreSQL measurement was accepted")',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'direct',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.observed.timeout, 30)
  assert.match(evidence.error, /PostgreSQL volume measurement.*timed out.*30 seconds/i)
})

test('initial PostgreSQL baseline is one complete snapshot and never double-measured', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(watchdogPath)
  const source = [
    'import json, sys, tempfile',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import watchdog',
    'volume_calls = []',
    'watchdog._host_metrics = lambda: (10_000, 1_000, 20_000)',
    'watchdog._probe_containers = lambda: {"gateway":"g","monitor":"m","postgres":"p"}',
    'watchdog._parse_memory_size = lambda value: 1',
    'watchdog._docker_log_capacity = lambda value: 1',
    'def fake_run(command, **kwargs):',
    '    joined = " ".join(command)',
    '    if " stats " in f" {joined} ": return "1B / 1GiB"',
    '    if "{{.SizeRw}}" in joined: return "1"',
    '    if "HostConfig.LogConfig" in joined: return "{}"',
    '    if " du -sk " in f" {joined} ":',
    '        volume_calls.append(command)',
    '        return "42\\t/var/lib/postgresql/data"',
    '    raise RuntimeError(joined)',
    'watchdog._run = fake_run',
    'with tempfile.TemporaryDirectory(prefix="aegis-h1-capacity-probe-baseline-") as root:',
    '    snapshot = watchdog.capture_snapshot(Path(root), None, 11_000)',
    'print(json.dumps({"snapshot": snapshot, "volume_calls": volume_calls}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.snapshot.postgres_volume_bytes, 42 * 1024)
  assert.equal(evidence.snapshot.postgres_growth_bytes, 0)
  assert.equal(evidence.volume_calls.length, 1)
})

test('measurement failure triggers exact cleanup without accepting incomplete capacity evidence', (t) => {
  const python = pythonCommand()
  if (!python) return t.skip('Python is unavailable for the repository contract test')
  requiredText(runnerPath)
  const source = [
    'import json, sys, tempfile',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(probeRoot)})`,
    'import run_probe, watchdog',
    'events = []',
    'lifecycle = []',
    'baseline = {"host_available_bytes":10000,"host_available_inodes":1000,"host_mem_available_bytes":20000,"evidence_log_bytes":0,"postgres_growth_bytes":0,"probe_new_bytes":0,"service_memory_usage_bytes":{"gateway":0,"monitor":0,"postgres":0}}',
    'watchdog.limits_from_environment = lambda: {}',
    'watchdog.capture_snapshot = lambda *args, **kwargs: (_ for _ in ()).throw(watchdog.ProbeBlocked("PostgreSQL volume measurement timed out after 30 seconds"))',
    'watchdog.stop_probe = lambda: events.append("stop")',
    'run_probe._assert_no_probe_collision = lambda: None',
    'run_probe._image_id = lambda reference: None',
    'run_probe._image_size = lambda reference: 1',
    'run_probe._guard_host = lambda *args, **kwargs: dict(baseline)',
    'run_probe._run = lambda *args, **kwargs: ""',
    'run_probe._run_guarded = lambda command, **kwargs: lifecycle.append(command)',
    'run_probe._record_introduced_images = lambda before, evidence, **kwargs: evidence / "introduced-images.json"',
    'def exact_cleanup(**kwargs):',
    '    events.append("cleanup")',
    '    assert kwargs["execute"] is True',
    '    assert kwargs["delete_evidence"] is False',
    'run_probe.cleanup_probe.cleanup = exact_cleanup',
    'with tempfile.TemporaryDirectory(prefix="aegis-h1-capacity-probe-failure-") as root:',
    '    evidence = Path(root)',
    '    try:',
    '        run_probe._run_probe_authorized({"source_sha":"a"*40,"source_tree":"b"*40}, evidence)',
    '    except watchdog.ProbeBlocked as exc:',
    '        error = str(exc)',
    '    else:',
    '        raise SystemExit("incomplete measurement was accepted as PASS")',
    '    complete = (evidence / "capacity-measurements.json").exists()',
    'up_count = sum(1 for command in lifecycle if command[-2:] == ["up", "--detach"])',
    'print(json.dumps({"complete":complete,"error":error,"events":events,"up_count":up_count}))',
  ].join('\n')
  const result = runProbePython(python, source, {
    AEGIS_CAPACITY_PROBE_DOCKER_MODE: 'sudo-noninteractive',
    AEGIS_CAPACITY_PROBE_COMPOSE_ENV_FILE: '/tmp/aegis-h1-probe.compose.env',
    MONITOR_CANDIDATE_IMAGE: `aegis-h1-capacity-probe-monitor:${'a'.repeat(12)}`,
    GATEWAY_CANDIDATE_IMAGE: `aegis-h1-capacity-probe-gateway:${'a'.repeat(12)}`,
  })

  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.complete, false)
  assert.match(evidence.error, /PostgreSQL volume measurement.*timed out/i)
  assert.deepEqual(evidence.events, ['stop', 'cleanup'])
  assert.equal(evidence.up_count, 1)
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
  assert.match(combined, /ACTIVE_CAPACITY_PROBE=ATTEMPT_4_FAILED_CLEANED/)
  assert.match(combined, /ATTEMPT_4_SERVICE_EXIT=GATEWAY_MONITOR_EXIT_1/)
  assert.match(combined, /STARTUP_EXIT_ROOT_CAUSE=NOT_PROVEN/)
  assert.match(combined, /STARTUP_LOG_DIAGNOSTICS=IMPLEMENTED_SOURCE_ONLY/)
  assert.match(combined, /OPTIONAL_HEALTH_DIAGNOSTIC=IMPLEMENTED_SOURCE_ONLY/)
  assert.match(combined, /SERVICE_READINESS_DIAGNOSTICS=IMPLEMENTED_SOURCE_ONLY/)
  assert.match(combined, /ACTIVE_CAPACITY_PROBE_READY=HUMAN_RERUN_REVIEW_REQUIRED/)
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
  assert.match(runner, /except watchdog\.ProbeServicesUnavailable as exc:/)
  assert.match(runner, /service-readiness\.json/)
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
