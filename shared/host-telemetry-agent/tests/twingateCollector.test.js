// tests/twingateCollector.test.js — AEGIS local Twingate connector collector
//
// Two properties are under test here and they matter in different ways.
//
// The first is truthfulness: Docker's own vocabulary must land on our enums
// without ever inventing health. A container with no HEALTHCHECK, a container
// that is crash-looping, and a container that is simply gone are three
// different facts and must render as three different values — none of them
// "Healthy".
//
// The second is containment: `docker inspect` without a format returns the
// container's environment, which on this host holds TWINGATE_ACCESS_TOKEN and
// TWINGATE_REFRESH_TOKEN. The collector must never ask for it and must never be
// able to pass it on. That is asserted against a hostile fixture below.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOCKER_ARGS, DOCKER_FORMAT, DEFAULT_CONTAINER_NAME, DEFAULT_DOCKER_PATH, DEFAULT_OUTPUT_PATH,
  collectTwingateHealth, loadCollectorConfig, resolveContainerName, writeEvidenceFile,
} from '../collectors/twingate-health.js'
import {
  CONNECTOR_HEALTH, RUNTIME_STATE, TWINGATE_HEALTH_SCHEMA_VERSION,
  connectorFromDockerProjection, connectorHealthFrom, normalizeRestartCount,
  normalizeStartedAt, runtimeStateFrom,
} from '../collectors/twingate.js'

const NOW = Date.UTC(2026, 8, 5, 10, 0, 0)
const config = { container: DEFAULT_CONTAINER_NAME, dockerPath: DEFAULT_DOCKER_PATH, outputPath: '/tmp/unused.json' }

/** A stub that returns whatever Docker would have printed. */
const dockerReturning = (stdout, { exitStatus = 0, notFound = false } = {}) =>
  async () => ({ stdout, exitStatus, notFound })

const dockerThrowing = (code) => async () => { throw Object.assign(new Error(code), { code }) }

const run = (execFile) => collectTwingateHealth(config, { execFile, now: () => NOW })

// ── The happy path, which is also the production state ───────────────────────

test('TWCOLLECT-1 a running, healthy connector is reported as RUNNING + HEALTHY', async () => {
  const evidence = await run(dockerReturning(JSON.stringify({
    status: 'running', running: true, restarting: false,
    startedAt: '2026-09-01T08:30:00.000000000Z', restartCount: 0, health: 'healthy',
  })))

  assert.deepEqual(evidence, {
    schemaVersion: TWINGATE_HEALTH_SCHEMA_VERSION,
    measuredAt: new Date(NOW).toISOString(),
    connector: {
      available: true,
      runtimeState: 'RUNNING',
      health: 'HEALTHY',
      restartCount: 0,
      startedAt: '2026-09-01T08:30:00.000Z',
    },
  })
})

test('TWCOLLECT-2 a stopped container is reported as STOPPED, not as unavailable', async () => {
  const evidence = await run(dockerReturning(JSON.stringify({
    status: 'exited', running: false, restarting: false,
    startedAt: '2026-09-01T08:30:00Z', restartCount: 2, health: null,
  })))
  // The connector EXISTS and we measured it — "available" is about evidence,
  // not about the container being up.
  assert.equal(evidence.connector.available, true)
  assert.equal(evidence.connector.runtimeState, 'STOPPED')
  assert.equal(evidence.connector.restartCount, 2)
})

test('TWCOLLECT-3 a restarting container is RESTARTING even while Docker says Running', async () => {
  // A crash-looping container reports Running: true between restarts. Reporting
  // that as RUNNING would present a connector that never stays up as one that is.
  const evidence = await run(dockerReturning(JSON.stringify({
    status: 'restarting', running: true, restarting: true,
    startedAt: '2026-09-05T09:59:00Z', restartCount: 147, health: 'unhealthy',
  })))
  assert.equal(evidence.connector.runtimeState, 'RESTARTING')
  assert.equal(evidence.connector.restartCount, 147)
})

test('TWCOLLECT-4 a container with no healthcheck is NOT_CONFIGURED, never HEALTHY', async () => {
  const evidence = await run(dockerReturning(JSON.stringify({
    status: 'running', running: true, restarting: false,
    startedAt: '2026-09-01T08:30:00Z', restartCount: 0, health: null,
  })))
  assert.equal(evidence.connector.runtimeState, 'RUNNING')
  assert.equal(evidence.connector.health, 'NOT_CONFIGURED')
  assert.notEqual(evidence.connector.health, 'HEALTHY')
})

// ── Unavailable evidence, with a fixed reason ────────────────────────────────

test('TWCOLLECT-5 a missing container is unavailable with connector-not-found', async () => {
  const evidence = await run(dockerReturning('', { exitStatus: 1, notFound: true }))
  assert.deepEqual(evidence.connector, { available: false, reason: 'connector-not-found' })
})

