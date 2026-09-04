// tests/config.test.js — static config and policy validation
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_POLICY, loadStaticConfig, validatePolicy, validateStaticConfig } from '../src/config.js'
import { fixtureConfig } from './helpers.js'

test('CFG-1 a production-shaped config validates and normalises defaults', () => {
  const config = fixtureConfig()
  assert.equal(config.socketPath, '/run/aegis-backup/backup.sock')
  assert.deepEqual(config.source.include, ['uploads', 'versions', 'vault', 'avatars'])
  assert.equal(config.tools.pgDump, '/usr/bin/pg_dump')
  assert.equal(config.limits.maxBackupAgeHours, 36)
  assert.equal(config.limits.verifyIntervalDays, 7)
  assert.equal(config.targets.length, 3)
  assert.equal(config.targets[0].repository, '/mnt/aegis-backup/aegis-restic')
})

test('CFG-2 inline secrets are refused; only credential FILES are accepted', () => {
  assert.throws(() => fixtureConfig({ postgres: { host: 'h', database: 'd', user: 'u', password: 'x', passwordFile: '/etc/p' } }), /passwordFile/)
  assert.throws(() => fixtureConfig({ restic: { passwordFile: '/etc/r', password: 'x' } }), /passwordFile/)
  assert.throws(() => fixtureConfig({ postgres: { host: 'h', database: 'd', user: 'u', passwordFile: 'relative' } }), /absolute/)
  assert.throws(() => fixtureConfig({
    targets: [{ id: 'rest', label: 'x', type: 'off-host-rest', repository: 'rest:https://user:secret@host/repo' }],
  }), /password/)
})

test('CFG-3 targets are typed, unique, and an external repository must live inside its mount', () => {
  assert.throws(() => fixtureConfig({ targets: [{ id: 'a', label: 'a', type: 'tape' }] }), /type/)
  assert.throws(() => fixtureConfig({ targets: [
    { id: 'a', label: 'a', type: 'external-mount', mountPoint: '/mnt/x', repositoryPath: '/mnt/x/r' },
    { id: 'a', label: 'b', type: 'external-mount', mountPoint: '/mnt/y', repositoryPath: '/mnt/y/r' },
  ] }), /unique/)
  assert.throws(() => fixtureConfig({ targets: [
    { id: 'a', label: 'a', type: 'external-mount', mountPoint: '/mnt/x', repositoryPath: '/srv/elsewhere' },
  ] }), /inside its mountPoint/)
  assert.throws(() => fixtureConfig({ targets: [{ id: 'Bad Id', label: 'a', type: 'off-host-sftp', repository: 'sftp:x:/y' }] }), /id/)
  assert.throws(() => fixtureConfig({ targets: [{ id: 'a', label: 'a', type: 'off-host-sftp', repository: 'rest:x' }] }), /sftp:/)
  assert.doesNotThrow(() => fixtureConfig({ targets: [] }), 'an empty allowlist is valid — it means NOT_CONFIGURED')
})

test('CFG-4 limits are bounded integers', () => {
  assert.throws(() => fixtureConfig({ limits: { quiesceLeaseSeconds: 10 } }), /quiesceLeaseSeconds/)
  assert.throws(() => fixtureConfig({ limits: { quiesceAckTimeoutSeconds: 10_000 } }), /quiesceAckTimeoutSeconds/)
  assert.throws(() => fixtureConfig({ limits: { maxBackupAgeHours: 0 } }), /maxBackupAgeHours/)
  assert.throws(() => validateStaticConfig({ schemaVersion: 2 }), /schemaVersion/)
})

test('CFG-5 policy: only allowlisted IDs, no unknown keys, and a complete result', () => {
  const config = fixtureConfig()
  assert.deepEqual(validatePolicy({}, config), DEFAULT_POLICY)
  const set = validatePolicy({ activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: true }, config)
  assert.equal(set.activeTargetId, 'usb-external-1')
  assert.throws(() => validatePolicy({ activeTargetId: '/mnt/anything' }, config), /target/)
  assert.throws(() => validatePolicy({ activeTargetId: 'not-in-allowlist' }, config), /allowlisted/)
  assert.throws(() => validatePolicy({ scheduleId: '*/5 * * * *' }, config), /schedule/)
  assert.throws(() => validatePolicy({ retentionId: 'forever' }, config), /retention/)
  assert.throws(() => validatePolicy({ enabled: 'yes' }, config), /boolean/)
  assert.throws(() => validatePolicy({ command: 'rm -rf /' }, config), /not a recognised setting/)
  assert.throws(() => validatePolicy({ mountPoint: '/mnt/x' }, config), /not a recognised setting/)
})

test('CFG-6 loadStaticConfig refuses a missing, unreadable or malformed file', async () => {
  await assert.rejects(loadStaticConfig({ env: { AEGIS_BACKUP_CONFIG: 'relative.json' }, readFile: async () => '{}' }), /absolute/)
  await assert.rejects(loadStaticConfig({ env: {}, readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } }), /cannot read/)
  await assert.rejects(loadStaticConfig({ env: {}, readFile: async () => '{ nope' }), /not valid JSON/)
  const ok = await loadStaticConfig({ env: {}, readFile: async () => JSON.stringify({
    schemaVersion: 1,
    source: { datalakePath: '/var/lib/docker/volumes/aegis_drive_storage/_data' },
    postgres: { host: 'db', database: 'aegis_drive', user: 'drive_backup', passwordFile: '/etc/aegis/pgpass' },
    restic: { passwordFile: '/etc/aegis/restic' },
    targets: [],
  }) })
  assert.equal(ok.targets.length, 0)
})
