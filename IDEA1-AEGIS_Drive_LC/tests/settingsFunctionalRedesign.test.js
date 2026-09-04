// tests/settingsFunctionalRedesign.test.js — AEGIS Drive (IDEA1)
//
// Settings after the functional redesign. The rule under test is the same one
// that shaped the feature: a row either lets you change something real, does
// something real, or says plainly that the system decides it. Nothing on this
// screen may look measured when it was never measured, and nothing may look
// configurable when there is no value to store.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
const read = (rel) => fs.readFile(path.join(rootDir, rel), 'utf8')

let vite
let Settings

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ Settings } = await vite.ssrLoadModule('/src/screens/Settings.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.__AEGIS_API_FIXTURES__
})

const USER = { id: 1, username: 'kla', displayName: 'Kla', accountName: 'Kla' }

// An account that has deliberately moved OFF every default, so a rendered value
// that happens to equal a default proves nothing.
const SAVED_SETTINGS = {
  vaultAutoLockMinutes: 30,
  shareDefaults: { expiry: '7d', scope: 'any', requirePassword: false },
}

const SESSIONS = [
  { ref: 'a1', ip: '10.20.0.11', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', loginAt: 1, lastSeenAt: 2, current: true },
  { ref: 'b2', ip: '10.20.0.12', userAgent: 'Mozilla/5.0 (Macintosh) Safari/17', loginAt: 1, lastSeenAt: 1, current: false },
]

const STORAGE = {
  capacityBytes: { totalBytes: 61_075_263_488, usedBytes: 18_300_000_000, freeBytes: 42_775_263_488 },
  usage: {}, unaccountedBytes: 0,
  diskHealth: { available: true, status: 'HEALTHY' },
  raid: { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' },
  backup: { available: false, state: 'UNKNOWN', reason: 'agent-unreachable' },
  maintenance: null,
  unavailable: { raid: 'not-configured', backups: 'agent-unreachable' },
}

const ACTIVITY = {
  windowDays: 30,
  lastLoginAt: '2026-08-07T08:00:00.000Z',
  lastPasswordChangeAt: null,
  lastVaultUnlockAt: '2026-08-06T10:00:00.000Z',
  deniedLoginCount: 2,
  blockedActionCount: 0,
  truncated: false,
}

function render({
  tab, role = 'Admin', lang = 'en', placeholderMode = false,
  settings = SAVED_SETTINGS, storage = STORAGE, activity = ACTIVITY,
  zones = [{ id: 'z1', name: 'Edge LAN', cidr: '10.20.0.0/24' }],
  errors = {},
} = {}) {
  const fx = (data, key) => ({ loading: false, data, error: errors[key] ?? null })
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/sessions': fx({ sessions: SESSIONS, volatile: true }, 'sessions'),
    '/api/security/settings': fx(settings ? { settings } : null, 'settings'),
    '/api/storage': fx(storage, 'storage'),
    '/api/audit/me': fx(activity ? { activity } : null, 'activity'),
    '/api/zones': fx({ zones }, 'zones'),
  }
  return renderToStaticMarkup(React.createElement(Settings, {
    t: makeT(lang), lang, setLang() {}, theme: 'light', setTheme() {},
    density: 'comfortable', setDensity() {}, interfaceStyle: 'classic',
    onInterfaceStyleChange() {}, role, user: USER, go() {}, onProfileSaved() {},
    initialTab: tab, placeholderMode,
  }))
}

// ── The three categories are visible ─────────────────────────────────────────

test('every Settings panel declares whether it is configurable, an action, or system-managed', () => {
  const html = render({ tab: 'security' })
  for (const label of [STRINGS.en.setCatConfigurable, STRINGS.en.setCatActionable, STRINGS.en.setCatSystemManaged]) {
    assert.ok(html.includes(label), `expected the "${label}" category chip on the security tab`)
  }
})

// ── Security overview ────────────────────────────────────────────────────────

test('the security overview reports the real session count and invents no score', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.secOverviewTitle))
  // Two sessions came back from the API; the overview shows two, not a guess.
  assert.ok(/Active sessions[\s\S]{0,220}>2</.test(html), 'expected the measured session count')
  // No score, grade, or percentage-out-of-100 anywhere.
  assert.doesNotMatch(html, /Security score|\/\s*100\b|[0-9]+\s*\/\s*10\b/)
})