test('TWCOLLECT-6 an unreachable or absent Docker CLI is docker-unavailable', async () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    const evidence = await run(dockerThrowing(code))
    assert.deepEqual(evidence.connector, { available: false, reason: 'docker-unavailable' }, code)
  }
})

test('TWCOLLECT-7 a failing or unparseable inspect is inspect-failed', async () => {
  const nonZero = await run(dockerReturning('', { exitStatus: 1, notFound: false }))
  assert.equal(nonZero.connector.reason, 'inspect-failed')

  const garbage = await run(dockerReturning('not json at all'))
  assert.equal(garbage.connector.reason, 'inspect-failed')

  const timedOut = await run(dockerThrowing('ETIMEDOUT'))
  assert.equal(timedOut.connector.reason, 'inspect-failed')
})

test('TWCOLLECT-8 unavailable evidence carries a reason and nothing else', async () => {
  const evidence = await run(dockerReturning('', { exitStatus: 1, notFound: true }))
  assert.deepEqual(Object.keys(evidence.connector).sort(), ['available', 'reason'])
})

// ── Containment: the token must not be obtainable ────────────────────────────

test('TWCOLLECT-9 the Docker command never asks for environment, mounts, or health logs', () => {
  // The template is the containment boundary: Docker does the projection, so
  // the secret never enters this process at all.
  assert.ok(DOCKER_ARGS.includes('inspect'))
  assert.ok(DOCKER_ARGS.includes('--format'))
  assert.ok(DOCKER_ARGS.includes(DOCKER_FORMAT))
  for (const forbidden of ['.Config', '.Env', '.Mounts', '.NetworkSettings', '.Labels', '.Id', 'Health.Log']) {
    assert.ok(!DOCKER_FORMAT.includes(forbidden), `the format must not request ${forbidden}`)
  }
  // Read-only verbs only. Nothing that changes the container.
  for (const verb of ['run', 'exec', 'start', 'stop', 'restart', 'rm', 'kill', 'logs']) {
    assert.ok(!DOCKER_ARGS.includes(verb), `docker ${verb} must never be issued`)
  }
})

test('TWCOLLECT-10 a hostile Docker projection cannot smuggle extra fields through', async () => {
  // Even if the template were somehow bypassed, the projection is rebuilt from
  // four named values — anything else in the object is never read.
  const evidence = await run(dockerReturning(JSON.stringify({
    status: 'running', running: true, restarting: false,
    startedAt: '2026-09-01T08:30:00Z', restartCount: 0, health: 'healthy',
    Env: ['TWINGATE_ACCESS_TOKEN=super-secret-value', 'TWINGATE_REFRESH_TOKEN=another-secret'],
    Id: 'e3b0c44298fc1c149afbf4c8996fb924', Mounts: [{ Source: '/etc/twingate' }],
    NetworkSettings: { IPAddress: '10.20.0.9', MacAddress: 'de:ad:be:ef:00:01' },
    Labels: { 'com.twingate.tenant': 'aegis' },
  })))

  const serialized = JSON.stringify(evidence)
  for (const secret of [
    'TWINGATE_ACCESS_TOKEN', 'super-secret-value', 'TWINGATE_REFRESH_TOKEN', 'another-secret',
    'e3b0c44298fc1c149afbf4c8996fb924', '/etc/twingate', '10.20.0.9', 'de:ad:be:ef', 'com.twingate.tenant',
  ]) {
    assert.ok(!serialized.includes(secret), `evidence leaked ${secret}`)
  }
  assert.deepEqual(
    Object.keys(evidence.connector).sort(),
    ['available', 'health', 'restartCount', 'runtimeState', 'startedAt'],
  )
})

test('TWCOLLECT-11 the collector never writes a Docker error message into the evidence', async () => {
  // stderr is reduced to one boolean and discarded; a daemon path or an echoed
  // object name must not reach a document Drive renders.
  const evidence = await run(async () => ({
    stdout: '',
    exitStatus: 1,
    notFound: /no such object/i.test('Error response from daemon: No such object: twingate-aegis-connector-02'),
  }))
  assert.equal(JSON.stringify(evidence).includes('daemon'), false)
  assert.equal(JSON.stringify(evidence).includes('/var/run/docker.sock'), false)
  assert.equal(evidence.connector.reason, 'connector-not-found')
})

// ── Pure mappers ─────────────────────────────────────────────────────────────

test('TWCOLLECT-12 Docker runtime vocabulary maps onto exactly four states', () => {
  assert.equal(runtimeStateFrom({ status: 'running', running: true }), RUNTIME_STATE.RUNNING)
  assert.equal(runtimeStateFrom({ status: 'restarting', running: false, restarting: true }), RUNTIME_STATE.RESTARTING)
  for (const status of ['created', 'exited', 'dead', 'paused', 'removing']) {
    assert.equal(runtimeStateFrom({ status, running: false }), RUNTIME_STATE.STOPPED, status)
  }
  // A vocabulary Docker has not used before must not become RUNNING.
  assert.equal(runtimeStateFrom({ status: 'teleporting', running: false }), RUNTIME_STATE.UNKNOWN)
  assert.equal(runtimeStateFrom({}), RUNTIME_STATE.UNKNOWN)
})

