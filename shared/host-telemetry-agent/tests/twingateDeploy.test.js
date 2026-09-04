// tests/twingateDeploy.test.js — AEGIS Twingate connector collector · unit + timer
//
// This collector is the only AEGIS host unit that can reach the Docker daemon,
// and the Docker socket is root-equivalent. The unit file is therefore the whole
// argument for why that is acceptable, and it is asserted here: a oneshot, no
// capabilities at all, one group membership, no network, no devices, and an
// evidence directory readable by the agent's group alone.
//
// The other half of the argument is negative — the long-running agent and the
// Drive container must NOT gain that access — so those are asserted too.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_OUTPUT_PATH } from '../collectors/twingate-health.js'
import { DEFAULT_TWINGATE_HEALTH_FILE } from '../src/config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEPLOY_DIR = path.resolve(HERE, '..', 'deploy')
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

const unit = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-twingate-health.service'), 'utf8')
const timer = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-twingate-health.timer'), 'utf8')
const sysusers = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-twingate-health.sysusers.conf'), 'utf8')
const agentUnit = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-telemetry.service'), 'utf8')
const diskUnit = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-disk-health.service'), 'utf8')

function parseUnit(text) {
  const sections = new Map()
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1)
      if (!sections.has(current)) sections.set(current, new Map())
      continue
    }
    const index = line.indexOf('=')
    if (index === -1 || current === null) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    const bucket = sections.get(current)
    bucket.set(key, bucket.has(key) ? `${bucket.get(key)}\n${value}` : value)
  }
  return (section, key) => sections.get(section)?.get(key)
}

/** Directive lines only — a security property must not be provable by a comment. */
function directives(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'))
    .join('\n')
}

const service = parseUnit(unit)
const timerUnit = parseUnit(timer)
const agent = parseUnit(agentUnit)
const disk = parseUnit(diskUnit)

test('TWDEPLOY-1 the collector is a oneshot under its own identity in the agent group', () => {
  assert.equal(service('Service', 'Type'), 'oneshot')
  assert.equal(service('Service', 'User'), 'aegis-twingate-health')
  assert.equal(service('Service', 'Group'), 'aegis-telemetry', 'the evidence file must be readable by the agent and nobody else')
  assert.equal(service('Service', 'DynamicUser'), undefined)
  assert.match(service('Service', 'ExecStart'), /collectors\/run-twingate-health\.js$/)
})

test('TWDEPLOY-2 the collector holds NO capability — its only grant is one group', () => {
  // Unlike the disk-health collector (which needs CAP_SYS_RAWIO), this unit
  // needs nothing from the capability system: the Docker socket is opened by
  // group permission alone.
  assert.equal(service('Service', 'CapabilityBoundingSet'), '', 'the bounding set must be empty')
  assert.equal(service('Service', 'AmbientCapabilities'), '')
  assert.equal(service('Service', 'NoNewPrivileges'), 'true')
  assert.equal(service('Service', 'SupplementaryGroups'), 'docker', 'docker is the single grant, and it must be the only one')
})

test('TWDEPLOY-3 the collector has no network and no devices', () => {
  // No IP networking is what makes "this unit cannot call the Twingate control
  // plane" a property of the deployment rather than a promise in a comment.
  assert.equal(service('Service', 'PrivateNetwork'), 'true')
  assert.equal(service('Service', 'IPAddressDeny'), 'any')
  assert.equal(service('Service', 'RestrictAddressFamilies'), 'AF_UNIX')
  // Nothing here opens a device, so it can take a private /dev too.
  assert.equal(service('Service', 'PrivateDevices'), 'true')
  assert.equal(service('Service', 'DevicePolicy'), 'closed')
  assert.equal(service('Service', 'DeviceAllow'), undefined, 'this collector needs no device at all')
})

test('TWDEPLOY-4 the collector is otherwise confined like the rest of the host tooling', () => {
  for (const [key, value] of [
    ['ProtectSystem', 'strict'], ['ProtectHome', 'true'], ['PrivateTmp', 'true'],
    ['ProtectKernelTunables', 'true'], ['ProtectKernelModules', 'true'], ['ProtectKernelLogs', 'true'],
    ['ProtectControlGroups', 'true'], ['RestrictNamespaces', 'true'], ['RestrictRealtime', 'true'],
    ['RestrictSUIDSGID', 'true'], ['LockPersonality', 'true'], ['SystemCallArchitectures', 'native'],
  ]) {
    assert.equal(service('Service', key), value, key)
  }
  assert.equal(service('Service', 'StateDirectory'), 'aegis-twingate-health')
  assert.equal(service('Service', 'StateDirectoryMode'), '0750')
})

