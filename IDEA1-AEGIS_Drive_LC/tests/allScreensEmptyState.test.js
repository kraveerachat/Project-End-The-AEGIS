import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import * as fetchState from '../src/lib/fetchState.js'

const { visibleFetchError } = fetchState

const read = (path) => fs.readFile(new URL(path, import.meta.url), 'utf8')

test('Files keeps the toolbar and offers the first-folder action in an empty folder', async () => {
  const source = await read('../src/screens/Files.jsx')
  assert.match(source, /t\('emptyFolder'\)/)
  assert.match(source, /t\('createFirstFolder'\)/)
  assert.match(source, /setFolderModal\(true\)/)
})

test('Vault and File History do not replace the full screen with early loading/error returns', async () => {
  const [vault, history] = await Promise.all([
    read('../src/screens/Vault.jsx'),
    read('../src/screens/FileHistory.jsx'),
  ])
  assert.doesNotMatch(vault, /if\s*\(vaultApi\.loading\)\s*return/)
  assert.doesNotMatch(vault, /if\s*\(vaultApi\.error\)\s*return/)
  assert.match(vault, /t\('encryptFirstFile'\)/)
  assert.doesNotMatch(history, /if\s*\(listApi\.loading\)\s*return/)
  assert.doesNotMatch(history, /if\s*\(listApi\.error\)\s*return/)
  assert.match(history, /version-empty-track/)
  assert.match(history, /disabled/)
})

