// tests/twingateSettingsUi.test.js — AEGIS Drive (IDEA1) · Remote Access rendering
//
// The screen renders the real /api/remote-access contract. The rule under test
// is the one that shaped the whole feature: LOCAL connector runtime health is
// measured and shown as such, the Twingate CONTROL PLANE is not measured and
// says so, and no combination of fixtures can produce a rendering that claims
// the connector is online to Twingate.
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

const SETTINGS = {
  vaultAutoLockMinutes: 10,
  shareDefaults: { expiry: '24h', scope: 'zones', requirePassword: true },
}

/** The production state: connector container up and passing its healthcheck. */
const HEALTHY = {
  channel: 'twingate',
  resource: 'AEGIS Drive · NAS :443',
  accessModel: 'least-privilege',
  localConnector: {
    available: true, status: 'HEALTHY', reason: null, stale: false,
    runtimeState: 'RUNNING', health: 'HEALTHY', restartCount: 0,
    startedAt: '2026-09-01T08:30:00.000Z',
    measuredAt: '2026-09-05T09:59:30.000Z', ageSeconds: 30, maxAgeSeconds: 300,
  },
  controlPlane: { measured: false, telemetry: 'not-measured', state: 'unavailable', reason: 'no-approved-source' },
}

const withLocal = (overrides) => ({ ...HEALTHY, localConnector: { ...HEALTHY.localConnector, ...overrides } })

const UNAVAILABLE = {
  ...HEALTHY,
  localConnector: {
    available: false, status: 'UNKNOWN', reason: 'agent-unreachable', stale: false,
    runtimeState: null, health: null, restartCount: null, startedAt: null,
    measuredAt: null, ageSeconds: null, maxAgeSeconds: 300,
  },
}

function render({ remoteAccess = HEALTHY, lang = 'en', role = 'Admin', errors = {} } = {}) {
  const fx = (data, key) => ({ loading: false, data, error: errors[key] ?? null })
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/sessions': fx({ sessions: [], volatile: true }, 'sessions'),
    '/api/security/settings': fx({ settings: SETTINGS }, 'settings'),
    '/api/storage': fx(null, 'storage'),
    '/api/backup': fx(null, 'backup'),
    '/api/audit/me': fx(null, 'activity'),
    '/api/zones': fx({ zones: [] }, 'zones'),
    '/api/remote-access': fx(remoteAccess, 'remoteAccess'),
  }
  return renderToStaticMarkup(React.createElement(Settings, {
    t: makeT(lang), lang, setLang() {}, theme: 'light', setTheme() {},
    density: 'comfortable', setDensity() {}, interfaceStyle: 'classic',
    onInterfaceStyleChange() {}, role, user: USER, go() {}, onProfileSaved() {},
    initialTab: 'security', placeholderMode: false,
  }))
}

// ── The measured half renders as measured ────────────────────────────────────

test('TWUI-1 a healthy local connector renders Running / Healthy with its real values', () => {
  const html = render()
  assert.ok(html.includes(STRINGS.en.remoteLocalSection), 'the local block must be labelled')
  assert.ok(html.includes(STRINGS.en.runtimeRunning))
  assert.ok(html.includes(STRINGS.en.dockerHealthHealthy))
  assert.ok(html.includes(STRINGS.en.remoteRestartCount))
  // The measured timestamp is rendered, not a placeholder.
  assert.ok(html.includes(STRINGS.en.remoteLastMeasured))
  assert.ok(/2026/.test(html), 'the measured-at timestamp must appear')
})

test('TWUI-2 a stopped connector renders Stopped and never Healthy', () => {
  const html = render({
    remoteAccess: withLocal({ status: 'STOPPED', runtimeState: 'STOPPED', health: 'NOT_CONFIGURED', restartCount: 12 }),
  })
  assert.ok(html.includes(STRINGS.en.runtimeStopped))
  assert.ok(html.includes('12'), 'the real restart count must be shown')
  // The security overview row must agree with the card.
  assert.ok(html.includes(STRINGS.en.connStatusStopped))
})

test('TWUI-3 a restarting connector renders Restarting', () => {
  const html = render({
    remoteAccess: withLocal({ status: 'RESTARTING', runtimeState: 'RESTARTING', health: 'UNHEALTHY', restartCount: 147 }),
  })
  assert.ok(html.includes(STRINGS.en.runtimeRestarting))
  assert.ok(html.includes(STRINGS.en.connStatusRestarting))
})

test('TWUI-4 a running container with no healthcheck never renders as Healthy', () => {
  const html = render({
    remoteAccess: withLocal({ status: 'NOT_CONFIGURED', runtimeState: 'RUNNING', health: 'NOT_CONFIGURED' }),
  })
  assert.ok(html.includes(STRINGS.en.runtimeRunning), 'the container is genuinely running')
  assert.ok(html.includes(STRINGS.en.valNotConfigured), 'its health is not configured, not healthy')
  // The overview row must not claim health either.
  const overview = html.slice(html.indexOf(STRINGS.en.secRemoteLocalConnector))
  assert.equal(
    overview.slice(0, 400).includes(STRINGS.en.connStatusHealthy),
    false,
    'an unchecked container must not read as Healthy in the overview',
  )
})

