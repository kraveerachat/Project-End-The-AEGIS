// tests/storageCapacityRingUi.test.js — AEGIS Drive (IDEA1) · the Capacity ring
//
// The ring is a picture; the legend is the record. Every assertion here exists
// because the opposite would mislead somebody reading their own disk:
//   - free and unaccounted used space being collapsed into one value;
//   - a 4 MB category inflated with a minimum angle or demoted to a thin tick;
//   - a real share rounded down to 0.0% until it reads as nothing;
//   - a ring drawn around a denominator the filesystem never reported.
// Nothing here checks pixels. It checks which of the numbers on screen are
// allowed to be approximate, and which are not.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'
import { fmtBytes } from '../src/lib/format.js'

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

const unavailableDisk = { available: false, status: 'UNKNOWN', reason: 'agent-unreachable', stale: false, device: null, model: null, smart: null, temperatureCelsius: null, powerOnHours: null, capacityBytes: null, warnings: [], measuredAt: null, ageSeconds: null, maxAgeSeconds: 1800 }
const unavailableBackup = { available: false, reason: 'agent-unreachable', engine: null, state: 'UNKNOWN', target: null, policy: null, job: null, nextRun: null, lastSuccessfulBackup: null, lastFailedBackup: null, backupAgeSeconds: null, maxBackupAgeSeconds: null, bytesCovered: null, lastSnapshotId: null, integrity: 'NOT_RUN', restoreVerification: { at: null, status: 'NOT_TESTED' }, successRate30d: null, completedJobs30d: 0, risk: 'UNKNOWN', riskReasons: ['agent-unreachable'] }
const raid = { available: false, status: 'NOT_CONFIGURED', reason: 'no-array-configured' }

// A 476.8 GB volume with 149.0 GB used. Archives is 4 MB — 0.0008% of the volume,
// far below what a 427 px circumference can draw. The geometry remains exact,
// and the legend is therefore responsible for keeping the category readable.
const rich = {
  capacityBytes: { totalBytes: 512_000_000_000, usedBytes: 160_000_000_000, freeBytes: 352_000_000_000 },
  usage: { docs: 40_000_000_000, archives: 4_000_000, media: 90_000_000_000, other: 1_000_000_000, vaultSeg: 6_000_000_000, versions: 3_000_000_000 },
  unaccountedBytes: 19_996_000_000,
}
// Every category empty, all used bytes unaccounted for: nothing is sub-visible here.
const sparse = {
  capacityBytes: { totalBytes: 61_075_263_488, usedBytes: 18_300_000_000, freeBytes: 42_775_263_488 },
  usage: { docs: 0, archives: 0, media: 0, other: 0, vaultSeg: 0, versions: 0 },
  unaccountedBytes: 18_300_000_000,
}

function renderStorage({ storage, lang = 'en' }) {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/storage': { loading: false, data: { ...storage, diskHealth: unavailableDisk, raid, backup: unavailableBackup, maintenance: { active: false }, unavailable: { diskHealth: 'agent-unreachable', raid: 'not-configured', backups: 'agent-unreachable' } }, error: null },
    '/api/backup': { data: null, error: 'forbidden', loading: false },
  }
  return renderToStaticMarkup(React.createElement(Storage, { t: makeT(lang), go: () => {} }))
}

/** "<0.1%" reaches the DOM escaped; compare against what React actually emits. */
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** The innermost <li>…</li> containing `needle` — legend rows never nest. */
function legendRow(html, needle) {
  const rows = html.match(/<li[^>]*>(?:(?!<li)[\s\S])*?<\/li>/g) ?? []
  return rows.find((row) => row.includes(needle)) ?? null
}

test('CAPACITY-RING-1 the horizontal bar is gone and every category reaches the legend with its own bytes', () => {
  const html = renderStorage({ storage: rich })

  assert.equal(/gap-0\.5 h-10 rounded-full/.test(html), false, 'the single horizontal capacity bar must not come back')
  assert.ok(html.includes('<circle'), 'capacity is drawn as SVG ring arcs')
  assert.ok(html.includes(STRINGS.en.capacityLegendCategory))
  assert.ok(html.includes(STRINGS.en.capacityLegendSize))
  assert.ok(html.includes(STRINGS.en.capacityLegendShare))

  const sizes = { docs: 40_000_000_000, media: 90_000_000_000, vaultSeg: 6_000_000_000, versions: 3_000_000_000, other: 1_000_000_000 }
  for (const [key, bytes] of Object.entries(sizes)) {
    const row = legendRow(html, STRINGS.en[key])
    assert.ok(row, `${key} must have a legend row`)
    assert.ok(row.includes(fmtBytes(bytes)), `${key} must state ${fmtBytes(bytes)}`)
  }
})

