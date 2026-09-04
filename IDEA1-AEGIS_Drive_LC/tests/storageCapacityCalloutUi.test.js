// tests/storageCapacityCalloutUi.test.js — AEGIS Drive (IDEA1)
// The capacity card's two rings, and the honesty rule that forced them apart.
//
// On the production volume everything AEGIS stores is ~43 MB of a 119 GB
// filesystem — about 0.03 %. No single ring can make Documents or Vault read as
// a real arc of that volume without inflating their angle, which would be a lie
// about how full the disk is. So the card asks two questions against two
// declared bases:
//
//   outer ring, base = the whole volume : AEGIS data (one segment) /
//                                         Other on this volume / Free
//   inner ring, base = AEGIS data only  : the categories, at their true share
//                                         of what AEGIS stores
//
// Both percentages are true; they simply have different denominators, and each
// denominator is printed next to its own ring and its own legend group. What
// these tests defend is that neither base is ever silently swapped, that the
// volume ring keeps AEGIS at the visibility floor rather than inflating it, and
// that both rings still close at exactly 360°.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let dom
let createRoot
let vite
let CapacityCard

// The visibility floor the component uses, restated so the test fails if the
// component quietly raises it: 2px on a radius-82 ring, as a fraction.
const MIN_FRAC = 2 / (2 * Math.PI * 82)

before(async () => {
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
  })
  ;({ CapacityCard } = await vite.ssrLoadModule('/src/components/CapacityRing.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  dom?.window.close()
})

function stubMatchMedia(matches) {
  dom.window.matchMedia = () => ({ matches, addEventListener() {}, removeEventListener() {} })
}

// A production-shaped volume: every AEGIS category is a rounding error against
// the filesystem, but they are real, comparable sizes against each other.
const TOTAL = 128_035_676_160
const USAGE = {
  docs: 2_400_000,
  archives: 0,
  media: 41_000_000,
  vaultSeg: 950_000,
  versions: 128_000,
  other: 0,
}
const AEGIS_TOTAL = Object.values(USAGE).reduce((a, b) => a + b, 0)
const UNACCOUNTED = 18_300_000_000
const USED = UNACCOUNTED + AEGIS_TOTAL
const FREE = TOTAL - USED

const PROPS = {
  capacityBytes: { totalBytes: TOTAL, usedBytes: USED, freeBytes: FREE },
  usage: USAGE,
  unaccountedBytes: UNACCOUNTED,
}

async function mount({ wide = true, lang = 'en', props = PROPS } = {}) {
  stubMatchMedia(wide)
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(CapacityCard, { t: makeT(lang), ...props })))

  /** Both rings expose role="img"; the hatch-pattern carrier does not. */
  const rings = () => [...host.querySelectorAll('svg[role="img"]')]

  const readRing = (svg) => {
    const track = svg.querySelector('circle:not([stroke-dasharray])')
    const r = Number(track.getAttribute('r'))
    const C = 2 * Math.PI * r
    return {
      svg,
      cx: Number(track.getAttribute('cx')),
      cy: Number(track.getAttribute('cy')),
      r,
      band: Number(track.getAttribute('stroke-width')),
      arcs: [...svg.querySelectorAll('circle[stroke-dasharray]')].map((c) => {
        const [drawn] = c.getAttribute('stroke-dasharray').split(' ').map(Number)
        return {
          drawnFrac: drawn / C,
          startFrac: -Number(c.getAttribute('stroke-dashoffset')) / C,
          width: Number(c.getAttribute('stroke-width')),
        }
      }),
    }
  }

  return {
    host,
    volume: () => readRing(rings()[0]),
    aegis: () => readRing(rings()[1]),
    ringCount: () => rings().length,
    text: () => host.textContent,
    async unmount() { await act(async () => root.unmount()); host.remove() },
  }
}

/** The drawn arcs must tile the circle exactly once, in order, without overlap. */
function assertClosesAtFullCircle(ring, name) {
  assert.ok(ring.arcs.length > 0, `${name}: arcs are drawn`)
  const sorted = [...ring.arcs].sort((a, b) => a.startFrac - b.startFrac)
  const last = sorted[sorted.length - 1]
  const end = last.startFrac + last.drawnFrac
  assert.ok(Math.abs(1 - end) < 0.01, `${name}: segments must fill the circle exactly once (ended at ${end.toFixed(4)})`)
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].startFrac + 1e-9 >= sorted[i - 1].startFrac + sorted[i - 1].drawnFrac - 0.01,
      `${name}: segments must not overlap`,
    )
  }
}

/* ── both rings describe something real ── */