// ── Private Vault ────────────────────────────────────────────────────────────

test('vault protection states the zero-knowledge properties and never shows key material', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.vaultProtectionTitle))
  assert.ok(html.includes(STRINGS.en.vaultProtDerivationValue))
  assert.ok(html.includes(STRINGS.en.vaultProtLockScopeValue))
  // The card explains why no lock button exists here rather than shipping one
  // that would always act on an already-locked vault.
  assert.ok(html.includes(STRINGS.en.vaultProtLockScopeNote))
  // Nothing that could be mistaken for key material. The WORD "passphrase" is
  // expected here (the recovery policy explains what losing one costs); what must
  // never appear is an actual key, wrapped DEK, salt, or verifier value.
  assert.doesNotMatch(html, /BEGIN [A-Z ]*KEY|wrappedDek|wrapIv|saltB64|verifier/i)
  // No long base64/hex run that could be key material.
  assert.doesNotMatch(html, /[A-Za-z0-9+/]{40,}={0,2}/)
})

test('auto-lock renders the value saved on the account, not the built-in default', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.vaultAutoLockTitle))
  // 30 is this account's saved choice; 10 is the column default. Showing 10 here
  // would mean the screen reports a policy the account is not actually using.
  assert.ok(html.includes('30 minutes'), 'expected the account value of 30 minutes')
  assert.equal(html.includes('10 minutes'), false)
})

test('the dead recovery-phrase generator is gone and the policy is stated instead', () => {
  const html = render({ tab: 'security' })
  assert.equal(html.includes(STRINGS.en.generateRecoveryPhrase), false)
  assert.ok(html.includes(STRINGS.en.vaultRecoveryPolicyTitle))
  assert.ok(html.includes(STRINGS.en.vaultRecKeyLossValue))
  assert.ok(html.includes(STRINGS.en.vaultRecPolicyBody))
})

// ── Share defaults ───────────────────────────────────────────────────────────

test('share defaults render the saved selection and offer only enforceable values', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.shareDefaultsSub))
  // Saved: 7 days / any network / password not required.
  assert.match(html, /<option value="7d" selected=""/)
  assert.match(html, /<option value="any" selected=""/)

  // Only expiries the share contract accepts appear as options.
  const offered = [...html.matchAll(/<option value="(1h|24h|7d|30d|365d|90d)"/g)].map((m) => m[1])
  assert.deepEqual([...new Set(offered)].sort(), ['1h', '24h', '30d', '7d'])

  // Scope options are exactly the two the server enforces — no Public Internet.
  assert.equal(html.includes('public-internet'), false)
  assert.doesNotMatch(html, /Public Internet/i)

  // No download-permission control: the share model has no such field.
  assert.doesNotMatch(html, /Allow download|allowDownload|downloadPermission/i)
})

test('no default share password is offered, requested, or rendered', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.shareDefaultsNoStoredPassword))
  // The defaults panel must not contain a password input of any kind.
  const panel = html.slice(html.indexOf(STRINGS.en.shareDefaultsSub))
  const upToNextCard = panel.slice(0, panel.indexOf(STRINGS.en.remoteAccessTitle))
  assert.doesNotMatch(upToNextCard, /type="password"/)
})

// ── Remote access ────────────────────────────────────────────────────────────

test('remote access reports unmeasured telemetry instead of a fabricated up or down state', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.remoteChannelValue))
  assert.ok(html.includes(STRINGS.en.remoteTelemetryNote))
  // "Not measured" / "Unavailable" — never a state that implies a reading.
  assert.ok(html.includes(STRINGS.en.valNotMeasured))
  assert.equal(html.includes(STRINGS.en.remoteInactive), false)
  assert.doesNotMatch(html, /Twingate Online|Connector online|Connector offline/i)
})

