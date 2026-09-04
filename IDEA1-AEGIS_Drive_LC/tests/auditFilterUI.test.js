// tests/auditFilterUI.test.js — AEGIS Drive (IDEA1) · Audit log result filter
//
// The Audit ledger has four filters in one row, and each names itself in the
// option that is showing — "Date range · All", "Result · All", "Actor · All",
// "Action · All" — because a native <select> displays its selected option, and
// that text is the only label the control has.
//
// The result filter used to offer two options, `all` and `denied`, where
// `denied` meant "every result that is not OK". The ledger stores three
// results, so that one option collapsed DENIED and BLOCKED together and left
// no way at all to ask for the successful events. It now offers the real
// result domain, one option per stored value.
//
// What is under test: the four options exist and are labelled in every locale,
// each one selects exactly its own stored result *in the real component*
// (driven through the actual <select>, not through a copy of the predicate),
// and none of the surrounding contracts — CSV export, RBAC, the stored result
// values — moved.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))

let dom
let createRoot
let vite
let Audit

before(async () => {
  // react-dom captures `canUseDOM` at import time and falls back to a legacy
  // change-event path when it is false, which silently swallows simulated
  // input. The jsdom globals therefore have to exist before it is loaded.
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
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ Audit } = await vite.ssrLoadModule('/src/screens/Audit.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  delete globalThis.__AEGIS_API_FIXTURES__
  dom?.window.close()
})

// One event per stored result, each with its own action name so a row can be
// identified without matching on the result word itself.
const EVENTS = [
  { at: '2026-08-07T08:00:00.000Z', actorLabel: 'admin', role: 'Admin', action: 'FILE_DOWNLOAD', targetHash: 'a'.repeat(64), result: 'OK', sourceIp: '10.0.0.2' },
  { at: '2026-08-07T08:01:00.000Z', actorLabel: 'kanya', role: 'DataLake-User', action: 'SHARE_REDEEM', targetHash: 'b'.repeat(64), result: 'DENIED', sourceIp: '10.0.0.3' },
  { at: '2026-08-07T08:02:00.000Z', actorLabel: 'kanya', role: 'DataLake-User', action: 'FILE_DELETE', targetHash: 'c'.repeat(64), result: 'BLOCKED', sourceIp: '10.0.0.3' },
]
const ACTION_OF = { OK: 'FILE_DOWNLOAD', DENIED: 'SHARE_REDEEM', BLOCKED: 'FILE_DELETE' }

function setFixture(events = EVENTS) {
  globalThis.__AEGIS_API_FIXTURES__ = { '/api/audit': { loading: false, data: { events }, error: null } }
}

function renderAudit({ lang = 'en', events = EVENTS } = {}) {
  setFixture(events)
  return renderToStaticMarkup(React.createElement(Audit, { t: makeT(lang) }))
}

