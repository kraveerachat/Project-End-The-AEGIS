// tests/storageBackupTruthUi.test.js — AEGIS Drive (IDEA1)
// Three state-presentation defects found during production acceptance of the
// Storage screen. All three had the same shape: the screen stated something it
// had not measured.
//
//   A. An unreadable /api/backup (403 for a DataLake-User, or any failed
//      request) left `history = []`, which the screen rendered as the positive
//      fact "no automatic backup schedule has been configured", complete with
//      an admin "Set up now" button offered to a user who cannot perform it.
//
//   B. The most prominent chip on the card was the operational state. The agent
//      can truthfully report state=READY with risk=CRITICAL — ready to run, but
//      no successful backup has ever completed — and a green READY read as
//      "backups are healthy" while nothing was protected.
//
//   C. RAID said "Not connected", which implies a device waiting at the end of a
//      cable. Nothing is connected or disconnected: no array is configured.
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
})

after(async () => {
  await vite?.close()
  delete globalThis.__AEGIS_API_FIXTURES__
})

const capacity = {
  capacityBytes: { totalBytes: 61_075_263_488, usedBytes: 18_300_000_000, freeBytes: 42_775_263_488 },
  usage: { docs: 0, archives: 0, media: 0, other: 0, vaultSeg: 0, versions: 0 },
  unaccountedBytes: 18_300_000_000,
}
const disk = { available: false, status: 'UNKNOWN', reason: 'agent-unreachable', stale: false, device: null, model: null, smart: null, temperatureCelsius: null, powerOnHours: null, capacityBytes: null, warnings: [], measuredAt: null, ageSeconds: null, maxAgeSeconds: 1800 }
const raid = { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' }

const baseBackup = {
  available: true, reason: null, engine: 'restic', state: 'NOT_CONFIGURED', target: null,
  policy: null, job: null, nextRun: null, lastSuccessfulBackup: null, lastFailedBackup: null,
  backupAgeSeconds: null, maxBackupAgeSeconds: null, bytesCovered: null, lastSnapshotId: null,
  integrity: 'NOT_RUN', restoreVerification: { at: null, status: 'NOT_TESTED' },
  successRate30d: null, completedJobs30d: 0, risk: 'NOT_CONFIGURED', riskReasons: ['no-target-selected'],
}

function render({ backup = baseBackup, backupView, lang = 'en' }) {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/storage': { loading: false, error: null, data: { ...capacity, diskHealth: disk, raid, backup, maintenance: { active: false }, unavailable: { raid: 'not-configured' } } },
    '/api/backup': backupView,
  }
  return renderToStaticMarkup(React.createElement(Storage, { t: makeT(lang), go: () => {} }))
}

/* ── Defect A — an unreadable response is not a configuration fact ── */

test('BACKUP-TRUTH-A1 a 403 renders as "administrators only", never as "no schedule configured"', () => {
  const html = render({ backupView: { loading: false, error: 'forbidden', data: null } })
  assert.ok(html.includes(STRINGS.en.backupHistoryForbidden))
  assert.equal(html.includes(STRINGS.en.backupScheduleEmpty), false, 'a 403 must not become a claim about the schedule')
  assert.equal(html.includes(STRINGS.en.setupNow), false, 'a non-admin must not be offered the admin setup action')
})

test('BACKUP-TRUTH-A2 a failed request renders as unknown, not as an invented configuration', () => {
  for (const kind of ['server', 'network', 'timeout']) {
    const html = render({ backupView: { loading: false, error: kind, data: null } })
    assert.ok(html.includes(STRINGS.en.backupHistoryUnavailable), `[${kind}] the state must read as unknown`)
    assert.equal(html.includes(STRINGS.en.backupScheduleEmpty), false, `[${kind}] must not fabricate a schedule fact`)
    assert.equal(html.includes(STRINGS.en.setupNow), false, `[${kind}] must not offer an action on unknown state`)
  }
})

test('BACKUP-TRUTH-A3 loading is its own state, distinct from empty', () => {
  const html = render({ backupView: { loading: true, error: null, data: null } })
  assert.ok(html.includes(STRINGS.en.backupHistoryLoading))
  assert.equal(html.includes(STRINGS.en.backupHistoryEmpty), false, 'a pending request is not an empty history')
  assert.equal(html.includes(STRINGS.en.backupScheduleEmpty), false)
})

