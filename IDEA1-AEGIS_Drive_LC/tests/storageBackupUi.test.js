// tests/storageBackupUi.test.js — AEGIS Drive (IDEA1) · Storage & Backup screen states
//
// The screen renders the real /api/storage and /api/backup contracts. The rule
// under test is the one that shaped the whole feature: a source that could not
// be read says so, in words, and never renders as a number or a green chip.
// The Capacity card is a ring now; storageCapacityRingUi.test.js covers it, and
// this file only asserts that it still mounts beside the other three.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
let vite
let Storage
let BackupConfiguration

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ Storage } = await vite.ssrLoadModule('/src/screens/Storage.jsx'))
  ;({ BackupConfiguration } = await vite.ssrLoadModule('/src/components/BackupConfiguration.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.__AEGIS_API_FIXTURES__
})

const capacity = { capacityBytes: { totalBytes: 61_075_263_488, usedBytes: 18_300_000_000, freeBytes: 42_775_263_488 }, usage: { docs: 0, archives: 0, media: 0, other: 0, vaultSeg: 0, versions: 0 }, unaccountedBytes: 18_300_000_000 }
const unavailableDisk = { available: false, status: 'UNKNOWN', reason: 'agent-unreachable', stale: false, device: null, model: null, smart: null, temperatureCelsius: null, powerOnHours: null, capacityBytes: null, warnings: [], measuredAt: null, ageSeconds: null, maxAgeSeconds: 1800 }
const healthyDisk = { available: true, status: 'HEALTHY', reason: null, stale: false, device: 'sda', model: 'AEGIS-FIXTURE M.2 2280 128GB', smart: { supported: true, enabled: true, passed: true }, temperatureCelsius: 41, powerOnHours: 3210, capacityBytes: 128035676160, warnings: [], measuredAt: '2026-08-07T08:58:00.000Z', ageSeconds: 120, maxAgeSeconds: 1800 }
const unavailableBackup = { available: false, reason: 'agent-unreachable', engine: null, state: 'UNKNOWN', target: null, policy: null, job: null, nextRun: null, lastSuccessfulBackup: null, lastFailedBackup: null, backupAgeSeconds: null, maxBackupAgeSeconds: null, bytesCovered: null, lastSnapshotId: null, integrity: 'NOT_RUN', restoreVerification: { at: null, status: 'NOT_TESTED' }, successRate30d: null, completedJobs30d: 0, risk: 'UNKNOWN', riskReasons: ['agent-unreachable'] }
const healthyBackup = { ...unavailableBackup, available: true, reason: null, engine: 'restic', state: 'READY', target: { id: 'usb-external-1', label: 'External USB SSD', type: 'external-mount', protection: 'DIFFERENT_DEVICE' }, policy: { activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: true }, nextRun: '2026-08-08T02:00:00.000Z', lastSuccessfulBackup: '2026-08-07T02:05:00.000Z', backupAgeSeconds: 25_000, maxBackupAgeSeconds: 129_600, bytesCovered: 18_300_000_000, lastSnapshotId: 'abc123', integrity: 'PASS', restoreVerification: { at: '2026-08-06T03:00:00.000Z', status: 'PASS' }, successRate30d: 100, completedJobs30d: 3, risk: 'HEALTHY', riskReasons: [] }
const healthyRaid = {
  available: true,
  status: 'HEALTHY',
  level: 'raid1',
  device: '/dev/md0',
  arrayState: 'clean',
  usableBytes: 62_000_000_000,
  mountPoint: '/mnt/aegis-backup',
  totalMembers: 2,
  activeMembers: 2,
  measuredAt: '2026-08-07T08:59:00.000Z',
  members: [
    { id: 'usb-a', label: 'USB Backup A', model: 'AEGIS-FIXTURE USB 64GB', device: '/dev/sdb', capacityBytes: 64_000_000_000, transport: 'USB 3', state: 'ACTIVE', role: 'member 0', readLatencyMs: 3.42, writeLatencyMs: 6.18, ioErrors: 0, temperatureCelsius: null },
    { id: 'usb-b', label: 'USB Backup B', model: 'AEGIS-FIXTURE USB 64GB', device: '/dev/sdc', capacityBytes: 64_000_000_000, transport: 'USB 3', state: 'ACTIVE', role: 'member 1', readLatencyMs: 3.71, writeLatencyMs: 6.44, ioErrors: 0, temperatureCelsius: null },
  ],
}