/** The <option> elements of the select whose accessible name is `label`. */
function optionsOfSelect(html, label) {
  const select = html.split(/<select\b/).find((chunk) => chunk.includes(`aria-label="${label}"`))
  assert.ok(select, `no <select> with aria-label="${label}" was rendered`)
  return [...select.split('</select>')[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
    .map(([, value, text]) => ({ value, text }))
}

/* ── harness — the real screen, driven through its real control ───── */

async function mountAudit(lang = 'en') {
  setFixture()
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(Audit, { t: makeT(lang) })))

  const select = host.querySelector(`select[aria-label="${STRINGS[lang].filterResult}"]`)
  assert.ok(select, 'the result filter must be rendered as a real <select>')

  return {
    host,
    select,
    /** Choose a filter option the way a user does: set the value, fire change. */
    async choose(value) {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
      await act(async () => {
        setter.call(select, value)
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
    },
    /**
     * The actions of the rows the screen is actually showing. A filtered-out
     * row stays mounted but collapses to `max-height: 0`, which is what the
     * user sees, so that — not mere presence in the DOM — is what is read.
     */
    visibleActions() {
      return [...host.querySelectorAll('div[style*="max-height"]')]
        .filter((row) => row.style.maxHeight !== '0px' && row.style.opacity !== '0')
        .map((row) => Object.values(ACTION_OF).find((action) => row.textContent.includes(action)))
        .filter(Boolean)
    },
    async unmount() { await act(async () => root.unmount()); host.remove() },
  }
}

/* ── the option domain ────────────────────────────────────────────── */

test('AUDIT-FILTER-1 the result filter offers the real result domain, named, in every locale', () => {
  for (const lang of LANGS) {
    const s = STRINGS[lang]
    const options = optionsOfSelect(renderAudit({ lang }), s.filterResult)

    assert.deepEqual(
      options.map((o) => o.value), ['all', 'OK', 'DENIED', 'BLOCKED'],
      `[${lang}] the result filter must offer All + the three stored results`,
    )
    for (const option of options) {
      assert.ok(
        option.text.startsWith(`${s.filterResult} ·`),
        `[${lang}] option "${option.text}" must lead with the filter's name, like the other three filters do`,
      )
    }
    assert.equal(options[0].text, `${s.filterResult} · ${s.filterAll}`)
    assert.equal(options[1].text, `${s.filterResult} · ${s.filterSuccess}`)
    assert.equal(options[2].text, `${s.filterResult} · ${s.filterDenied}`)
    assert.equal(options[3].text, `${s.filterResult} · ${s.filterBlocked}`)

    // The original regression: the resting state must never be a bare "All".
    assert.notEqual(options[0].text, s.filterAll, `[${lang}] the default option must not be an unlabelled "${s.filterAll}"`)
  }
})

test('AUDIT-FILTER-2 all four filters in the row follow one labelling convention', () => {
  const html = renderAudit()
  const s = STRINGS.en
  for (const name of [s.filterRange, s.filterResult, s.filterActor, s.filterAction]) {
    const first = optionsOfSelect(html, name)[0]
    assert.equal(
      first.text, `${name} · ${s.filterAll}`,
      `the "${name}" filter must rest on "${name} · ${s.filterAll}" like its siblings`,
    )
  }
})

test('AUDIT-FILTER-3 every locale translates all four result options', () => {
  for (const key of ['filterResult', 'filterAll', 'filterSuccess', 'filterDenied', 'filterBlocked']) {
    for (const lang of LANGS) {
      const value = STRINGS[lang][key]
      assert.ok(typeof value === 'string' && value.trim().length > 0, `[${lang}] ${key} is missing`)
    }
    for (const lang of ['th', 'zh']) {
      assert.notEqual(STRINGS[lang][key], STRINGS.en[key], `[${lang}] ${key} must be translated, not the English fallback`)
    }
  }
  // The four option words stay distinct, or two options would read alike.
  for (const lang of LANGS) {
    const s = STRINGS[lang]
    assert.equal(
      new Set([s.filterAll, s.filterSuccess, s.filterDenied, s.filterBlocked]).size, 4,
      `[${lang}] the four result options must read differently from one another`,
    )
  }
})

/* ── the filtering itself, through the real control ───────────────── */

test('AUDIT-FILTER-4 each option selects exactly its own stored result', async () => {
  const screen = await mountAudit()
  try {
    // All — every stored result is visible.
    assert.deepEqual(screen.visibleActions().sort(), ['FILE_DELETE', 'FILE_DOWNLOAD', 'SHARE_REDEEM'])
    assert.ok(screen.host.textContent.includes('3 / 3'), 'the counter reports every row as visible under All')

    for (const [result, action] of Object.entries(ACTION_OF)) {
      await screen.choose(result)
      assert.deepEqual(
        screen.visibleActions(), [action],
        `"${result}" must show exactly the ${result} row and nothing else`,
      )
      assert.ok(screen.host.textContent.includes('1 / 3'), `"${result}" must report 1 of 3 rows visible`)
    }

    // Back to All — the filter is a view, it never drops events.
    await screen.choose('all')
    assert.equal(screen.visibleActions().length, 3, 'returning to All restores every row')
  } finally {
    await screen.unmount()
  }
})

test('AUDIT-FILTER-5 Denied and Blocked are no longer collapsed into one option', async () => {
  const screen = await mountAudit()
  try {
    await screen.choose('DENIED')
    assert.ok(!screen.visibleActions().includes(ACTION_OF.BLOCKED), 'Denied must not keep BLOCKED rows')
    await screen.choose('BLOCKED')
    assert.ok(!screen.visibleActions().includes(ACTION_OF.DENIED), 'Blocked must not keep DENIED rows')
  } finally {
    await screen.unmount()
  }
})

/* ── contracts that must not have moved ───────────────────────────── */

test('AUDIT-FILTER-6 the labels are translation lookups, not hardcoded strings', () => {
  const source = fs.readFileSync(path.join(rootDir, 'src/screens/Audit.jsx'), 'utf8')

  // The rendered text of every result option, in the two locales whose script
  // cannot collide with an identifier. (Matching English words would flag the
  // i18n *keys* themselves — `filterSuccess` contains "Success".)
  for (const lang of ['th', 'zh']) {
    // filterAll is excluded on purpose: Thai "ทั้งหมด" is ordinary prose and
    // occurs inside the file's existing comments, so it cannot discriminate.
    for (const key of ['filterResult', 'filterSuccess', 'filterDenied', 'filterBlocked']) {
      const literal = STRINGS[lang][key]
      assert.ok(
        !source.includes(literal),
        `Audit.jsx must not hardcode "${literal}" (${lang}.${key}) — every label comes from the i18n system`,
      )
    }
  }
  // ...and the English tell: a rendered "Result ·" prefix written by hand.
  assert.ok(!source.includes('>Result'), 'Audit.jsx must not hardcode the English filter name')
  assert.ok(source.includes("t('filterResult')"), 'Audit.jsx must read the filter name through the i18n system')
  for (const key of ['filterAll', 'filterSuccess', 'filterDenied', 'filterBlocked']) {
    assert.ok(source.includes(`'${key}'`), `Audit.jsx must offer the ${key} option`)
  }
})

test('AUDIT-FILTER-7 the stored result values and the CSV contract are untouched', () => {
  const source = fs.readFileSync(path.join(rootDir, 'src/screens/Audit.jsx'), 'utf8')

  // The option values ARE the stored results; nothing renames or re-buckets them.
  assert.match(source, /\{ value: 'OK', label: 'filterSuccess' \}/)
  assert.match(source, /\{ value: 'DENIED', label: 'filterDenied' \}/)
  assert.match(source, /\{ value: 'BLOCKED', label: 'filterBlocked' \}/)
  // The coarse bucket is gone from the *predicate*. `e.result !== 'OK'` still
  // exists a few lines down as the row's danger tone, which is correct for
  // DENIED and BLOCKED alike and is not a filtering decision.
  assert.ok(!source.includes("result === 'denied'"), 'the coarse "not OK" bucket must be gone from the filter')
  assert.match(
    source, /\(result === 'all' \|\| e\.result === result\)/,
    'the predicate must compare the selected option against the stored result exactly',
  )

  // CSV exports the whole ledger, unfiltered, with the same header and columns.
  assert.match(source, /const head = 'timestamp,actor,role,action,target_sha256,result,source_ip'/)
  assert.match(source, /const rows = events\.map\(/, 'CSV must still export every event, not the filtered view')
  assert.match(source, /a\.download = 'aegis-audit-log\.csv'/)
})

test('AUDIT-FILTER-8 the audit endpoint is still Admin-only on the server', () => {
  const routes = fs.readFileSync(path.join(rootDir, 'server/routes/api.js'), 'utf8')
  assert.match(
    routes, /apiRouter\.get\('\/audit', requireRole\(ROLES\.ADMIN\)/,
    'GET /api/audit must remain behind requireRole(ROLES.ADMIN)',
  )
})