test('TWCOLLECT-13 health maps without ever promoting an unknown value to HEALTHY', () => {
  assert.equal(connectorHealthFrom('healthy'), CONNECTOR_HEALTH.HEALTHY)
  assert.equal(connectorHealthFrom('unhealthy'), CONNECTOR_HEALTH.UNHEALTHY)
  assert.equal(connectorHealthFrom('starting'), CONNECTOR_HEALTH.STARTING)
  for (const absent of [null, undefined, '', 'none']) {
    assert.equal(connectorHealthFrom(absent), CONNECTOR_HEALTH.NOT_CONFIGURED, String(absent))
  }
  assert.equal(connectorHealthFrom('excellent'), CONNECTOR_HEALTH.UNKNOWN)
})

test('TWCOLLECT-14 unknown is null, never zero', () => {
  assert.equal(normalizeRestartCount(0), 0)
  assert.equal(normalizeRestartCount(7), 7)
  for (const bad of [-1, 1.5, '3', null, undefined, NaN]) assert.equal(normalizeRestartCount(bad), null, String(bad))

  assert.equal(normalizeStartedAt('2026-09-01T08:30:00Z'), '2026-09-01T08:30:00.000Z')
  // Docker renders a never-started container as the Go zero time; publishing it
  // would put "01 Jan 0001" on the Settings screen.
  assert.equal(normalizeStartedAt('0001-01-01T00:00:00Z'), null)
  for (const bad of ['', 'yesterday', null, 42]) assert.equal(normalizeStartedAt(bad), null, String(bad))
})

test('TWCOLLECT-15 a non-object Docker projection is inspect-failed', () => {
  for (const bad of [null, 'string', 42, []]) {
    assert.deepEqual(connectorFromDockerProjection(bad), { available: false, reason: 'inspect-failed' }, String(bad))
  }
})

// ── Configuration ────────────────────────────────────────────────────────────

test('TWCOLLECT-16 the container name is pattern-checked before it can become an argument', () => {
  assert.equal(resolveContainerName('twingate-aegis-connector-02'), 'twingate-aegis-connector-02')
  for (const bad of [
    '', '  ', '-leading-dash', 'has space', 'semi;colon', 'pipe|it', '$(whoami)',
    '../../etc/passwd', 'quote"name', "tick'name", null, 42, 'a'.repeat(200),
  ]) {
    assert.equal(resolveContainerName(bad), null, JSON.stringify(bad))
  }
})

test('TWCOLLECT-17 configuration defaults name the production connector and refuse relative paths', () => {
  assert.deepEqual(loadCollectorConfig({}), {
    container: 'twingate-aegis-connector-02',
    dockerPath: DEFAULT_DOCKER_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
  })
  assert.throws(() => loadCollectorConfig({ AEGIS_TWINGATE_CONTAINER: 'not a name' }), /container name/)
  assert.throws(() => loadCollectorConfig({ AEGIS_TWINGATE_DOCKER: 'docker' }), /absolute/)
  assert.throws(() => loadCollectorConfig({ AEGIS_TWINGATE_OUTPUT: 'out.json' }), /absolute/)
})

// ── Atomic write ─────────────────────────────────────────────────────────────

test('TWCOLLECT-18 evidence is written to a temp file and renamed, never in place', async () => {
  const calls = []
  const fakeFs = {
    writeFile: async (p, body, opts) => { calls.push(['write', p, opts.mode]) },
    rename: async (from, to) => { calls.push(['rename', from, to]) },
  }
  await writeEvidenceFile('/var/lib/aegis-twingate-health/twingate-health.json', { ok: true }, { fs: fakeFs })

  assert.equal(calls[0][0], 'write')
  assert.match(calls[0][1], /\.tmp-\d+$/, 'must write to a temp path first')
  assert.equal(calls[0][2], 0o640, 'evidence is group-readable only')
  assert.equal(calls[1][0], 'rename')
  assert.equal(calls[1][2], '/var/lib/aegis-twingate-health/twingate-health.json')
})

// ── Module boundary ──────────────────────────────────────────────────────────

test('TWCOLLECT-19 only the privileged collector references the process primitive', async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'collectors')
  const pure = await fs.readFile(path.join(dir, 'twingate.js'), 'utf8')
  const privileged = await fs.readFile(path.join(dir, 'twingate-health.js'), 'utf8')

  // The pure module must stay importable by the agent without dragging the
  // Docker-executing module into that process.
  assert.ok(!pure.includes('child_process'), 'the projection module must stay pure')
  assert.ok(!pure.includes('node:fs'), 'the projection module must not touch the filesystem')
  assert.ok(privileged.includes("from 'node:child_process'"))
})