function renderStorage({ storage, backupView = { data: null, error: 'forbidden', loading: false }, lang = 'en', error = null, loading = false }) {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/storage': { loading, data: storage, error },
    '/api/backup': backupView,
  }
  return renderToStaticMarkup(React.createElement(Storage, { t: makeT(lang), go: () => {} }))
}

const FABRICATED = ['WD Red Pro', 'WD-WX32DA8L7K4N', 'Nightly incremental', 'offsite-tape', 'LTO-9', 'edge-site-B', '14,208']

test('STORAGE-UI-1 both agents absent: every new section says unavailable in words, nothing is a number or green', () => {
  const html = renderStorage({ storage: { ...capacity, diskHealth: unavailableDisk, raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' }, backup: unavailableBackup, maintenance: { active: false }, unavailable: { diskHealth: 'agent-unreachable', raid: 'not-configured', backups: 'agent-unreachable' } } })
  assert.ok(html.includes(STRINGS.en.diskUnavailable))
  assert.ok(html.includes(STRINGS.en.diskReasonAgentUnreachable))
  assert.ok(html.includes(STRINGS.en.backupUnavailableReason))
  assert.ok(html.includes(STRINGS.en.diskStatusUnknown))
  assert.ok(html.includes(STRINGS.en.backupStateUnknown))
  assert.equal(html.includes(STRINGS.en.diskStatusHealthy), false)
  assert.equal(html.includes(STRINGS.en.backupRiskHealthy), false)
  assert.equal(html.includes('°C'), false, 'no temperature is shown when none was measured')
  // The capacity card and the backup-table chrome keep rendering beside them.
  assert.ok(html.includes(STRINGS.en.capacity))
  // This fixture's /api/backup answer is a 403, so the client does not know the
  // schedule either way. It used to claim "no automatic backup schedule has been
  // configured" and offer an admin "Set up now" to a user who cannot perform it;
  // both were invented from an unreadable response. See storageBackupTruthUi.
  assert.ok(html.includes(STRINGS.en.backupHistoryForbidden))
  assert.equal(html.includes(STRINGS.en.backupScheduleEmpty), false, 'a 403 is not evidence that no schedule exists')
  assert.equal(html.includes(STRINGS.en.setupNow), false, 'no admin action is offered to a non-admin')
  assert.ok(html.includes(STRINGS.en.raidWhy))
  for (const fake of FABRICATED) assert.equal(html.includes(fake), false, `${fake} must never come back`)
})

test('STORAGE-UI-2 real evidence renders the model, temperature, hours and a HEALTHY chip; the serial is never on screen', () => {
  const history = [{ jobId: '11111111-1111-1111-1111-111111111111', kind: 'backup', trigger: 'schedule', startedAt: '2026-08-07T02:00:00.000Z', finishedAt: '2026-08-07T02:05:00.000Z', status: 'SUCCESS', targetId: 'usb-external-1', targetType: 'external-mount', protection: 'DIFFERENT_DEVICE', bytesScanned: 18_300_000_000, bytesBackedUp: 250_000_000, snapshotId: 'abc123', integrityCheck: 'PASS', restoreVerification: 'NOT_TESTED', errorCode: null }]
  const html = renderStorage({
    storage: { ...capacity, diskHealth: healthyDisk, raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' }, backup: healthyBackup, maintenance: { active: false }, unavailable: { raid: 'not-configured' } },
    backupView: { loading: false, error: null, data: { report: healthyBackup, targets: [], allowed: { scheduleIds: [], retentionIds: [] }, limits: null, tools: null, history } },
  })
  assert.ok(html.includes('AEGIS-FIXTURE M.2 2280 128GB'))
  assert.ok(html.includes('41 °C'))
  assert.ok(html.includes('3,210'))
  assert.ok(html.includes(STRINGS.en.diskStatusHealthy))
  assert.ok(html.includes(STRINGS.en.diskSmartPassed))
  assert.ok(html.includes(STRINGS.en.diskNoWarnings))
  assert.ok(html.includes(STRINGS.en.backupRiskHealthy))
  assert.ok(html.includes(STRINGS.en.backupStateReady))
  assert.ok(html.includes(STRINGS.en.protectionDifferentDevice))
  assert.ok(html.includes('100% (3)'))
  assert.ok(html.includes(STRINGS.en.jobBackup))
  assert.ok(html.includes(STRINGS.en.jobStatusSuccess))
  assert.equal(html.includes(STRINGS.en.backupScheduleEmpty), false, 'a real job replaces the empty row')
  assert.equal(html.includes('serial'), false)
  assert.equal(html.includes('FIXTURE-SERIAL'), false)
})

test('STORAGE-UI-3 stale disk evidence keeps the last readings visible but says Unknown and why', () => {
  const html = renderStorage({ storage: { ...capacity, diskHealth: { ...healthyDisk, stale: true, status: 'UNKNOWN', reason: 'stale', ageSeconds: 7200 }, raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' }, backup: unavailableBackup, maintenance: { active: false }, unavailable: { raid: 'not-configured', backups: 'agent-unreachable' } } })
  assert.ok(html.includes(STRINGS.en.diskStatusUnknown))
  assert.equal(html.includes(STRINGS.en.diskStatusHealthy), false)
  assert.ok(html.includes('AEGIS-FIXTURE M.2 2280 128GB'))
  assert.ok(html.includes(STRINGS.en.diskStale.replace('{minutes}', '30')))
})

test('STORAGE-UI-4 a same-disk target is UNPROTECTED and explained; null temperature renders a dash, never 0', () => {
  const html = renderStorage({ storage: {
    ...capacity,
    diskHealth: { ...healthyDisk, temperatureCelsius: null, warnings: ['pending-sectors'], status: 'WARNING' },
    raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' },
    backup: { ...healthyBackup, state: 'SAME_FAILURE_DOMAIN', risk: 'NOT_CONFIGURED', riskReasons: ['target-same-failure-domain'], target: { ...healthyBackup.target, protection: 'SAME_FAILURE_DOMAIN' } },
    maintenance: { active: false }, unavailable: { raid: 'not-configured', backups: 'not-configured' },
  } })
  assert.ok(html.includes(STRINGS.en.backupStateSameFailureDomain))
  assert.ok(html.includes(STRINGS.en.backupSameDomainWhy))
  assert.ok(html.includes(STRINGS.en.riskTargetSameFailureDomain))
  assert.ok(html.includes(STRINGS.en.diskWarnPendingSectors))
  assert.ok(html.includes(STRINGS.en.diskStatusWarning))
  assert.equal(html.includes('0 °C'), false)
  assert.equal(html.includes(STRINGS.en.backupRiskHealthy), false)
})

test('STORAGE-UI-5 an active write-freeze is announced, and a fetch error keeps the page chrome', () => {
  const frozen = renderStorage({ storage: { ...capacity, diskHealth: unavailableDisk, raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' }, backup: unavailableBackup, maintenance: { active: true, jobId: 'x', leaseUntil: '2026-08-07T09:10:00.000Z', acknowledged: true, inFlight: 0 }, unavailable: { raid: 'not-configured' } } })
  assert.ok(frozen.includes(STRINGS.en.backupMaintenanceActive.split('{until}')[0].trim()))
  const errored = renderStorage({ storage: null, error: 'server' })
  assert.ok(errored.includes(STRINGS.en.capacity), 'the page chrome stays mounted on error')
  assert.ok(errored.includes(STRINGS.en.diskUnavailable))
})

test('STORAGE-UI-6 the Admin configuration card is honest when the agent is absent and lists only allowlisted targets when present', () => {
  const render = (view) => {
    globalThis.__AEGIS_API_FIXTURES__ = { '/api/backup': view }
    return renderToStaticMarkup(React.createElement(BackupConfiguration, { t: makeT('en') }))
  }
  const absent = render({ loading: false, error: null, data: { report: unavailableBackup, targets: [], allowed: { scheduleIds: [], retentionIds: [] }, limits: null, tools: null, history: [] } })
  assert.ok(absent.includes(STRINGS.en.backupAgentUnavailable))
  assert.equal(absent.includes('<form'), false, 'no form that saves nowhere')

  const present = render({ loading: false, error: null, data: {
    report: healthyBackup,
    targets: [
      { id: 'usb-external-1', label: 'External USB SSD', type: 'external-mount', protection: 'DIFFERENT_DEVICE' },
      { id: 'same-disk-dir', label: 'Directory on the system SSD', type: 'external-mount', protection: 'SAME_FAILURE_DOMAIN' },
    ],
    allowed: { scheduleIds: ['disabled', 'daily-02:00'], retentionIds: ['keep-7d-4w'] },
    limits: { quiesceLeaseSeconds: 900, quiesceAckTimeoutSeconds: 120, maxBackupAgeHours: 36, verifyIntervalDays: 7 },
    tools: { resticPresent: false, pgDumpPresent: true },
    history: [],
  } })
  assert.ok(present.includes('<form'))
  assert.ok(present.includes('External USB SSD'))
  assert.ok(present.includes(STRINGS.en.protectionSameFailureDomain))
  assert.ok(present.includes(STRINGS.en.scheduleDaily0200))
  assert.ok(present.includes(STRINGS.en.retentionKeep7d4w))
  assert.ok(present.includes(STRINGS.en.backupToolsMissing))
  assert.ok(present.includes(STRINGS.en.backupRunNow))
  assert.equal(/type="text"|placeholder=/.test(present), false, 'no free-text path/host/command field exists')
})

test('STORAGE-UI-7 every language renders the unavailable state without a raw i18n key', () => {
  const keys = ['diskUnavailable', 'diskReasonAgentUnreachable', 'backupUnavailableReason', 'diskStatusUnknown', 'backupStateUnknown', 'colJob', 'colStarted', 'colResult']
  for (const lang of LANGS) {
    const html = renderStorage({ lang, storage: { ...capacity, diskHealth: unavailableDisk, raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' }, backup: unavailableBackup, maintenance: { active: false }, unavailable: { diskHealth: 'agent-unreachable', raid: 'not-configured', backups: 'agent-unreachable' } } })
    for (const key of keys) {
      assert.ok(html.includes(STRINGS[lang][key]), `${lang}.${key} must render`)
      assert.equal(html.includes(`>${key}<`), false, `${lang}: raw key ${key} must not leak`)
    }
  }
})

test('STORAGE-UI-8 RAID standby is an implemented hardware surface without inventing an array', () => {
  const html = renderStorage({ storage: {
    ...capacity,
    diskHealth: healthyDisk,
    raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' },
    backup: unavailableBackup,
    maintenance: { active: false },
    unavailable: { raid: 'not-configured', backups: 'agent-unreachable' },
  } })

  assert.ok(html.includes(STRINGS.en.raidTelemetryStandby))
  assert.ok(html.includes(STRINGS.en.raidMemberWaiting))
  assert.ok(html.includes(STRINGS.en.raidMemberSlot.replace('{n}', '1')))
  assert.ok(html.includes(STRINGS.en.raidMemberSlot.replace('{n}', '2')))
  assert.ok(html.includes(STRINGS.en.raidStatusNotConfigured))
  assert.equal(html.includes('/dev/md0'), false, 'no array device may be invented before telemetry exists')
  assert.equal(html.includes('RAID1'), false, 'no RAID level may be invented before telemetry exists')
  assert.equal(html.includes('64 GB'), false, 'no USB capacity may be invented before telemetry exists')
})

test('STORAGE-UI-9 validated future RAID telemetry fills the same surface with members and measured probes', () => {
  const html = renderStorage({ storage: {
    ...capacity,
    diskHealth: healthyDisk,
    raid: healthyRaid,
    backup: healthyBackup,
    maintenance: { active: false },
    unavailable: {},
  } })

  assert.ok(html.includes('/dev/md0'))
  assert.ok(html.includes('/mnt/aegis-backup'))
  assert.ok(html.includes('RAID1'))
  assert.ok(html.includes('USB Backup A'))
  assert.ok(html.includes('USB Backup B'))
  assert.ok(html.includes('/dev/sdb'))
  assert.ok(html.includes('/dev/sdc'))
  assert.ok(html.includes('3.42 ms'))
  assert.ok(html.includes('6.44 ms'))
  assert.ok(html.includes(STRINGS.en.raidStatusHealthy))
  assert.ok(html.includes(STRINGS.en.raidMemberActive))
  assert.equal(html.toLowerCase().includes('serial'), false, 'stable member identity stays server-side; serials are not exposed')
})