test('Upload Drawer, Shares, and Audit preserve list/table chrome around compact empty rows', async () => {
  const [uploads, shares, audit] = await Promise.all([
    read('../src/components/UploadDrawer.jsx'),
    read('../src/screens/Shares.jsx'),
    read('../src/screens/Audit.jsx'),
  ])
  assert.match(uploads, /InlineEmptyState/)
  assert.match(shares, /t\('emptyNoShares'\)/)
  assert.match(shares, /min-w-\[720px\]/)
  assert.doesNotMatch(shares, /\{shares\.length > 0 && \(/)
  assert.doesNotMatch(audit, /if\s*\(api\.loading\)\s*return/)
  assert.doesNotMatch(audit, /if\s*\(api\.error\)\s*return/)
  assert.match(audit, /t\('emptyNoAudit'\)/)
})

test('Storage keeps zero categories in the dual-ring legends and preserves backup table chrome', async () => {
  const [source, ring] = await Promise.all([
    read('../src/screens/Storage.jsx'),
    read('../src/components/CapacityRing.jsx'),
  ])
  assert.doesNotMatch(source, /if\s*\(api\.loading\)\s*return/)
  assert.doesNotMatch(source, /if\s*\(api\.error\)\s*return/)
  assert.match(source, /t\('backupScheduleEmpty'\)/)
  assert.match(source, /t\('setupNow'\)/)
  // A zero category has no truthful angular share, so Segment draws no arc. The
  // complete model still flows into LegendRows, where zero values render as a
  // disabled row. Seeing "Archives · 0 GB" keeps the empty state explicit.
  assert.match(ring, /t\('storageZeroGb'\)/)
  assert.match(ring, /if \(row\.frac <= 0\) return null/)
  assert.match(ring, /rows\.map\(\(row\) =>/)
  assert.match(ring, /if \(empty\) return <li/)
})

test('Access receives the authenticated account and keeps an additional-account empty row', async () => {
  const [app, access] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/screens/Access.jsx'),
  ])
  assert.match(app, /<Access t=\{t\} user=\{session\}/)
  assert.match(access, /export function Access\(\{ t, user, placeholderMode = false \}\)/)
  assert.match(access, /t\('currentDeviceSession'\)/)
  assert.match(access, /t\('noOtherUsers'\)/)
})

test('Settings is Twingate-only and does not offer a fake working mnemonic generator', async () => {
  // The intent of this test is unchanged — no invented remote channel, and no
  // control that implies a vault recovery path exists. What changed is that the
  // recovery button is now GONE rather than present-and-disabled, and the
  // connector row states that telemetry is unmeasured rather than showing a
  // measured-looking "Inactive". Both are asserted here and in the panels file,
  // because the copy those keys carried now lives in SettingsPanels.jsx.
  const [source, panels] = await Promise.all([
    read('../src/screens/Settings.jsx'),
    read('../src/components/SettingsPanels.jsx'),
  ])
  const both = `${source}
${panels}`
  assert.doesNotMatch(both, /VPN \+ VLAN|VPN \(0-A\)/)

  // A disabled "Generate 12-word recovery phrase" button is still a promise of
  // recovery. It must not exist in any state, enabled or otherwise.
  assert.doesNotMatch(both, /generateRecoveryPhrase/)
  assert.doesNotMatch(both, /vaultRecoveryNotConnected/)
  assert.match(panels, /t\('vaultRecMethod'\)/)
  assert.match(panels, /t\('valNotSupported'\)/)

  // "Inactive" was a measurement Drive never took. The replacement says so —
  // and since TWIN-2 the card separates what IS measured here (the local
  // connector container) from what is not (the Twingate control plane), so the
  // unmeasured claim now lives on the control-plane rows specifically.
  assert.doesNotMatch(both, /t\('remoteInactive'\)/)
  assert.match(panels, /t\('remoteControlTelemetryLabel'\)/)
  assert.match(panels, /t\('remoteControlLiveState'\)/)
  assert.match(panels, /t\('valNotMeasured'\)/)
  // The local block must never be able to speak for the control plane.
  assert.match(panels, /t\('remoteLocalScopeNote'\)/)

  // Twingate remains the only named remote channel.
  assert.match(panels, /t\('remoteChannelValue'\)/)
})

test('a backend that is not wired yet is handled separately from a transport fetch error', () => {
  assert.equal(visibleFetchError('server', true), null)
  assert.equal(visibleFetchError('network', true), null)
  assert.equal(visibleFetchError('timeout', true), null)
  // wired platform: a request that genuinely fails still surfaces its ErrorState
  assert.equal(visibleFetchError('server', false), 'server')
  assert.equal(visibleFetchError(null, false), null)
  assert.equal(visibleFetchError(undefined, false), null)
})

test('no screen renders ErrorState straight off a raw api.error — placeholderMode gates every one', async () => {
  const screens = [
    'Access', 'Audit', 'FileHistory', 'Files', 'Settings', 'Shares', 'Storage', 'Vault',
  ]
  for (const name of screens) {
    const source = await read(`../src/screens/${name}.jsx`)
    assert.match(source, /visibleFetchError\(/, `${name} must derive its error through visibleFetchError`)
    // ErrorState may only be reached through a placeholderMode-aware flag
    assert.doesNotMatch(
      source,
      /\w*[Aa]pi\.error\s*(\?|&&)/,
      `${name} still gates render on a raw api.error`,
    )
    assert.doesNotMatch(
      source,
      /kind=\{\w*[Aa]pi\.error\}/,
      `${name} still passes a raw api.error to ErrorState`,
    )
  }
})

test('affected data screens render dependency unavailable separately from real empty data', async () => {
  for (const name of ['Files', 'Shares', 'FileHistory', 'Audit', 'Access']) {
    const source = await read(`../src/screens/${name}.jsx`)
    assert.match(source, /DependencyUnavailableState/, `${name} must distinguish an unavailable dependency from an empty collection`)
  }
  const dashboard = await read('../src/screens/Dashboard.jsx')
  assert.match(dashboard, /DependencyUnavailableState/)
})

test('Settings receives placeholderMode so its cards obey the same rule as the data screens', async () => {
  const source = await read('../src/App.jsx')
  assert.match(source, /<Settings[\s\S]*?placeholderMode=\{placeholderMode\}[\s\S]*?\/>/)
})

test('one shared helper decides whether platform data is wired', () => {
  assert.equal(typeof fetchState.isPlatformWired, 'function')
  assert.equal(fetchState.isPlatformWired(null), false)
  assert.equal(fetchState.isPlatformWired({ ok: false, db: 'postgres' }), false)
  assert.equal(fetchState.isPlatformWired({ ok: true, db: 'memory' }), false)
  assert.equal(fetchState.isPlatformWired({ ok: true, db: 'postgres' }), true)
})

test('App uses the shared platform gate on every non-Dashboard screen', async () => {
  const source = await read('../src/App.jsx')
  assert.match(source, /!isPlatformWired\(healthApi\.data\)/)
  assert.doesNotMatch(source, /healthApi\.data\.db === 'memory'/)
  for (const name of ['Files', 'Vault', 'Shares', 'FileHistory', 'Storage', 'Audit', 'Access']) {
    assert.match(source, new RegExp(`<${name}[^>]*placeholderMode=\\{placeholderMode\\}`))
  }
  assert.doesNotMatch(source, /<Dashboard[^>]*placeholderMode=/)
})

test('App owns the only health poll and passes that same cycle to Dashboard and TopBar', async () => {
  const [app, dashboard, topBar] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/screens/Dashboard.jsx'),
    read('../src/components/TopBar.jsx'),
  ])
  assert.equal((app.match(/useApi\([^\n]*['"]\/healthz['"]/g) ?? []).length, 1)
  assert.match(app, /<Dashboard[^>]*health=\{healthApi\}/)
  assert.match(app, /<TopBar[\s\S]*?health=\{healthApi\}[\s\S]*?\/>/)
  assert.doesNotMatch(dashboard, /useApi\(['"]\/healthz['"]/)
  assert.doesNotMatch(topBar, /useApi\(['"]\/healthz['"]/)
})
