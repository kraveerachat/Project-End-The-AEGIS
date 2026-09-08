// tests/shareScopeTruthUi.test.js — AEGIS Drive (IDEA1) · Share scope UI truth
//
// This suite used to pin a single claim: the Shares screen offers only `zones`
// and `any`, because Public Internet sharing did not exist anywhere. That claim
// is obsolete after PUBLIC-SHARE-4, and deleting the suite to make it green
// would have thrown away the only guard on UI honesty.
//
// What it defends now is a two-state matrix, because the honest answer depends
// on the deployment rather than on the build:
//
//   capability false/unknown  →  two scopes, and Public Internet is a read-only
//                                unavailable fact. This is the default.
//   capability true           →  three scopes, with public-specific risk copy,
//                                a mandatory link password and a short expiry.
//
// The capability is server-owned (GET /api/shares → capabilities.publicSelectable).
// Nothing here may make it true from the client side, and "unknown" must fail
// toward unavailable.
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'
import {
  shareBackend, resetShareBackend, PRIVATE_EXPIRES_AT, PUBLIC_EXPIRES_AT,
} from './fixtures/publicShareUiApi.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => normalizePath(path.join(rootDir, 'tests/fixtures', name))

let dom
let createRoot
let vite
let Shares

before(async () => {
  // react-dom captures `canUseDOM` at import time, so the jsdom globals have to
  // exist before it is loaded or simulated input is silently swallowed.
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))

  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: [
        { find: '../lib/hooks.js', replacement: fixture('mockHooks.js') },
        { find: '../lib/api.js', replacement: fixture('publicShareUiApi.js') },
      ],
    },
  })
  ;({ Shares } = await vite.ssrLoadModule('/src/screens/Shares.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  delete globalThis.__AEGIS_API_FIXTURES__
  delete globalThis.__AEGIS_PUBLIC_SHARE_UI__
  dom?.window.close()
})

beforeEach(() => resetShareBackend())

const FILES = [{ id: 'f1', name: 'q4-report.pdf', type: 'PDF', vault: false }]

/**
 * @param {{publicSelectable?: unknown}|undefined} capabilities
 *   `undefined` models the loading/failed read, which must behave as unavailable.
 */
function setFixture(capabilities, shares = []) {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/files': { loading: false, data: { files: FILES }, error: null },
    '/api/shares': {
      loading: false,
      data: capabilities === undefined ? { shares } : { shares, capabilities },
      error: null,
    },
    '/api/security/settings': { loading: false, data: null, error: null },
  }
}

function render(capabilities, { lang = 'en', shares = [] } = {}) {
  setFixture(capabilities, shares)
  return renderToStaticMarkup(React.createElement(Shares, { t: makeT(lang) }))
}

/** The scope radiogroup markup only, so table filters cannot be mistaken for options. */
function scopeGroup(html, lang = 'en') {
  return html.match(
    new RegExp(`<div role="radiogroup" aria-label="${STRINGS[lang].networkScope}"[\\s\\S]*?</div>`),
  )?.[0] ?? ''
}

