import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
let vite
let Shares

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
  ;({ Shares } = await vite.ssrLoadModule('/src/screens/Shares.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.__AEGIS_API_FIXTURES__
})

function render(lang) {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/files': { loading: false, data: { files: [] }, error: null },
    '/api/shares': { loading: false, data: { shares: [] }, error: null },
    '/api/security/settings': { loading: false, data: null, error: null },
  }
  return renderToStaticMarkup(React.createElement(Shares, { t: makeT(lang) }))
}

test('SHARE-SCOPE-UI-1 only zones and any are interactive network scopes', () => {
  const html = render('en')
  const scopeGroup = html.match(/<div role="radiogroup" aria-label="NETWORK SCOPE"[\s\S]*?<\/div>/)?.[0] ?? ''
  assert.equal((scopeGroup.match(/role="radio"/g) ?? []).length, 2)
  assert.match(scopeGroup, />Approved networks</)
  assert.match(scopeGroup, />Any network that can already reach AEGIS</)
  assert.doesNotMatch(scopeGroup, /Public Internet|value="public"/i)
})

test('SHARE-SCOPE-UI-2 public Internet is a read-only unavailable fact in every language', () => {
  for (const lang of LANGS) {
    const html = render(lang)
    assert.ok(html.includes(STRINGS[lang].publicShareTitle), `${lang} title`)
    assert.ok(html.includes(STRINGS[lang].publicShareUnavailable), `${lang} unavailable state`)
    assert.ok(html.includes(STRINGS[lang].publicShareBody), `${lang} explanation`)
    assert.doesNotMatch(html, /value="public(?:-internet)?"/i)
  }
})

test('SHARE-SCOPE-UI-3 any states the pre-existing route and no extra Share CIDR rule', () => {
  const expectations = {
    en: ['already reach AEGIS', 'No additional CIDR restriction'],
    th: ['มีเส้นทางเข้าถึง AEGIS อยู่แล้ว', 'ไม่จำกัด CIDR เพิ่มที่ชั้น Share'],
    zh: ['已经可以访问 AEGIS', '共享层不会额外施加 CIDR 限制'],
  }
  for (const lang of LANGS) {
    const copy = `${STRINGS[lang].scopeAny} ${STRINGS[lang].scopeAnyBody}`
    assert.ok(copy.includes(expectations[lang][0]), `${lang} reachability wording`)
    assert.ok(copy.includes(expectations[lang][1]), `${lang} Share CIDR wording`)
  }
})

test('SHARE-SCOPE-API-1 server and persisted defaults still reject a public scope contract', async () => {
  const [store, schema, migration] = await Promise.all([
    readFile(path.join(rootDir, 'server/db/store.js'), 'utf8'),
    readFile(path.join(rootDir, 'server/db/schema.sql'), 'utf8'),
    readFile(path.join(rootDir, 'server/db/migrations/007_security_settings.sql'), 'utf8'),
  ])
  assert.match(store, /const SCOPES = new Set\(\['any', 'zones'\]\)/)
  assert.doesNotMatch(`${store}\n${schema}\n${migration}`, /['"]public(?:-internet)?['"]/i)
})

test('SHARE-SCOPE-UI-4 long localized scope labels stack without clipping on mobile', async () => {
  const [screen, css] = await Promise.all([
    readFile(path.join(rootDir, 'src/screens/Shares.jsx'), 'utf8'),
    readFile(path.join(rootDir, 'src/index.css'), 'utf8'),
  ])
  assert.match(screen, /className="share-scope-segmented"/)
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.share-scope-segmented[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(css, /\.share-scope-segmented \.ui-segmented-option[\s\S]*white-space:\s*normal/)
})