test('CAPACITY-2R-1 two rings render, and each closes at exactly 360° on its own base', async () => {
  const screen = await mount()
  try {
    assert.equal(screen.ringCount(), 2, 'the volume ring and the AEGIS breakdown ring both render')
    assertClosesAtFullCircle(screen.volume(), 'volume ring')
    assertClosesAtFullCircle(screen.aegis(), 'AEGIS ring')
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-2R-2 the volume ring carries AEGIS as ONE segment, not a fan of slivers', async () => {
  const screen = await mount()
  try {
    // AEGIS data + Other on this volume + Free. Collapsing the categories into a
    // single segment is what makes this ring readable at all.
    assert.equal(screen.volume().arcs.length, 3, 'the volume ring has exactly three segments')
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-2R-3 the volume ring still refuses to inflate AEGIS', async () => {
  const screen = await mount()
  try {
    const ring = screen.volume()
    assert.ok(AEGIS_TOTAL / TOTAL < MIN_FRAC, 'the fixture really is below the floor, so this test is meaningful')

    const ticks = ring.arcs.filter((a) => a.width < ring.band * 0.6)
    assert.equal(ticks.length, 1, 'exactly the AEGIS segment is below the drawable floor')
    assert.ok(
      ticks[0].drawnFrac <= MIN_FRAC * 1.05,
      `AEGIS must be drawn at the floor, not widened to look meaningful (${ticks[0].drawnFrac} > ${MIN_FRAC})`,
    )

    // Free keeps its measured angle — the ring is still a picture of the disk.
    const biggest = ring.arcs.reduce((a, b) => (b.drawnFrac > a.drawnFrac ? b : a))
    assert.ok(Math.abs(biggest.drawnFrac - FREE / TOTAL) < 0.02, 'free is drawn at its measured share')
  } finally {
    await screen.unmount()
  }
})

/* ── the second base is where categories become readable ── */

test('CAPACITY-2R-4 against the AEGIS base the categories become real arcs, not ticks', async () => {
  const screen = await mount()
  try {
    const ring = screen.aegis()
    assert.equal(ring.arcs.length, 4, 'the four non-empty categories are drawn')

    const fullBand = ring.arcs.filter((a) => a.width >= ring.band * 0.6)
    assert.ok(fullBand.length >= 3, 'most categories now read as full-thickness arc sections')

    // Media is 41 MB of 44.478 MB — a true 92 %, and visibly the dominant arc.
    const biggest = ring.arcs.reduce((a, b) => (b.drawnFrac > a.drawnFrac ? b : a))
    assert.ok(
      Math.abs(biggest.drawnFrac - USAGE.media / AEGIS_TOTAL) < 0.02,
      'the dominant category is drawn at its true share of the AEGIS base',
    )
    assert.ok(biggest.drawnFrac > 0.5, 'it is a real, readable section of the ring')
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-2R-5 a category still under the floor on the AEGIS base is still not inflated', async () => {
  const screen = await mount()
  try {
    const ring = screen.aegis()
    // Earlier versions is 128 KB of 44.478 MB ≈ 0.29 %, below the floor even here.
    assert.ok(USAGE.versions / AEGIS_TOTAL < MIN_FRAC, 'the fixture keeps one sub-floor category')
    const ticks = ring.arcs.filter((a) => a.width < ring.band * 0.6)
    assert.equal(ticks.length, 1, 'it is drawn as a tick, at the floor')
    assert.ok(ticks[0].drawnFrac <= MIN_FRAC * 1.05, 'and never wider than the floor')
    assert.ok(screen.text().includes(STRINGS.en.capacityFloorNote), 'the tick treatment stays disclosed')
  } finally {
    await screen.unmount()
  }
})

/* ── the two bases are declared, never implied ── */

test('CAPACITY-2R-6 each ring prints its own base, and the legend splits by base', async () => {
  const screen = await mount()
  try {
    const text = screen.text()
    assert.ok(text.includes(STRINGS.en.capacityVolumeGroup), 'the volume group is named')
    assert.ok(text.includes(STRINGS.en.capacityAegisGroup), 'the AEGIS group is named')
    assert.ok(text.includes(STRINGS.en.capacityShareOfAegis), 'the AEGIS column says what it is a share OF')
    assert.ok(text.includes(STRINGS.en.capacityLegendShare), 'the volume column keeps its own share label')

    // The sentence that makes the second denominator explicit rather than implied.
    const base = STRINGS.en.capacityAegisBase.split('{total}')
    assert.ok(text.includes(base[0].trim()), 'the AEGIS base is stated in words, not left to inference')
    assert.equal(text.includes('{total}'), false, 'the base sentence is interpolated, not raw')
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-2R-7 AEGIS appears in both bases with different, individually true shares', async () => {
  const screen = await mount()
  try {
    const text = screen.text()
    // On the volume it is a sub-0.1 % sliver; inside itself it is the whole base.
    assert.ok(text.includes(STRINGS.en.capacityTinyShare), 'the volume share of AEGIS reads as <0.1%')
    assert.ok(text.includes(STRINGS.en.capacityAegisData), 'AEGIS data is a named row on the volume ring')
    assert.equal(text.includes('0.0%'), false, 'nothing real is rounded away to 0.0%')
  } finally {
    await screen.unmount()
  }
})

/* ── callouts, responsive, interaction, i18n ── */

test('CAPACITY-2R-8 leader lines belong to the volume ring only, and never cross the band', async () => {
  const screen = await mount()
  try {
    const volume = screen.volume()
    const aegis = screen.aegis()
    const lines = [...volume.svg.querySelectorAll('polyline')]
    assert.equal(lines.length, 3, 'each volume segment gets one leader')
    assert.equal(aegis.svg.querySelectorAll('polyline').length, 0, 'the small ring maps to its legend instead')

    const outer = volume.r + volume.band / 2
    for (const line of lines) {
      const points = line.getAttribute('points').split(' ').map((p) => p.split(',').map(Number))
      const [ax, ay] = points[0]
      assert.ok(
        Math.abs(Math.hypot(ax - volume.cx, ay - volume.cy) - outer) < 1.5,
        'a leader begins on the ring edge at the segment’s real angle',
      )
      // Every point after the radial stub sits outside the ring's outer radius,
      // so no leader can be drawn across the band.
      for (const [x, y] of points.slice(2)) {
        assert.ok(
          Math.hypot(x - volume.cx, y - volume.cy) >= outer,
          'the leader routes around the ring, never across it',
        )
      }
    }
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-2R-9 narrow viewports drop the leaders and keep both legends', async () => {
  const screen = await mount({ wide: false })
  try {
    assert.equal(screen.volume().svg.querySelectorAll('polyline').length, 0, 'no leaders where they would overlap')
    assert.equal(screen.ringCount(), 2, 'both rings still render')
    for (const copy of [STRINGS.en.capacityVolumeGroup, STRINGS.en.capacityAegisGroup, STRINGS.en.capacityLegendCategory, STRINGS.en.free]) {
      assert.ok(screen.text().includes(copy), `"${copy}" survives the narrow layout`)
    }
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-2R-10 every legend row across both groups is a keyboard-operable pin control', async () => {
  const screen = await mount()
  try {
    const buttons = [...screen.host.querySelectorAll('button[aria-pressed]')]
    // 3 volume rows + 4 non-empty categories.
    assert.equal(buttons.length, 7, 'each non-empty row in both groups is a pin control')
    for (const button of buttons) assert.equal(button.getAttribute('aria-pressed'), 'false')

    await act(async () => buttons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(screen.host.querySelectorAll('button[aria-pressed="true"]').length, 1, 'clicking pins one row')
    await act(async () => screen.host.querySelector('button[aria-pressed="true"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(screen.host.querySelectorAll('button[aria-pressed="true"]').length, 0, 'clicking again unpins')

    // Empty categories are listed but inert — a button that does nothing lies.
    for (const label of [STRINGS.en.archives, STRINGS.en.other]) {
      assert.ok(screen.text().includes(label), `${label} stays listed so the category set is legible`)
    }
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-2R-11 both rings keep an accessible summary in every locale', async () => {
  for (const lang of LANGS) {
    const screen = await mount({ lang })
    try {
      for (const svg of [screen.volume().svg, screen.aegis().svg]) {
        const label = svg.getAttribute('aria-label')
        assert.ok(label && label.trim().length > 0, `[${lang}] each ring has a text summary`)
        assert.equal(label.includes('{'), false, `[${lang}] no unsubstituted placeholder in "${label}"`)
      }
      for (const key of ['capacityVolumeGroup', 'capacityAegisGroup', 'capacityShareOfAegis', 'capacityAegisData']) {
        assert.ok(screen.text().includes(STRINGS[lang][key]), `[${lang}] ${key} is translated and rendered`)
        assert.equal(screen.text().includes(`>${key}<`), false, `[${lang}] ${key} leaked as a raw key`)
      }
    } finally {
      await screen.unmount()
    }
  }
})

test('CAPACITY-2R-12 a volume where AEGIS stores nothing still lists the category set', async () => {
  const empty = {
    capacityBytes: { totalBytes: TOTAL, usedBytes: UNACCOUNTED, freeBytes: TOTAL - UNACCOUNTED },
    usage: { docs: 0, archives: 0, media: 0, vaultSeg: 0, versions: 0, other: 0 },
    unaccountedBytes: UNACCOUNTED,
  }
  const screen = await mount({ props: empty })
  try {
    assert.equal(screen.ringCount(), 1, 'there is no AEGIS ring to draw when the base is zero')
    assert.ok(screen.text().includes(STRINGS.en.capacityAegisEmpty), 'and the card says so plainly')
    for (const key of ['docs', 'media', 'vaultSeg', 'versions', 'archives', 'other']) {
      assert.ok(screen.text().includes(STRINGS.en[key]), `${key} stays listed even at zero`)
    }
    assert.equal(screen.host.querySelectorAll('button[aria-pressed]').length, 2, 'only the two real volume rows are pinnable')
  } finally {
    await screen.unmount()
  }
})