/* ── harness — the real screen, driven through its real controls ─── */
async function mount(capabilities, { lang = 'en', shares = [] } = {}) {
  setFixture(capabilities, shares)
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(Shares, { t: makeT(lang) })))

  const setSelectValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
  const setInputValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set

  return {
    host,
    scopeRadios: () => [
      ...host.querySelectorAll(`[role="radiogroup"][aria-label="${STRINGS[lang].networkScope}"] [role="radio"]`),
    ],
    /** Pick a network scope the way a user does: click its radio. */
    async chooseScope(label) {
      const radio = [...host.querySelectorAll('[role="radio"]')].find((el) => el.textContent === label)
      assert.ok(radio, `no scope radio labelled ${label}`)
      await act(async () => radio.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    },
    select: (id) => host.querySelector(`select#${id}`),
    async choose(id, value) {
      const el = host.querySelector(`select#${id}`)
      assert.ok(el, `no <select id="${id}">`)
      await act(async () => {
        setSelectValue.call(el, value)
        el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
    },
    async typePassword(value) {
      const el = host.querySelector('input#share-pw')
      assert.ok(el, 'the link password field must be rendered')
      await act(async () => {
        setInputValue.call(el, value)
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    createButton: () => [...host.querySelectorAll('button')]
      .find((b) => b.textContent.includes(STRINGS[lang].createShare)),
    async submit() {
      const btn = [...host.querySelectorAll('button')]
        .find((b) => b.textContent.includes(STRINGS[lang].createShare))
      assert.ok(btn, 'the create button must be rendered')
      await act(async () => btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    },
    text: () => host.textContent,
    async unmount() { await act(async () => root.unmount()) },
  }
}

/* ════════ UI-1 · default / capability off ════════ */

test('SHARE-SCOPE-UI-1 with the capability off only zones and any are interactive', () => {
  const html = render({ publicSelectable: false })
  const group = scopeGroup(html)
  assert.equal((group.match(/role="radio"/g) ?? []).length, 2)
  assert.match(group, />Approved networks</)
  assert.match(group, />Any network that can already reach AEGIS</)
  assert.doesNotMatch(group, /Public Internet/)

  // The read-only unavailable fact is still shown.
  assert.ok(html.includes(STRINGS.en.publicShareTitle))
  assert.ok(html.includes(STRINGS.en.publicShareUnavailable))
  assert.ok(html.includes(STRINGS.en.publicShareBody))
})

test('SHARE-SCOPE-UI-1b an unknown or failed capability fails toward unavailable', () => {
  for (const capabilities of [undefined, {}, { publicSelectable: 'true' }, { publicSelectable: 1 }]) {
    const group = scopeGroup(render(capabilities))
    assert.equal(
      (group.match(/role="radio"/g) ?? []).length,
      2,
      `capability ${JSON.stringify(capabilities)} must not enable the public scope`,
    )
    assert.doesNotMatch(group, /Public Internet/)
  }
})

/* ════════ UI-2 · capability on ════════ */

test('SHARE-SCOPE-UI-2 with the capability on exactly three scopes are offered', () => {
  const html = render({ publicSelectable: true })
  const group = scopeGroup(html)
  assert.equal((group.match(/role="radio"/g) ?? []).length, 3)
  assert.match(group, />Approved networks</)
  assert.match(group, />Any network that can already reach AEGIS</)
  assert.match(group, />Public Internet</)

  // The "not available" notice must not survive into the available state.
  assert.equal(html.includes(STRINGS.en.publicShareUnavailable), false)
})

/* ════════ UI-3 · public is not a rename of any ════════ */

test('SHARE-SCOPE-UI-3 public is a distinct value with its own explanatory copy', async () => {
  const ui = await mount({ publicSelectable: true })
  assert.equal(ui.text().includes(STRINGS.en.scopePublicBody), false, 'public copy must not show under zones')

  await ui.chooseScope(STRINGS.en.scopePublic)
  const shown = ui.text()
  assert.ok(shown.includes(STRINGS.en.scopePublicBody), 'public panel copy must appear')
  assert.equal(shown.includes(STRINGS.en.scopeAnyBody), false, 'public must not reuse the any copy')
  assert.notEqual(STRINGS.en.scopePublicBody, STRINGS.en.scopeAnyBody)

  await ui.submit()
  assert.equal(shareBackend().posts.length, 0, 'a public link needs a password before it can be created')
  await ui.unmount()
})

/* ════════ UI-4 · the saved default stays private-only ════════ */

test('SHARE-SCOPE-UI-4 public can never become a saved default scope', async () => {
  const [schema, securitySettings] = await Promise.all([
    readFile(path.join(rootDir, 'server/db/schema.sql'), 'utf8'),
    readFile(path.join(rootDir, 'server/db/migrations/007_security_settings.sql'), 'utf8'),
  ])
  assert.match(schema, /CHECK \(share_default_scope IN \('any', 'zones'\)\)/)
  assert.doesNotMatch(securitySettings, /['"]public(?:-internet)?['"]/i)

  // And the screen never writes a one-off public choice back to the account.
  const shares = await readFile(path.join(rootDir, 'src/screens/Shares.jsx'), 'utf8')
  assert.doesNotMatch(shares, /security\/settings[\s\S]{0,200}method:\s*'(?:PATCH|PUT|POST)'/i)
  assert.match(shares, /setPrivateExpiry\(defaults\.expiry\)/)
  assert.match(shares, /setPrivateAuth\(defaults\.requirePassword/)
})

/* ════════ UI-5 · public requires a link password ════════ */

test('SHARE-SCOPE-UI-5 the UI cannot submit scope=public with authType=none', async () => {
  const ui = await mount({ publicSelectable: true })

  // Start from the most permissive private state the form allows.
  await ui.choose('share-auth', 'none')
  assert.equal(ui.select('share-auth').value, 'none')

  await ui.chooseScope(STRINGS.en.scopePublic)
  assert.equal(ui.select('share-auth').value, 'password', 'public forces the password method')
  assert.equal(ui.select('share-auth').disabled, true, 'the method cannot be changed away from password')
  assert.ok(ui.text().includes(STRINGS.en.scopePublicPasswordRequired))

  // Create stays disabled until the existing 8-character backend minimum is met.
  assert.equal(ui.createButton().disabled, true)
  await ui.typePassword('short')
  assert.equal(ui.createButton().disabled, true, 'a 5-character password must not be accepted')
  await ui.typePassword('longenough1')
  assert.equal(ui.createButton().disabled, false)

  await ui.submit()
  const sent = shareBackend().posts.at(-1)
  assert.deepEqual(
    { scope: sent.scope, authType: sent.authType },
    { scope: 'public', authType: 'password' },
  )
  assert.equal(sent.password, 'longenough1')

  // Switching back restores the private choice rather than persisting the public one.
  await ui.chooseScope(STRINGS.en.scopeAny)
  assert.equal(ui.select('share-auth').value, 'none', 'the private auth choice must survive')
  assert.equal(ui.select('share-auth').disabled, false)
  await ui.unmount()
})

/* ════════ UI-6 · public starts at a short expiry ════════ */

test('SHARE-SCOPE-UI-6 public starts at 1h and the private expiry is restored', async () => {
  const ui = await mount({ publicSelectable: true })
  await ui.choose('share-expiry', '7d')
  assert.equal(ui.select('share-expiry').value, '7d')

  await ui.chooseScope(STRINGS.en.scopePublic)
  assert.equal(ui.select('share-expiry').value, '1h', 'public must default to the short expiry')

  // It is a UI default, not a server limit: the user may still choose longer.
  await ui.choose('share-expiry', '30d')
  assert.equal(ui.select('share-expiry').value, '30d')

  await ui.chooseScope(STRINGS.en.scopeZones)
  assert.equal(ui.select('share-expiry').value, '7d', 'the private expiry must be restored untouched')

  await ui.chooseScope(STRINGS.en.scopePublic)
  assert.equal(ui.select('share-expiry').value, '30d', 'the public choice is remembered for this form only')
  await ui.unmount()
})

/* ════════ UI-7 · the backend owns the public URL ════════ */

test('SHARE-SCOPE-UI-7 the public confirmation shows URL, scope, password state and server expiry', async () => {
  resetShareBackend({
    createResponse: {
      ok: true,
      status: 201,
      data: {
        share: {
          id: 's2', fileName: 'q4-report.pdf', hasPassword: true, scopeCidrs: [],
          expiresAt: PUBLIC_EXPIRES_AT,
        },
        path: '/s/PublicToken456',
        publicUrl: 'https://share.example.invalid/s/PublicToken456',
      },
    },
  })
  const ui = await mount({ publicSelectable: true })
  await ui.chooseScope(STRINGS.en.scopePublic)
  await ui.typePassword('longenough1')
  await ui.submit()

  const shown = ui.text()
  // 1. the exact backend publicUrl — never the browser origin or the bare path
  assert.ok(shown.includes('https://share.example.invalid/s/PublicToken456'), 'the exact publicUrl must be shown')
  assert.equal(shown.includes('http://localhost/s/PublicToken456'), false)
  // 2. Public Internet scope
  assert.ok(shown.includes(STRINGS.en.shareLinkPublicNote), 'the public scope must be named')
  // 3. password-protected state
  assert.ok(shown.includes(STRINGS.en.shareLinkPasswordNote), 'the password-protected state must be shown')
  // 4. expiry, derived from the STORED value (now + 3h), not from any form option
  assert.ok(shown.includes(STRINGS.en.colExpiresIn), 'the expiry must be labelled')
  assert.ok(shown.includes('3h 00m'), `expiry countdown missing from: ${shown}`)
  // 5. one-time-copy warning
  assert.ok(shown.includes(STRINGS.en.shareLinkOnceWarn), 'the one-time-copy warning must be shown')
  // and never the plaintext password
  assert.equal(shown.includes('longenough1'), false, 'the plaintext password must never be echoed')
  await ui.unmount()
})

test('SHARE-SCOPE-UI-7b zones and any keep composing the internal URL from the origin', async () => {
  for (const scopeLabel of [STRINGS.en.scopeZones, STRINGS.en.scopeAny]) {
    resetShareBackend()
    const ui = await mount({ publicSelectable: true })
    await ui.chooseScope(scopeLabel)
    await ui.typePassword('longenough1')
    await ui.submit()
    const shown = ui.text()
    assert.ok(
      shown.includes('http://localhost/s/PrivateToken123'),
      `${scopeLabel} must keep the existing origin+path behaviour`,
    )
    // The stored expiry (now + 2d 5h) is shown for private links too.
    assert.ok(shown.includes(STRINGS.en.colExpiresIn), `${scopeLabel} expiry label`)
    assert.ok(shown.includes('2d 5h'), `${scopeLabel} expiry countdown missing from: ${shown}`)
    assert.equal(shown.includes(STRINGS.en.shareLinkPublicNote), false, `${scopeLabel} must not claim public scope`)
    await ui.unmount()
  }
})

test('SHARE-SCOPE-UI-7d the shown expiry is the stored one and the form cannot change it', async () => {
  resetShareBackend({
    createResponse: {
      ok: true,
      status: 201,
      data: {
        share: {
          id: 's4', fileName: 'q4-report.pdf', hasPassword: true, scopeCidrs: [],
          expiresAt: PUBLIC_EXPIRES_AT,
        },
        path: '/s/PublicToken999',
        publicUrl: 'https://share.example.invalid/s/PublicToken999',
      },
    },
  })
  const ui = await mount({ publicSelectable: true })
  await ui.chooseScope(STRINGS.en.scopePublic)
  // The form says 1h; the server says 3h. The confirmation must believe the server.
  assert.equal(ui.select('share-expiry').value, '1h')
  await ui.typePassword('longenough1')
  await ui.submit()
  assert.ok(ui.text().includes('3h 00m'), 'the confirmation must use the stored expiry, not the form selection')

  // The link is already issued and immutable. Editing the form afterwards must
  // not rewrite what the confirmation claims about it.
  await ui.choose('share-expiry', '30d')
  assert.equal(ui.select('share-expiry').value, '30d', 'the form itself still moves')
  const shown = ui.text()
  assert.ok(shown.includes('3h 00m'), 'the issued link keeps the expiry the server stored')
  assert.equal(shown.includes('30d 0h'), false, 'the form value must not leak into the confirmation')

  // Switching scope afterwards must not rewrite it either.
  await ui.chooseScope(STRINGS.en.scopeZones)
  assert.ok(ui.text().includes('3h 00m'), 'the issued link is unaffected by later scope changes')
  await ui.unmount()
})

test('SHARE-SCOPE-UI-7e the confirmation expiry is read from the response, not recomputed', async () => {
  const screen = await readFile(path.join(rootDir, 'src/screens/Shares.jsx'), 'utf8')
  // Both branches take the stored value straight from the response.
  assert.equal((screen.match(/expiresAt: res\.data\.share\.expiresAt/g) ?? []).length, 2)
  // And the confirmation renders that field, not the form state.
  assert.match(screen, /created\.expiresAt/)
  assert.doesNotMatch(screen, /created[\s\S]{0,80}EXPIRY_MS\[/, 'the confirmation must not recompute a duration')
  assert.doesNotMatch(screen, /expiresAt:\s*Date\.now\(\)/, 'the client clock must not author the stored expiry')
  assert.doesNotMatch(screen, /expiresAt:\s*(?:publicExpiry|privateExpiry|expiry)/)
})

test('SHARE-SCOPE-UI-7c a public response without publicUrl fails closed', async () => {
  for (const publicUrl of [undefined, '', null]) {
    resetShareBackend({
      createResponse: {
        ok: true,
        status: 201,
        data: {
          share: { id: 's3', fileName: 'q4-report.pdf', hasPassword: true, scopeCidrs: [] },
          path: '/s/PublicToken789',
          ...(publicUrl === undefined ? {} : { publicUrl }),
        },
      },
    })
    const ui = await mount({ publicSelectable: true })
    await ui.chooseScope(STRINGS.en.scopePublic)
    await ui.typePassword('longenough1')
    await ui.submit()

    const shown = ui.text()
    assert.ok(shown.includes(STRINGS.en.publicUrlMissing), `publicUrl=${publicUrl} must show the failure`)
    // No link of any kind, and above all not the internal path dressed as public.
    assert.equal(shown.includes('/s/PublicToken789'), false, 'no link may be shown at all')
    assert.equal(shown.includes(STRINGS.en.shareLinkReady), false)
    await ui.unmount()
  }
})

/* ════════ UI-8 · EN/TH/ZH parity ════════ */

test('SHARE-SCOPE-UI-8 both states are fully localized in every language', () => {
  const keys = [
    'scopePublic', 'scopePublicTitle', 'scopePublicBody', 'scopePublicPasswordRequired',
    'chipPublicInternet', 'publicUrlMissing', 'shareLinkPublicNote',
    'publicShareTitle', 'publicShareUnavailable', 'publicShareBody',
  ]
  for (const lang of LANGS) {
    for (const key of keys) {
      const value = STRINGS[lang][key]
      assert.equal(typeof value, 'string', `${lang}.${key} must exist`)
      assert.ok(value.trim().length > 0, `${lang}.${key} must not be empty`)
    }
    // Unavailable state renders its localized copy.
    const off = render({ publicSelectable: false }, { lang })
    assert.ok(off.includes(STRINGS[lang].publicShareTitle), `${lang} unavailable title`)
    assert.ok(off.includes(STRINGS[lang].publicShareUnavailable), `${lang} unavailable state`)
    assert.ok(off.includes(STRINGS[lang].publicShareBody), `${lang} unavailable explanation`)

    // Enabled state renders the localized third option.
    const on = scopeGroup(render({ publicSelectable: true }, { lang }), lang)
    assert.ok(on.includes(STRINGS[lang].scopePublic), `${lang} public option label`)
  }
})

test('SHARE-SCOPE-UI-8b the risk copy is localized, distinct, and free of rollout jargon', async () => {
  for (const lang of LANGS) {
    const ui = await mount({ publicSelectable: true }, { lang })
    await ui.chooseScope(STRINGS[lang].scopePublic)
    const shown = ui.text()
    assert.ok(shown.includes(STRINGS[lang].scopePublicBody), `${lang} risk copy`)
    assert.ok(shown.includes(STRINGS[lang].scopePublicPasswordRequired), `${lang} password rule`)
    await ui.unmount()
  }
  // No rollout jargon or internal process wording leaks into user-facing copy.
  for (const lang of LANGS) {
    const copy = [
      STRINGS[lang].scopePublicBody, STRINGS[lang].scopePublicTitle,
      STRINGS[lang].publicShareBody, STRINGS[lang].publicUrlMissing,
      STRINGS[lang].shareLinkPublicNote, STRINGS[lang].scopePublicPasswordRequired,
    ].join(' ')
    assert.doesNotMatch(copy, /PUBLIC-SHARE-\d|PR\s?#\d|\bG[1-7]\b/i, `${lang} must not leak rollout jargon`)
  }
})

/* ════════ UI-9 · the active-links table ════════ */

test('SHARE-SCOPE-UI-9 a public row shows the public chip, never the Any fallback', () => {
  const at = Date.UTC(2026, 7, 8)
  const rows = [
    { id: 'a', fileName: 'pub.pdf', createdBy: 'admin', scope: 'public', authType: 'password', expiresAt: at, hits: 0 },
    { id: 'b', fileName: 'any.pdf', createdBy: 'admin', scope: 'any', authType: 'password', expiresAt: at, hits: 0 },
    { id: 'c', fileName: 'zon.pdf', createdBy: 'admin', scope: 'zones', authType: 'password', expiresAt: at, hits: 0 },
    { id: 'd', fileName: 'vln.pdf', createdBy: 'admin', scope: 'vlan', authType: 'password', expiresAt: at, hits: 0 },
    { id: 'e', fileName: 'sub.pdf', createdBy: 'admin', scope: 'subnet', authType: 'password', expiresAt: at, hits: 0 },
  ]
  const html = render({ publicSelectable: false }, { shares: rows })
  assert.ok(html.includes(STRINGS.en.chipPublicInternet), 'the public chip must render')
  // The legacy scopes keep their own chips.
  for (const key of ['chipAnyNetwork', 'chipZoneRestricted', 'chipVlanOnly', 'chipSubnet']) {
    assert.ok(html.includes(STRINGS.en[key]), `${key} must still render`)
  }
  // Exactly one row carries the Any chip — the public row must not inherit it.
  assert.equal(html.split(`>${STRINGS.en.chipAnyNetwork}<`).length - 1, 1)
})

test('SHARE-SCOPE-UI-9b the scope filter can select public rows', () => {
  const html = render({ publicSelectable: false })
  const select = html.split(/<select\b/).find((chunk) => chunk.includes(`aria-label="${STRINGS.en.filterScope}"`))
  assert.ok(select, 'the scope filter must be rendered')
  const options = [...select.split('</select>')[0].matchAll(/<option value="([^"]*)"/g)].map(([, v]) => v)
  assert.deepEqual(options, ['all', 'zones', 'any', 'public'])
})

/* ════════ UI-10 · mobile layout ════════ */

test('SHARE-SCOPE-UI-10 three long localized labels stack without clipping on mobile', async () => {
  const [screen, css] = await Promise.all([
    readFile(path.join(rootDir, 'src/screens/Shares.jsx'), 'utf8'),
    readFile(path.join(rootDir, 'src/index.css'), 'utf8'),
  ])
  assert.match(screen, /className="share-scope-segmented"/)
  // Single column under 640px, so a third option adds a row rather than shrinking one.
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.share-scope-segmented[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(css, /\.share-scope-segmented \.ui-segmented-option[\s\S]*white-space:\s*normal/)
  assert.match(css, /\.share-scope-segmented \.ui-segmented-option[\s\S]*min-height:\s*44px/)

  // Every localized label must survive wrapping rather than being truncated.
  assert.doesNotMatch(css, /\.share-scope-segmented[\s\S]{0,400}text-overflow:\s*ellipsis/)
  for (const lang of LANGS) {
    const group = scopeGroup(render({ publicSelectable: true }, { lang }), lang)
    for (const key of ['scopeZones', 'scopeAny', 'scopePublic']) {
      assert.ok(group.includes(STRINGS[lang][key]), `${lang}.${key} must render in full`)
    }
  }
})

/* ════════ Source-level guards that must not regress ════════ */

test('SHARE-SCOPE-API-1 the public scope is offered only from the server capability', async () => {
  const screen = await readFile(path.join(rootDir, 'src/screens/Shares.jsx'), 'utf8')

  // The option is constructed from the server-owned capability, strictly.
  assert.match(screen, /capabilities\?\.publicSelectable === true/)
  assert.match(screen, /publicSelectable \? \[\{ value: 'public'/)

  // None of the forbidden activation sources may decide it.
  assert.doesNotMatch(screen, /import\.meta\.env/, 'a build-time flag must not gate the scope')
  // The only executable use of the browser location is the private origin
  // composition. (Prose mentions of it in comments are counted out by requiring
  // the `.origin` member access the code actually performs.)
  assert.equal((screen.match(/window\.location\.origin/g) ?? []).length, 1)
  assert.doesNotMatch(screen, /window\.location\.host\b/)

  // The public URL comes from the response and is never derived.
  assert.match(screen, /const publicUrl = res\.data\.publicUrl/)
  assert.match(screen, /url: publicUrl,/)
})

test('SHARE-SCOPE-API-2 the backend contract and default-off deployment state are unchanged', async () => {
  const [store, schema, migration009, envExample, config] = await Promise.all([
    readFile(path.join(rootDir, 'server/db/store.js'), 'utf8'),
    readFile(path.join(rootDir, 'server/db/schema.sql'), 'utf8'),
    readFile(path.join(rootDir, 'server/db/migrations/009_public_share_scope.sql'), 'utf8'),
    readFile(path.join(rootDir, '.env.example'), 'utf8'),
    readFile(path.join(rootDir, 'server/config/publicShare.js'), 'utf8'),
  ])

  assert.match(store, /const SCOPES = new Set\(\['any', 'zones', 'public'\]\)/)
  assert.match(schema, /CHECK \(scope IN \('any', 'zones', 'public', 'vlan', 'subnet'\)\)/)
  assert.match(migration009, /'public'/)

  // Both deployment switches ship commented out, so a copied .env stays private.
  assert.match(envExample, /^#\s*PUBLIC_SHARE_GATEWAY_CIDR=/m)
  assert.doesNotMatch(envExample, /^PUBLIC_SHARE_GATEWAY_CIDR=/m)
  assert.match(envExample, /^#\s*PUBLIC_SHARE_UI_ENABLED=false$/m)
  assert.doesNotMatch(envExample, /^PUBLIC_SHARE_UI_ENABLED=/m)
  assert.match(envExample, /Do not enable before G6 \/ PUBLIC-SHARE-7 acceptance/)

  // All three conditions are required, and the flag is not a truthy coercion.
  assert.match(config, /publicSelectable: baseUrl !== null && gatewayCidr !== null && uiEnabled/)
  assert.match(config, /must be exactly "true" or "false"/)
})
