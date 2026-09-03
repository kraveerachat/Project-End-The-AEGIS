// tests/diskHealthDeploy.test.js — AEGIS host disk-health collector · unit + timer
//
// The collector is the only AEGIS host unit that holds a capability. The unit
// file is therefore the whole argument for why that is acceptable, and it is
// asserted here: one capability, one device, read-only, no network, a oneshot
// on a timer, and an evidence directory readable by the agent's group alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_OUTPUT_PATH } from '../collectors/disk-health.js'
import { DEFAULT_DISK_HEALTH_FILE } from '../src/config.js'

const DEPLOY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy')
const unit = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-disk-health.service'), 'utf8')
const timer = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-disk-health.timer'), 'utf8')
const sysusers = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-disk-health.sysusers.conf'), 'utf8')
const agentUnit = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-telemetry.service'), 'utf8')

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
    // Repeated keys (Environment=, DeviceAllow=) accumulate.
    bucket.set(key, bucket.has(key) ? `${bucket.get(key)}\n${value}` : value)
  }
  return (section, key) => sections.get(section)?.get(key)
}

const service = parseUnit(unit)
const timerUnit = parseUnit(timer)
const agent = parseUnit(agentUnit)

test('DISKDEPLOY-1 the collector is a oneshot under its own identity in the agent group', () => {
  assert.equal(service('Service', 'Type'), 'oneshot')
  assert.equal(service('Service', 'User'), 'aegis-disk-health')
  assert.equal(service('Service', 'Group'), 'aegis-telemetry', 'the evidence file must be readable by the agent and nobody else')
  assert.equal(service('Service', 'DynamicUser'), undefined)
  assert.match(service('Service', 'ExecStart'), /collectors\/run-disk-health\.js$/)
})

test('DISKDEPLOY-2 exactly one capability, and it is the one SMART pass-through needs', () => {
  assert.equal(service('Service', 'CapabilityBoundingSet'), 'CAP_SYS_RAWIO')
  assert.equal(service('Service', 'AmbientCapabilities'), 'CAP_SYS_RAWIO')
  assert.equal(service('Service', 'NoNewPrivileges'), 'true')
  // Directive VALUES, not raw text: the comments name the capabilities that are
  // deliberately withheld, and a reviewer should be able to keep reading them.
  const granted = `${service('Service', 'CapabilityBoundingSet')} ${service('Service', 'AmbientCapabilities')}`
  for (const forbidden of ['CAP_SYS_ADMIN', 'CAP_DAC_OVERRIDE', 'CAP_DAC_READ_SEARCH', 'CAP_NET_ADMIN', 'CAP_SYS_PTRACE']) {
    assert.ok(!granted.includes(forbidden), `${forbidden} must never be granted to the collector`)
  }
})

test('DISKDEPLOY-3 the device allowlist names one device, read-only, and matches the configured device', () => {
  assert.equal(service('Service', 'DevicePolicy'), 'closed')
  assert.equal(service('Service', 'DeviceAllow'), '/dev/sda r')
  const env = service('Service', 'Environment').split('\n')
  assert.ok(env.includes('AEGIS_DISK_HEALTH_DEVICE=sda'))
  assert.ok(env.includes(`AEGIS_DISK_HEALTH_OUTPUT=${DEFAULT_OUTPUT_PATH}`))
  assert.ok(env.includes('AEGIS_DISK_HEALTH_SMARTCTL=/usr/sbin/smartctl'))
  assert.equal(service('Service', 'PrivateDevices'), undefined, 'a private /dev would hide the device the unit exists to read')
})

test('DISKDEPLOY-4 the collector has no network of any kind', () => {
  assert.equal(service('Service', 'PrivateNetwork'), 'true')
  assert.equal(service('Service', 'IPAddressDeny'), 'any')
  assert.equal(service('Service', 'RestrictAddressFamilies'), 'AF_UNIX')
})

test('DISKDEPLOY-5 the evidence directory is a StateDirectory closed to unrelated users', () => {
  assert.equal(service('Service', 'StateDirectory'), 'aegis-disk-health')
  assert.equal(service('Service', 'StateDirectoryMode'), '0750')
  assert.equal(service('Service', 'UMask'), '0027')
  assert.equal(DEFAULT_OUTPUT_PATH, DEFAULT_DISK_HEALTH_FILE, 'the collector writes exactly where the agent reads')
  assert.ok(DEFAULT_OUTPUT_PATH.startsWith('/var/lib/aegis-disk-health/'))
})

test('DISKDEPLOY-6 the hardening set proven compatible with one device read is present', () => {
  const expected = {
    ProtectSystem: 'strict', ProtectHome: 'true', PrivateTmp: 'true', ProtectKernelTunables: 'true',
    ProtectKernelModules: 'true', ProtectKernelLogs: 'true', ProtectControlGroups: 'true',
    ProtectProc: 'invisible', ProcSubset: 'pid', RestrictNamespaces: 'true', RestrictRealtime: 'true',
    RestrictSUIDSGID: 'true', LockPersonality: 'true', SystemCallArchitectures: 'native',
  }
  for (const [key, value] of Object.entries(expected)) assert.equal(service('Service', key), value, `${key} must be ${value}`)
})

test('DISKDEPLOY-7 the timer fires the collector periodically and the collector does not enable itself', () => {
  assert.equal(timerUnit('Timer', 'Unit'), 'aegis-disk-health.service')
  assert.equal(timerUnit('Timer', 'OnUnitActiveSec'), '10min')
  assert.equal(timerUnit('Install', 'WantedBy'), 'timers.target')
  assert.equal(service('Install', 'WantedBy'), undefined, 'a timer-driven oneshot must not also be enabled at boot')
  assert.ok(!unit.includes('systemctl enable'))
})

test('DISKDEPLOY-8 sysusers pins a separate numeric identity that cannot log in', () => {
  const line = sysusers.split('\n').find((row) => row.trim().startsWith('u '))
  assert.ok(line)
  assert.match(line, /aegis-disk-health/)
  assert.match(line, /\b29101\b/)
  assert.match(line, /nologin/)
})

test('DISKDEPLOY-9 the telemetry agent unit still holds no capability and no device after the change', () => {
  assert.equal(agent('Service', 'CapabilityBoundingSet'), '')
  assert.equal(agent('Service', 'PrivateDevices'), 'true')
  assert.equal(agent('Service', 'AmbientCapabilities'), '')
  assert.equal(agent('Service', 'DeviceAllow'), undefined)
  const env = agent('Service', 'Environment').split('\n')
  assert.ok(env.includes(`AEGIS_TELEMETRY_DISK_HEALTH_FILE=${DEFAULT_DISK_HEALTH_FILE}`), 'the agent names the one file it reads')
})
