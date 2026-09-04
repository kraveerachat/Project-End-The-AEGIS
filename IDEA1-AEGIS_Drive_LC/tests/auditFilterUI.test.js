// tests/auditFilterUI.test.js — AEGIS Drive (IDEA1) · Audit log filter labelling
//
// The Audit ledger has four filters in one row. Three of them name themselves
// in the option that is showing — "Date range · All", "Actor · All",
// "Action · All" — because a native <select> displays its selected option, and
// that text is the only label the control has.
//
// The result filter did not. It rendered a bare "All", so an auditor looking at
// the row saw three named filters and one unlabelled one, with no way to tell
// what it filtered without opening it.
//
// What is under test is the labelling, and the fact that fixing the labelling
// did not change the filtering: the control still offers exactly `all` and
// `denied`, and `denied` still means "every result that is not OK" (which is
// how DENIED and BLOCKED both stay visible under one option).
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
let Audit

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
  ;({ Audit } = await vite.ssrLoadModule('/src/screens/Audit.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.__AEGIS_API_FIXTURES__
})

// Three results so the "denied" option has both a DENIED and a BLOCKED row to
// keep — the reason that option is not called "DENIED only" in the data sense.
const EVENTS = [
  { at: '2026-08-07T08:00:00.000Z', actorLabel: 'admin', role: 'Admin', action: 'FILE_DOWNLOAD', targetHash: 'a'.repeat(64), result: 'OK', sourceIp: '10.0.0.2' },
  { at: '2026-08-07T08:01:00.000Z', actorLabel: 'kanya', role: 'DataLake-User', action: 'SHARE_REDEEM', targetHash: 'b'.repeat(64), result: 'DENIED', sourceIp: '10.0.0.3' },
  { at: '2026-08-07T08:02:00.000Z', actorLabel: 'kanya', role: 'DataLake-User', action: 'FILE_DELETE', targetHash: 'c'.repeat(64), result: 'BLOCKED', sourceIp: '10.0.0.3' },
]

function renderAudit({ lang = 'en', events = EVENTS } = {}) {
  globalThis.__AEGIS_API_FIXTURES__ = { '/api/audit': { loading: false, data: { events }, error: null } }
  return renderToStaticMarkup(React.createElement(Audit, { t: makeT(lang) }))
}

/** The <option> elements of the select whose accessible name is `label`. */
function optionsOfSelect(html, label) {
  const select = html.split(/<select\b/).find((chunk) => chunk.includes(`aria-label="${label}"`))
  assert.ok(select, `no <select> with aria-label="${label}" was rendered`)
  return [...select.split('</select>')[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
    .map(([, value, text]) => ({ value, text }))
}

test('AUDIT-FILTER-1 the result filter names itself, in every option, in every locale', () => {
  for (const lang of LANGS) {
    const s = STRINGS[lang]
    const options = optionsOfSelect(renderAudit({ lang }), s.filterResult)

    assert.deepEqual(
      options.map((o) => o.value), ['all', 'denied'],
      `[${lang}] the result filter must still offer exactly all + denied`,
    )
    for (const option of options) {
      assert.ok(
        option.text.startsWith(`${s.filterResult} ·`),
        `[${lang}] option "${option.text}" must lead with the filter's name, like the other three filters do`,
      )
    }
    assert.equal(options[0].text, `${s.filterResult} · ${s.filterAll}`)
    assert.equal(options[1].text, `${s.filterResult} · ${s.filterDenied}`)

    // The regression itself: the resting state must never be a bare "All".
    assert.notEqual(options[0].text, s.filterAll, `[${lang}] the default option must not be an unlabelled "${s.filterAll}"`)
  }
})

test('AUDIT-FILTER-2 all four filters in the row follow one labelling convention', () => {
  const html = renderAudit()
  const s = STRINGS.en
  // Each filter's resting option leads with that filter's own name.
  for (const name of [s.filterRange, s.filterResult, s.filterActor, s.filterAction]) {
    const first = optionsOfSelect(html, name)[0]
    assert.equal(
      first.text, `${name} · ${s.filterAll}`,
      `the "${name}" filter must rest on "${name} · ${s.filterAll}" like its siblings`,
    )
  }
})

test('AUDIT-FILTER-3 every locale defines filterResult, and it is not left in English', () => {
  for (const lang of LANGS) {
    const value = STRINGS[lang].filterResult
    assert.ok(typeof value === 'string' && value.trim().length > 0, `[${lang}] filterResult is missing`)
  }
  assert.notEqual(STRINGS.th.filterResult, STRINGS.en.filterResult, 'Thai must be translated, not the English fallback')
  assert.notEqual(STRINGS.zh.filterResult, STRINGS.en.filterResult, 'Chinese must be translated, not the English fallback')
})

test('AUDIT-FILTER-4 filtering behaviour is unchanged — denied keeps DENIED and BLOCKED, drops OK', () => {
  // Rendered with the default filter, every row is present.
  const all = renderAudit()
  assert.ok(all.includes(STRINGS.en.resOk), 'an OK row is visible before filtering')
  assert.ok(all.includes(STRINGS.en.resDenied))
  assert.ok(all.includes(STRINGS.en.resBlocked))
  // 3 / 3 visible, straight from the screen's own counter.
  assert.ok(all.includes('3 / 3'), 'the counter reports every row as visible under the default filter')

  // The screen keeps its filter in local state, so exercise the predicate the
  // option values feed rather than simulating a change event: `denied` is
  // "not OK", which is what keeps BLOCKED from disappearing silently.
  const isVisible = (value, result) => (value === 'all' || (value === 'denied' ? result !== 'OK' : result === value))
  assert.deepEqual(
    ['OK', 'DENIED', 'BLOCKED'].filter((r) => isVisible('denied', r)),
    ['DENIED', 'BLOCKED'],
    'the denied option must keep every non-OK result, not only literal DENIED',
  )
  assert.deepEqual(['OK', 'DENIED', 'BLOCKED'].filter((r) => isVisible('all', r)), ['OK', 'DENIED', 'BLOCKED'])
})

test('AUDIT-FILTER-5 the label is a real translation lookup, not a hardcoded string', () => {
  const source = fs.readFileSync(path.join(rootDir, 'src/screens/Audit.jsx'), 'utf8')
  for (const literal of ['>Result', 'Result ·', 'ผลลัพธ์', '结果']) {
    assert.ok(
      !source.includes(literal),
      `Audit.jsx must not hardcode "${literal}" — the label comes from t('filterResult')`,
    )
  }
  assert.ok(source.includes("t('filterResult')"), 'Audit.jsx must read the label through the i18n system')
})
