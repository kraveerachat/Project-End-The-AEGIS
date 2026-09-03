// tests/deploy.test.js — the backup agent unit is a read-only-on-source, write-only-to-target boundary
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SOCKET_PATH, DEFAULT_STATE_DIR, validateStaticConfig } from '../src/config.js'

const DEPLOY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy')
const unit = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-backup.service'), 'utf8')
const sysusers = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-backup.sysusers.conf'), 'utf8')
const example = JSON.parse(await fs.readFile(path.join(DEPLOY_DIR, 'backup-agent.example.json'), 'utf8'))

function parseUnit(text) {
  const sections = new Map()
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) { current = line.slice(1, -1); if (!sections.has(current)) sections.set(current, new Map()); continue }
    const index = line.indexOf('=')
    if (index === -1 || current === null) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    const bucket = sections.get(current)
    bucket.set(key, bucket.has(key) ? `${bucket.get(key)}\n${value}` : value)
  }
  return (section, key) => sections.get(section)?.get(key)
}
const d = parseUnit(unit)

test('DEPLOY-1 dedicated identity, separate from telemetry and disk-health', () => {
  assert.equal(d('Service', 'User'), 'aegis-backup')
  assert.equal(d('Service', 'Group'), 'aegis-backup')
  assert.equal(d('Service', 'DynamicUser'), undefined)
  const line = sysusers.split('\n').find((row) => row.trim().startsWith('u '))
  assert.match(line, /aegis-backup/)
  assert.match(line, /\b29102\b/)
  assert.match(line, /nologin/)
})

test('DEPLOY-2 the only capability is read-only traversal; nothing that can write production data', () => {
  assert.equal(d('Service', 'CapabilityBoundingSet'), 'CAP_DAC_READ_SEARCH')
  assert.equal(d('Service', 'AmbientCapabilities'), 'CAP_DAC_READ_SEARCH')
  assert.equal(d('Service', 'NoNewPrivileges'), 'true')
  const granted = `${d('Service', 'CapabilityBoundingSet')} ${d('Service', 'AmbientCapabilities')}`
  for (const forbidden of ['CAP_DAC_OVERRIDE', 'CAP_SYS_ADMIN', 'CAP_SYS_RAWIO', 'CAP_CHOWN', 'CAP_FOWNER']) {
    assert.ok(!granted.includes(forbidden), `${forbidden} must not be granted`)
  }
})

test('DEPLOY-3 the write set is the agent directories plus the external mount; the Docker volume is not writable', () => {
  assert.equal(d('Service', 'ProtectSystem'), 'strict')
  const rw = (d('Service', 'ReadWritePaths') ?? '').split('\n')
  assert.deepEqual(rw, ['/mnt/aegis-backup'])
  assert.ok(!rw.some((p) => p.startsWith('/var/lib/docker')), 'the production volume must never be in ReadWritePaths')
  assert.equal(d('Service', 'StateDirectory'), 'aegis-backup')
  assert.equal(d('Service', 'RuntimeDirectory'), 'aegis-backup')
  assert.equal(d('Service', 'RuntimeDirectoryMode'), '0750')
  assert.equal(d('Service', 'RuntimeDirectoryPreserve'), 'yes')
  assert.equal(d('Service', 'CacheDirectory'), 'aegis-backup')
  assert.equal(d('Service', 'UMask'), '0007')
  assert.ok(DEFAULT_SOCKET_PATH.startsWith('/run/aegis-backup/'))
  assert.equal(DEFAULT_STATE_DIR, '/var/lib/aegis-backup')
})

test('DEPLOY-4 network is limited to what pg_dump and an approved target need', () => {
  assert.equal(d('Service', 'RestrictAddressFamilies'), 'AF_UNIX AF_INET AF_INET6')
  assert.equal(d('Service', 'IPAddressDeny'), 'any')
  assert.ok((d('Service', 'IPAddressAllow') ?? '').includes('172.16.0.0/12'))
  assert.equal(d('Service', 'PrivateNetwork'), undefined, 'pg_dump must reach PostgreSQL')
})

test('DEPLOY-5 hardening directives compatible with the agent are present', () => {
  const expected = {
    ProtectHome: 'true', PrivateTmp: 'true', PrivateDevices: 'true', ProtectKernelTunables: 'true', ProtectKernelModules: 'true',
    ProtectKernelLogs: 'true', ProtectControlGroups: 'true', ProtectProc: 'invisible', RestrictNamespaces: 'true',
    RestrictRealtime: 'true', RestrictSUIDSGID: 'true', LockPersonality: 'true', SystemCallArchitectures: 'native',
  }
  for (const [key, value] of Object.entries(expected)) assert.equal(d('Service', key), value, `${key} must be ${value}`)
  assert.equal(d('Unit', 'StartLimitIntervalSec'), '60')
  assert.equal(d('Unit', 'StartLimitBurst'), '5')
  assert.equal(d('Install', 'WantedBy'), 'multi-user.target')
})

test('DEPLOY-6 the example config validates and contains no inline secret', () => {
  const config = validateStaticConfig(example)
  assert.equal(config.targets[0].id, 'usb-external-1')
  const text = JSON.stringify(example)
  assert.ok(!/"password"\s*:/.test(text))
  assert.ok(config.postgres.passwordFile.startsWith('/etc/aegis/'))
  assert.ok(config.restic.passwordFile.startsWith('/etc/aegis/'))
})

test('DEPLOY-7 packaging is declarative: no install script, no self-enable', async () => {
  const entries = await fs.readdir(DEPLOY_DIR)
  for (const entry of entries) assert.ok(!entry.endsWith('.sh'), `${entry}: deployment must stay declarative`)
  assert.ok(!unit.includes('systemctl enable'))
})