test('CAPACITY-RING-2 total, used, free and used share all survive the redesign as stated figures', () => {
  const html = renderStorage({ storage: rich })
  for (const key of ['capacityTotal', 'capacityUsed', 'free', 'capacityUsedPct']) {
    assert.ok(html.includes(STRINGS.en[key]), `${key} must be labelled`)
  }
  assert.ok(html.includes(fmtBytes(512_000_000_000)), 'total')
  assert.ok(html.includes(fmtBytes(160_000_000_000)), 'used')
  assert.ok(html.includes(fmtBytes(352_000_000_000)), 'free')
  assert.ok(html.includes('31.3%'), 'used share is written out, never left implied by the arc')
  // the ring is announced to assistive tech instead of being left as decoration
  assert.ok(/role="img"/.test(html))
  assert.ok(html.includes('Capacity ring:'))
})

test('CAPACITY-RING-3 other-on-volume and free remain separate full-color segments', () => {
  const html = renderStorage({ storage: rich })

  const unaccounted = legendRow(html, STRINGS.en.unaccounted)
  const free = legendRow(html, STRINGS.en.free)
  assert.ok(unaccounted && free)
  assert.ok(unaccounted.includes('var(--capacity-volume-other)'), 'unaccounted used bytes own the semantic other-on-volume color')
  assert.ok(free.includes('var(--capacity-volume-free)'), 'measured free space owns a distinct semantic color')
  assert.ok(free.includes(fmtBytes(352_000_000_000)))
  assert.ok(unaccounted.includes(fmtBytes(19_996_000_000)), 'unaccounted bytes are reported, not folded into free')

  assert.equal(html.includes('<pattern'), false, 'the accepted full-segment design no longer uses a patterned fallback')
})

test('CAPACITY-RING-4 a tiny full-band category keeps its true share and is never rounded to zero', () => {
  const html = renderStorage({ storage: rich })

  const archives = legendRow(html, STRINGS.en.archives)
  assert.ok(archives)
  assert.ok(archives.includes(fmtBytes(4_000_000)), 'the exact size is in the legend')
  assert.ok(archives.includes(esc(STRINGS.en.capacityTinyShare)), 'a 0.0008% share reads as <0.1%')
  assert.equal(archives.includes('0.0%'), false, 'and never as a rounded 0.0%')
  assert.equal(html.includes(STRINGS.en.capacityFloorNote), false, 'there is no longer a visibility floor to disclose')
})

test('CAPACITY-RING-5 unreadable capacity says so instead of drawing a ring around zero', () => {
  const html = renderStorage({ storage: { capacityBytes: null, usage: null, unaccountedBytes: null } })
  assert.ok(html.includes(STRINGS.en.capacity), 'the card stays so the page keeps its section')
  assert.ok(html.includes(STRINGS.en.capacityUnreadable))
  assert.equal(html.includes('<circle'), false, 'no ring without a denominator')
  assert.equal(html.includes('0.0%'), false, 'and no percentage invented to fill it')
})

test('CAPACITY-RING-6 empty categories stay listed and stay inert rather than becoming buttons that do nothing', () => {
  const html = renderStorage({ storage: sparse })
  for (const key of ['docs', 'archives', 'media', 'vaultSeg', 'versions', 'other']) {
    const row = legendRow(html, STRINGS.en[key])
    assert.ok(row, `${key} is still listed so the category set is legible`)
    assert.ok(row.includes(STRINGS.en.storageZeroGb), `${key} reads as 0 GB`)
    assert.equal(row.includes('<button'), false, `${key} has no arc to highlight, so it is not a control`)
  }
  // the rows that do have an arc are real, keyboard-reachable controls
  const free = legendRow(html, STRINGS.en.free)
  assert.ok(free.includes('<button'))
  assert.ok(free.includes('aria-pressed'))
  assert.ok(free.includes('min-h-11'), 'interactive legend rows keep a 44px mobile touch target')
})

test('CAPACITY-RING-7 the capacity card renders in every language with no raw i18n key', () => {
  const keys = ['capacity', 'capacityLegendCategory', 'capacityLegendSize', 'capacityLegendShare', 'capacityVolumeGroup', 'capacityAegisGroup', 'capacityTotal', 'capacityUsed', 'capacityUsedPct', 'free', 'unaccounted']
  for (const lang of LANGS) {
    const html = renderStorage({ lang, storage: rich })
    for (const key of keys) {
      assert.ok(html.includes(STRINGS[lang][key]), `${lang}.${key} must render`)
      assert.equal(html.includes(`>${key}<`), false, `${lang}: raw key ${key} must not leak`)
    }
  }
})