test('BACKUP-TRUTH-A4 an admin who really can read an unconfigured agent does get the setup action', () => {
  const html = render({ backupView: { loading: false, error: null, data: { history: [] } } })
  // The request succeeded, so this client passed requireRole(ADMIN) and the
  // agent itself reported NOT_CONFIGURED. Now the claim is measured, and the
  // action is one this user can actually perform.
  assert.ok(html.includes(STRINGS.en.backupScheduleEmpty))
  assert.ok(html.includes(STRINGS.en.setupNow))
})

test('BACKUP-TRUTH-A5 a configured agent with no recorded jobs says exactly that', () => {
  const backup = { ...baseBackup, state: 'READY', risk: 'CRITICAL', riskReasons: ['no-successful-backup'], target: { id: 'usb-1', label: 'External USB SSD', type: 'external-mount', protection: 'DIFFERENT_DEVICE' } }
  const html = render({ backup, backupView: { loading: false, error: null, data: { history: [] } } })
  assert.ok(html.includes(STRINGS.en.backupHistoryEmpty), 'an empty history on a configured agent is reported as empty')
  assert.equal(html.includes(STRINGS.en.backupScheduleEmpty), false, 'a configured target is not "no schedule configured"')
  assert.equal(html.includes(STRINGS.en.setupNow), false, 'nothing to set up once a protected target exists')
})

/* ── Defect B — risk outranks operational state ── */

test('BACKUP-TRUTH-B1 READY never renders as a healthy chip while protection risk is CRITICAL', () => {
  const backup = {
    ...baseBackup, state: 'READY', risk: 'CRITICAL', riskReasons: ['no-successful-backup'],
    target: { id: 'usb-1', label: 'External USB SSD', type: 'external-mount', protection: 'DIFFERENT_DEVICE' },
  }
  const html = render({ backup, backupView: { loading: false, error: null, data: { history: [] } } })

  // Both facts are present — READY is true and must stay visible.
  assert.ok(html.includes(STRINGS.en.backupStateReady))
  assert.ok(html.includes(STRINGS.en.backupRiskCritical))
  assert.ok(html.includes(STRINGS.en.backupProtection), 'the risk chip names what it is measuring')
  assert.ok(html.includes(STRINGS.en.riskNoSuccessfulBackup), 'the measured reason is shown')

  // The tone is what carries "healthy", and it must belong to the risk. The
  // READY chip sits in a neutral chip; only the risk chip may be toned.
  const readyChip = chipAround(html, STRINGS.en.backupStateReady)
  assert.ok(!/bg-ok|text-ok|--ok/.test(readyChip), `READY must not be rendered in the healthy tone: ${readyChip}`)
  const riskChip = chipAround(html, STRINGS.en.backupRiskCritical)
  assert.ok(/danger/.test(riskChip), `the CRITICAL risk must carry the danger tone: ${riskChip}`)
})

test('BACKUP-TRUTH-B2 a genuinely healthy backup still reads as healthy', () => {
  const backup = {
    ...baseBackup, state: 'READY', risk: 'HEALTHY', riskReasons: [],
    target: { id: 'usb-1', label: 'External USB SSD', type: 'external-mount', protection: 'DIFFERENT_DEVICE' },
    lastSuccessfulBackup: '2026-08-07T02:05:00.000Z', integrity: 'PASS',
    restoreVerification: { at: '2026-08-06T03:00:00.000Z', status: 'PASS' },
  }
  const html = render({ backup, backupView: { loading: false, error: null, data: { history: [] } } })
  const riskChip = chipAround(html, STRINGS.en.backupRiskHealthy)
  assert.ok(/ok/.test(riskChip), `a HEALTHY risk keeps the healthy tone: ${riskChip}`)
})

/** The rendered chip element containing `label`, for tone inspection. */
function chipAround(html, label) {
  const at = html.indexOf(label)
  assert.notEqual(at, -1, `"${label}" was not rendered at all`)
  const start = html.lastIndexOf('<span', at)
  return html.slice(start === -1 ? Math.max(0, at - 400) : start, at + label.length)
}

/* ── Defect C — RAID wording, and what RAID would actually require ── */

test('BACKUP-TRUTH-C1 RAID says "not configured", not "not connected", and explains what it would need', () => {
  const html = render({ backupView: { loading: false, error: 'forbidden', data: null } })
  assert.ok(html.includes(STRINGS.en.notConfigured))
  assert.ok(html.includes(STRINGS.en.raidWhy))
  assert.ok(html.includes(STRINGS.en.raidRequirement), 'the card explains what RAID would require')

  // No invented array telemetry of any kind.
  for (const fake of ['degraded', 'Degraded', 'rebuild', 'Rebuild', 'RAID 1', 'RAID 5', 'md0', '/dev/md']) {
    assert.equal(html.includes(fake), false, `${fake} must never appear — no array exists to report`)
  }
  assert.equal(/RAID[^<]*\d+\s*%/.test(html), false, 'no array percentage is invented')
})