test('the connection test is labelled as Drive reachability, not connector health', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.connTestTitle))
  assert.ok(html.includes(STRINGS.en.connTestAction))
  assert.ok(html.includes(STRINGS.en.connTestScopeNote))
  // No result is claimed before the action has been run.
  assert.equal(html.includes(STRINGS.en.connTestPass), false)
})

// ── Security activity ────────────────────────────────────────────────────────

test('security activity shows only values present in the audit summary', () => {
  const html = render({ tab: 'security' })
  assert.ok(html.includes(STRINGS.en.secActivityTitle))
  assert.ok(html.includes(STRINGS.en.secActivityDeniedLogins))
  assert.ok(/Denied sign-ins[\s\S]{0,200}>2</.test(html), 'expected the real denied-login count')
  // A password change that has never happened renders as Never, not as a date.
  assert.ok(html.includes(STRINGS.en.valNever))
})

test('a DataLake-User is not offered the Admin-only audit log link', () => {
  const admin = render({ tab: 'security', role: 'Admin' })
  const user = render({ tab: 'security', role: 'DataLake-User' })
  assert.ok(admin.includes(STRINGS.en.secActivityViewAudit))
  assert.equal(user.includes(STRINGS.en.secActivityViewAudit), false)
})

// ── Storage & Data ───────────────────────────────────────────────────────────

test('storage overview renders measured bytes and keeps RAID truthful', () => {
  const html = render({ tab: 'storagedata' })
  assert.ok(html.includes(STRINGS.en.storageOverviewTitle))
  // 61_075_263_488 B formatted — the fixture value, not a constant in the JSX.
  assert.ok(/56\.9|61\.1/.test(html), 'expected the measured filesystem size to be rendered')
  assert.ok(html.includes(STRINGS.en.valNotConfigured), 'RAID must still say Not configured')
  assert.doesNotMatch(html, /RAID\s*(1|5|6|10)\b|Array healthy/i)
})

test('the unimplemented snapshot placeholder is gone and real protections are named', () => {
  const html = render({ tab: 'storagedata' })
  assert.equal(html.includes(STRINGS.en.snapScheduleTodo), false)
  assert.equal(html.includes(STRINGS.en.notImplemented), false)
  assert.ok(html.includes(STRINGS.en.dataProtectionTitle))
  assert.ok(html.includes(STRINGS.en.dpTrashRetentionValue), 'Trash retention is stated')
  assert.ok(html.includes(STRINGS.en.dpHistoryNotSnapshot), 'File history is distinguished from a snapshot')
})

test('an unreachable backup agent produces a readiness list, not a fabricated configuration', () => {
  const html = render({ tab: 'storagedata' })
  assert.ok(html.includes(STRINGS.en.backupReadinessTitle))
  assert.ok(html.includes(STRINGS.en.backupReqOffHost))
  assert.ok(html.includes(STRINGS.en.backupReadinessNote))
  // Nothing that would let a browser name a host path or command.
  assert.doesNotMatch(html, /rsync|ssh:\/\/|\/mnt\/|\/backup\b/i)
})

test('a connected backup agent does not show the readiness list', () => {
  const html = render({
    tab: 'storagedata',
    storage: { ...STORAGE, backup: { available: true, state: 'READY', risk: 'HEALTHY' } },
  })
  assert.equal(html.includes(STRINGS.en.backupReqOffHost), false)
})

// ── Administrator ────────────────────────────────────────────────────────────

test('encryption posture separates the vault from the Data Lake and offers no key rotation', () => {
  const html = render({ tab: 'admin' })
  assert.ok(html.includes(STRINGS.en.encPostureTitle))
  assert.ok(html.includes(STRINGS.en.encPostureNote))
  // The Data Lake is not implied to be encrypted.
  assert.ok(html.includes(STRINGS.en.valNotConfigured))
  // The note explains that there is nothing to rotate, so the WORD appears —
  // what must not exist is a control offering to do it.
  assert.doesNotMatch(html, /<button[^>]*>[^<]*[Rr]otat/)
  assert.doesNotMatch(html, /rotateKey|rotateEncryption/i)
})