test('TWDEPLOY-5 the unit names one container and the evidence path the agent reads', () => {
  const env = service('Service', 'Environment')
  assert.match(env, /AEGIS_TWINGATE_CONTAINER=twingate-aegis-connector-02/)
  assert.match(env, /AEGIS_TWINGATE_DOCKER=\/usr\/bin\/docker/)
  assert.match(env, new RegExp(`AEGIS_TWINGATE_OUTPUT=${DEFAULT_OUTPUT_PATH.replace(/\//g, '\\/')}`))
  // The path the collector writes and the path the agent reads must be the same
  // string, or the feature silently reports collector-not-run forever.
  assert.equal(DEFAULT_OUTPUT_PATH, DEFAULT_TWINGATE_HEALTH_FILE)
  assert.ok(agentUnit.includes(`AEGIS_TELEMETRY_TWINGATE_HEALTH_FILE=${DEFAULT_TWINGATE_HEALTH_FILE}`))
})

test('TWDEPLOY-6 no Twingate credential is named anywhere in the unit', () => {
  const unitDirectives = directives(unit)
  for (const secret of ['TWINGATE_ACCESS_TOKEN', 'TWINGATE_REFRESH_TOKEN', 'TWINGATE_API', 'TWINGATE_NETWORK']) {
    assert.ok(!unitDirectives.includes(secret), `no directive may reference ${secret}`)
  }
})

test('TWDEPLOY-7 the timer polls about once a minute, not aggressively', () => {
  assert.equal(timerUnit('Timer', 'OnUnitActiveSec'), '60s')
  assert.equal(timerUnit('Timer', 'Unit'), 'aegis-twingate-health.service')
  assert.equal(timerUnit('Install', 'WantedBy'), 'timers.target')
})

test('TWDEPLOY-8 a third pinned UID, distinct from the agent and the disk collector', () => {
  // Assert the `u` LINE, not the file: the explanatory header legitimately names
  // the neighbouring UIDs, and a comment must not be able to fail this check.
  const userLines = directives(sysusers).split('\n').filter((line) => line.startsWith('u'))
  assert.equal(userLines.length, 1, 'exactly one identity is defined here')
  assert.match(userLines[0], /^u\s+aegis-twingate-health\s+29102\b/)
  assert.ok(!userLines[0].includes('29100'), 'the agent UID must not be reused')
  assert.ok(!userLines[0].includes('29101'), 'the disk collector UID must not be reused')
})

// ── The negative half: nothing else may gain Docker access ───────────────────

test('TWDEPLOY-9 the long-running agent is never given the docker group or socket', () => {
  // Directives only — the unit's comments explain which OTHER unit holds the
  // docker group, and that explanation must not read as a grant.
  const agentDirectives = directives(agentUnit)
  assert.equal(agent('Service', 'SupplementaryGroups'), undefined, 'the agent gets no supplementary group')
  assert.ok(!agentDirectives.includes('docker'), 'no agent directive may reference docker')
  assert.equal(agent('Service', 'DeviceAllow'), undefined)
  assert.equal(agent('Service', 'CapabilityBoundingSet'), '', 'the agent still holds no capability')
  // Its whole new privilege is one more file read.
  assert.ok(agentDirectives.includes('AEGIS_TELEMETRY_TWINGATE_HEALTH_FILE=/var/lib/'))
})

test('TWDEPLOY-10 the disk-health collector is unchanged and gains no Docker access', () => {
  assert.equal(disk('Service', 'CapabilityBoundingSet'), 'CAP_SYS_RAWIO')
  assert.equal(disk('Service', 'SupplementaryGroups'), 'disk')
  assert.ok(!directives(diskUnit).includes('docker'))
})

test('TWDEPLOY-11 the Drive container is never handed the Docker socket', async () => {
  // The single most important negative property of this feature. Drive reads the
  // agent's Unix socket, which it already mounts read-only; it gains nothing new.
  const compose = await fs.readFile(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8')
  assert.ok(!compose.includes('docker.sock'), 'no service in the stack may mount the Docker socket')
  assert.ok(!compose.includes('/var/run/docker'), 'no service in the stack may bind the Docker runtime directory')
})