// ── The unmeasured halves render as unmeasured ───────────────────────────────

test('TWUI-5 an unavailable local connector renders Not measured, with the reason', () => {
  const html = render({ remoteAccess: UNAVAILABLE })
  assert.ok(html.includes(STRINGS.en.valNotMeasured))
  assert.ok(html.includes(STRINGS.en.connReasonAgentUnreachable), 'the reason must be explained')
  // No fabricated runtime values.
  assert.equal(html.includes(STRINGS.en.runtimeRunning), false)
  assert.equal(html.includes(STRINGS.en.dockerHealthHealthy), false)
})

test('TWUI-6 stale evidence stops presenting the last reading as the current state', () => {
  const html = render({
    remoteAccess: withLocal({ status: 'UNKNOWN', reason: 'stale', stale: true }),
  })
  assert.ok(html.includes(STRINGS.en.connReasonStale))
  const overview = html.slice(html.indexOf(STRINGS.en.secRemoteLocalConnector))
  assert.equal(
    overview.slice(0, 400).includes(STRINGS.en.connStatusHealthy),
    false,
    'a stale reading must not read as Healthy',
  )
})

test('TWUI-7 each collector reason has its own rendered explanation', () => {
  const reasons = {
    'connector-not-found': STRINGS.en.connReasonNotFound,
    'docker-unavailable': STRINGS.en.connReasonDockerUnavailable,
    'inspect-failed': STRINGS.en.connReasonInspectFailed,
    'collector-not-run': STRINGS.en.connReasonCollectorNotRun,
    'not-configured': STRINGS.en.connReasonNotConfigured,
    'invalid-evidence': STRINGS.en.connReasonInvalid,
  }
  for (const [reason, copy] of Object.entries(reasons)) {
    const html = render({
      remoteAccess: { ...UNAVAILABLE, localConnector: { ...UNAVAILABLE.localConnector, reason } },
    })
    assert.ok(html.includes(copy), `${reason} must be explained in words`)
  }
})

// ── The control plane stays unmeasured, always ───────────────────────────────

test('TWUI-8 the control plane is rendered as a separate, unmeasured block', () => {
  const html = render() // local connector is HEALTHY here
  assert.ok(html.includes(STRINGS.en.remoteControlPlaneSection))
  assert.ok(html.includes(STRINGS.en.remoteControlTelemetryLabel))
  assert.ok(html.includes(STRINGS.en.remoteControlLiveState))
  assert.ok(html.includes(STRINGS.en.valUnavailable))
  assert.ok(html.includes(STRINGS.en.secRemoteControlTelemetry), 'the overview keeps its control-plane row')
  // The copy that stops a reader inferring a working tunnel from a healthy container.
  assert.ok(html.includes(STRINGS.en.remoteLocalScopeNote))
})

test('TWUI-9 no fixture can make the UI claim the connector is online to Twingate', () => {
  const fixtures = [HEALTHY, UNAVAILABLE,
    withLocal({ status: 'STOPPED', runtimeState: 'STOPPED' }),
    withLocal({ status: 'UNHEALTHY', health: 'UNHEALTHY' })]
  for (const remoteAccess of fixtures) {
    for (const lang of LANGS) {
      const html = render({ remoteAccess, lang })
      for (const claim of ['Twingate Online', 'Twingate: Online', 'Connector online', 'Connector Online']) {
        assert.equal(html.includes(claim), false, `${lang} rendered "${claim}"`)
      }
    }
  }
})

test('TWUI-10 no locale ships copy that asserts control-plane connectivity', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(STRINGS[lang])) {
      if (!/^(remote|conn|secRemote|runtime|dockerHealth)/.test(key)) continue
      assert.equal(/twingate online/i.test(value), false, `${lang}.${key}`)
      assert.equal(/connector (is )?online/i.test(value), false, `${lang}.${key}`)
    }
  }
})

// ── The rendering is honest in every language ────────────────────────────────

test('TWUI-11 the local and control-plane blocks are labelled in every locale', () => {
  for (const lang of LANGS) {
    const html = render({ lang })
    assert.ok(html.includes(STRINGS[lang].remoteLocalSection), `${lang} local section`)
    assert.ok(html.includes(STRINGS[lang].remoteControlPlaneSection), `${lang} control-plane section`)
    assert.ok(html.includes(STRINGS[lang].remoteLocalScopeNote), `${lang} scope note`)
  }
})

test('TWUI-12 a fetch failure surfaces an error rather than a fabricated state', () => {
  const html = render({ remoteAccess: null, errors: { remoteAccess: 'server' } })
  assert.ok(html.includes(STRINGS.en.errLoadTitle))
  assert.equal(html.includes(STRINGS.en.runtimeRunning), false)
  // The control-plane block is a constant and still renders truthfully.
  assert.ok(html.includes(STRINGS.en.remoteControlPlaneSection))
})