test('network zones stay editable and say where they apply and what they do not touch', () => {
  const html = render({ tab: 'admin' })
  assert.ok(html.includes('10.20.0.0/24'))
  assert.ok(html.includes(STRINGS.en.addZone))
  assert.ok(html.includes(STRINGS.en.zoneUsageBody), 'zones must explain that they are share policy')
  assert.ok(html.includes(STRINGS.en.zoneSnapshotNote), 'removal must not imply existing shares widen')
  assert.ok(html.includes(STRINGS.en.firewallNote))
  // This screen never claims to manage a firewall.
  assert.doesNotMatch(html, /ufw |iptables|nft\b/i)
})

test('the admin tab leaves no DOM trace for a DataLake-User', () => {
  const html = render({ tab: 'admin', role: 'DataLake-User' })
  for (const secret of [
    STRINGS.en.encPostureTitle, STRINGS.en.networkZones,
    STRINGS.en.backupTargets, STRINGS.en.adminLinksTitle,
  ]) {
    assert.equal(html.includes(secret), false, `admin-only copy leaked: ${secret}`)
  }
  assert.equal(html.includes('10.20.0.0/24'), false, 'zone CIDRs leaked to a non-admin')
})

// ── Failure and placeholder behaviour ────────────────────────────────────────

test('placeholderMode reports nothing as broken — it means the backend is not wired yet', () => {
  const html = render({
    tab: 'security',
    placeholderMode: true,
    settings: null,
    activity: null,
    errors: { settings: 'server', activity: 'server', storage: 'server' },
  })
  assert.equal(html.includes(STRINGS.en.errLoadTitle), false, 'no ErrorState in placeholder mode')
})

test('a genuine settings fetch failure is surfaced once the platform is wired', () => {
  const html = render({
    tab: 'security',
    placeholderMode: false,
    settings: null,
    errors: { settings: 'server' },
  })
  assert.ok(html.includes(STRINGS.en.errLoadTitle), 'a real failure must still be visible')
})

// ── Wiring that cannot be observed from Settings alone ───────────────────────

test('Vault takes its idle budget from the account setting, not from a fixed constant', async () => {
  const source = await read('src/screens/Vault.jsx')
  assert.match(source, /useApi\('\/api\/security\/settings'\)/)
  assert.match(source, /vaultAutoLockMinutes/)
  // The timer must be armed from the resolved value and re-armed when it changes.
  assert.match(source, /setTimeout\(\(\) => lock\(true\), idleLockMs\)/)
  assert.match(source, /\}, \[unlocked, lock, idleLockMs\]\)/)
  // The old hard-coded constant may survive only as the documented fallback.
  assert.doesNotMatch(source, /setTimeout\(\(\) => lock\(true\), IDLE_LOCK_MS\)/)
})

test('Create share initialises from the saved defaults and never writes them back', async () => {
  const source = await read('src/screens/Shares.jsx')
  assert.match(source, /useApi\('\/api\/security\/settings'\)/)
  assert.match(source, /defaults\.expiry/)
  assert.match(source, /defaults\.scope/)
  assert.match(source, /defaults\.requirePassword \? 'password' : 'none'/)
  // Read-only: editing one share must not PATCH the account defaults.
  assert.doesNotMatch(source, /apiFetch\('\/api\/security\/settings'[\s\S]{0,80}PATCH/)
})

test('no banned fake control appears anywhere in the Settings surface', async () => {
  const sources = (await Promise.all([
    read('src/screens/Settings.jsx'),
    read('src/components/SettingsPanels.jsx'),
  ])).join('\n')
  const BANNED = [
    /disableVaultEncryption|showVaultKey|exportVaultKey|resetVaultKey/i,
    /rotateEncryptionKey|rotateKey/i,
    /restartConnector|connectorRestart/i,
    /enableRaid|raidEnable/i,
    /snapshotSchedule/i,
    /defaultSharePassword|storedSharePassword/i,
  ]
  for (const pattern of BANNED) {
    assert.doesNotMatch(sources, pattern, `a banned fake control matched ${pattern}`)
  }
})