test('BACKUP-TRUTH-C2 the RAID copy names the same-drive traps as non-solutions', () => {
  // The wording has to close the door the prompt named: another partition, LV,
  // container volume or directory on the same SSD is not redundancy.
  const en = STRINGS.en.raidRequirement.toLowerCase()
  for (const term of ['partition', 'logical volume', 'container volume', 'directory']) {
    assert.ok(en.includes(term), `the RAID explanation must rule out a same-drive "${term}"`)
  }
  assert.ok(STRINGS.en.backupWhyExternal.toLowerCase().includes('same drive'), 'the backup copy rules out a same-drive target')
})

/* ── no same-disk path is ever presented as protected backup ── */

test('BACKUP-TRUTH-D1 a same-failure-domain target is never drawn as a configured backup', () => {
  const backup = {
    ...baseBackup, state: 'SAME_FAILURE_DOMAIN', risk: 'NOT_CONFIGURED',
    riskReasons: ['target-same-failure-domain'],
    target: { id: 'lv-2', label: 'Second logical volume', type: 'external-mount', protection: 'SAME_FAILURE_DOMAIN' },
  }
  const html = render({ backup, backupView: { loading: false, error: null, data: { history: [] } } })
  assert.ok(html.includes(STRINGS.en.backupSameDomainWhy), 'the same-domain danger is stated')
  assert.ok(html.includes(STRINGS.en.riskTargetSameFailureDomain))
  assert.ok(html.includes(STRINGS.en.notConfigured), 'it is presented as not configured, not as protected')
  assert.equal(html.includes(STRINGS.en.backupRiskHealthy), false)
})

test('BACKUP-TRUTH-D2 no raw machine reason code is ever shown to a reader', () => {
  // `agent-unreachable` is a transport reason, not one of the risk reasons that
  // has a translation. The unavailable card already explains it in words, so
  // the risk list must not repeat it as a bare identifier.
  const html = render({
    backup: { ...baseBackup, available: false, reason: 'agent-unreachable', state: 'UNKNOWN', risk: 'UNKNOWN', riskReasons: ['agent-unreachable'] },
    backupView: { loading: false, error: null, data: { history: [] } },
  })
  assert.equal(html.includes('agent-unreachable'), false, 'a raw reason code must not reach the screen')
  assert.ok(html.includes(STRINGS.en.backupUnavailableReason), 'the reason is stated in words instead')
  assert.ok(html.includes(STRINGS.en.agentUnavailable))
})

/* ── localisation ── */

test('BACKUP-TRUTH-E1 every new state string exists in all three locales', () => {
  const keys = [
    'notConfigured', 'agentUnavailable', 'raidRequirement', 'backupProtection', 'backupWhyExternal',
    'backupReadinessTitle', 'backupHistoryForbidden', 'backupHistoryUnavailable', 'backupHistoryEmpty',
    'backupHistoryLoading', 'backupReq1', 'backupReq2', 'backupReq3', 'backupReq4', 'backupReq5',
    'backupReq6', 'backupReq7', 'backupReq8',
  ]
  for (const key of keys) {
    for (const lang of LANGS) {
      const value = STRINGS[lang][key]
      assert.ok(typeof value === 'string' && value.trim().length > 0, `[${lang}] ${key} is missing`)
    }
    for (const lang of ['th', 'zh']) {
      assert.notEqual(STRINGS[lang][key], STRINGS.en[key], `[${lang}] ${key} must be translated`)
    }
  }
})

test('BACKUP-TRUTH-E2 no locale leaks a raw i18n key into the not-configured card', () => {
  for (const lang of LANGS) {
    const html = render({ backupView: { loading: false, error: 'forbidden', data: null }, lang })
    for (const key of ['backupHistoryForbidden', 'notConfigured', 'raidRequirement', 'backupReq1']) {
      assert.equal(html.includes(`>${key}<`), false, `[${lang}] ${key} rendered as a raw key`)
    }
    assert.ok(html.includes(STRINGS[lang].backupHistoryForbidden), `[${lang}] the forbidden copy is translated`)
  }
})
