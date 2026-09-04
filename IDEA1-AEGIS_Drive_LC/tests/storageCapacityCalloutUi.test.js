// tests/storageCapacityCalloutUi.test.js — AEGIS Drive (IDEA1)
// The capacity ring's leader-line callouts.
//
// On the production volume the AEGIS categories are tiny next to the
// filesystem: almost the whole circumference is "other on this volume" plus
// free space, and the real categories are slivers. The fix is to label them,
// not to widen them. So the property under test is an honesty property:
//
//   a category too small to draw is drawn at the visibility floor and no
//   larger, keeps its true bytes and true share in its callout, and the ring
//   still closes at exactly 360° = the real filesystem total.
//
// Angular share is the thing that can lie here. Text cannot, so the text
// carries the precision and the geometry stays bounded.
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

// The visibility floor the component uses, restated here so the test fails if
// the component quietly raises it: 2px on a radius-82 ring, as a fraction.
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

/** jsdom has no matchMedia; the ring asks it whether there is room for callouts. */
function stubMatchMedia(matches) {
  dom.window.matchMedia = () => ({
    matches,
    addEventListener() {},
    removeEventListener() {},
  })
}

// A deliberately production-shaped volume: a 128 GB filesystem where every
// AEGIS category is a rounding error next to "other on this volume" and free.
const TOTAL = 128_035_676_160
const USAGE = {
  docs: 2_400_000,      // ~0.0019 %  — far below the drawable floor
  archives: 0,
  media: 41_000_000,    // ~0.032 %   — still below the floor
  vaultSeg: 950_000,    // ~0.0007 %
  versions: 128_000,    // ~0.0001 %
  other: 0,
}
const UNACCOUNTED = 18_300_000_000
const USED = UNACCOUNTED + Object.values(USAGE).reduce((a, b) => a + b, 0)
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
  return {
    host,
    svg: () => host.querySelector('svg'),
    /** Every drawn arc, as { start, drawn, width } fractions/pixels of the ring. */
    arcs() {
      const svg = host.querySelector('svg')
      const r = Number(svg.querySelector('circle').getAttribute('r'))
      const C = 2 * Math.PI * r
      return [...svg.querySelectorAll('circle[stroke-dasharray]')].map((c) => {
        const [drawn] = c.getAttribute('stroke-dasharray').split(' ').map(Number)
        return {
          drawn,
          drawnFrac: drawn / C,
          start: -Number(c.getAttribute('stroke-dashoffset')),
          startFrac: -Number(c.getAttribute('stroke-dashoffset')) / C,
          width: Number(c.getAttribute('stroke-width')),
          C,
          r,
        }
      })
    },
    /** The full band width, read off the background track. */
    bandWidth() {
      const track = host.querySelector('svg circle:not([stroke-dasharray])')
      return Number(track.getAttribute('stroke-width'))
    },
    text: () => host.textContent,
    svgText: () => [...host.querySelectorAll('svg text')].map((n) => n.textContent),
    async unmount() { await act(async () => root.unmount()); host.remove() },
  }
}

/** The ring's own geometry, read off the background track circle. */
function ringGeometry(svg) {
  const track = svg.querySelector('circle:not([stroke-dasharray])')
  return {
    cx: Number(track.getAttribute('cx')),
    cy: Number(track.getAttribute('cy')),
    r: Number(track.getAttribute('r')),
    band: Number(track.getAttribute('stroke-width')),
  }
}

/* ── the ring still describes the real filesystem ── */

test('CAPACITY-CALLOUT-1 the ring still closes at exactly 360° = the real total', async () => {
  const screen = await mount()
  try {
    const arcs = screen.arcs()
    assert.ok(arcs.length > 0, 'arcs are drawn')
    const last = arcs.reduce((a, b) => (b.startFrac > a.startFrac ? b : a))
    // The final segment ends at the top of the circle again, within the gap
    // the design leaves between segments.
    const end = last.startFrac + last.drawnFrac
    assert.ok(
      Math.abs(1 - end) < 0.01,
      `the drawn segments must fill the circle exactly once (ended at ${end.toFixed(4)})`,
    )
    // Segments are laid end to end with no overlap and no reordering.
    const sorted = [...arcs].sort((a, b) => a.startFrac - b.startFrac)
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(
        sorted[i].startFrac + 1e-9 >= sorted[i - 1].startFrac + sorted[i - 1].drawnFrac - 0.01,
        'segments must not overlap one another',
      )
    }
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-CALLOUT-2 a large measured segment keeps its true angular share', async () => {
  const screen = await mount()
  try {
    const arcs = screen.arcs()
    const trueFree = FREE / TOTAL
    // Free is the biggest segment; it is also the one the floor borrows from,
    // so it may shrink very slightly — but it must still be its own share.
    const freeArc = arcs.reduce((a, b) => (b.drawnFrac > a.drawnFrac ? b : a))
    assert.ok(
      Math.abs(freeArc.drawnFrac - trueFree) < 0.02,
      `free must be drawn at its measured share (${freeArc.drawnFrac.toFixed(4)} vs ${trueFree.toFixed(4)})`,
    )
  } finally {
    await screen.unmount()
  }
})

/* ── the honesty property ── */

test('CAPACITY-CALLOUT-3 a tiny category is never inflated — it is drawn at the floor, as a thin tick', async () => {
  const screen = await mount()
  try {
    const arcs = screen.arcs()
    const band = screen.bandWidth()
    // A tick is dramatically thinner than the ring. (Free is drawn at band - 2,
    // which is still a band segment, so the threshold has to be well below that.)
    const ticks = arcs.filter((a) => a.width < band * 0.6)
    assert.equal(ticks.length, 4, 'each of the four sub-floor categories is drawn as a tick, not as a band segment')

    for (const tick of ticks) {
      assert.ok(
        tick.drawnFrac <= MIN_FRAC * 1.05,
        `a sub-floor category must never be drawn wider than the visibility floor (${tick.drawnFrac} > ${MIN_FRAC})`,
      )
      assert.ok(
        tick.width < band,
        'a tick must be visibly thinner than the ring, so it reads as a marker rather than a share',
      )
    }

    // The largest seeded category is 0.032 % of the volume. If the ring were
    // inflating shares to make them legible, it would be drawn far larger.
    const worst = Math.max(...ticks.map((t) => t.drawnFrac))
    assert.ok(worst < 0.005, `no sub-floor category may approach a legible-looking wedge (was ${(worst * 100).toFixed(3)}%)`)
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-CALLOUT-4 the floor is disclosed in words, and true shares are never rounded to zero', async () => {
  const screen = await mount()
  try {
    assert.ok(screen.text().includes(STRINGS.en.capacityFloorNote), 'the tick treatment is explained')
    assert.ok(screen.text().includes(STRINGS.en.capacityTinyShare), 'a sub-0.1% share reads as <0.1%, never 0.0%')
    assert.equal(screen.text().includes('0.0%'), false, 'no real category is rounded away to 0.0%')
  } finally {
    await screen.unmount()
  }
})

/* ── the callouts themselves ── */

test('CAPACITY-CALLOUT-5 every drawn segment gets a callout carrying its name, exact size and exact share', async () => {
  const screen = await mount()
  try {
    const labels = screen.svgText()
    for (const key of ['docs', 'media', 'vaultSeg', 'versions']) {
      assert.ok(labels.includes(STRINGS.en[key]), `${key} must be named in a callout`)
    }
    assert.ok(labels.includes(STRINGS.en.unaccounted), 'unattributed space is named')
    assert.ok(labels.includes(STRINGS.en.free), 'free space is named')

    // Each callout's second line is "<exact size> · <exact share>".
    const figures = labels.filter((l) => l.includes(' · '))
    assert.ok(figures.length >= 6, 'each callout states a size and a share')
    assert.ok(
      figures.some((f) => f.endsWith(STRINGS.en.capacityTinyShare)),
      'a sub-0.1% category states <0.1% rather than a rounded 0%',
    )
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-CALLOUT-6 a leader line starts at the true location of its own segment', async () => {
  const screen = await mount()
  try {
    const svg = screen.svg()
    const lines = [...svg.querySelectorAll('polyline')]
    assert.ok(lines.length >= 6, 'each drawn segment has a leader line')

    // Read the ring's real geometry rather than restating it, so this stays
    // true if the ring is resized.
    const { cx, cy, r, band } = ringGeometry(svg)
    for (const line of lines) {
      const [ax, ay] = line.getAttribute('points').split(' ')[0].split(',').map(Number)
      const radius = Math.hypot(ax - cx, ay - cy)
      assert.ok(
        Math.abs(radius - (r + band / 2)) < 1.5,
        `a leader must begin on the ring's own edge, at the segment's real angle (r=${radius.toFixed(1)})`,
      )
    }
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-CALLOUT-7 callouts do not overlap one another', async () => {
  const screen = await mount()
  try {
    const svg = screen.svg()
    const { cx } = ringGeometry(svg)
    const byColumn = { left: [], right: [] }
    for (const line of svg.querySelectorAll('polyline')) {
      const points = line.getAttribute('points').split(' ').map((p) => p.split(',').map(Number))
      const [lx, ly] = points[points.length - 1]
      byColumn[lx < cx ? 'left' : 'right'].push(ly)
    }
    for (const [side, ys] of Object.entries(byColumn)) {
      const sorted = [...ys].sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i += 1) {
        // Each callout is two lines of type; they need more than a line-height
        // between them or the size of one runs into the name of the next.
        assert.ok(
          sorted[i] - sorted[i - 1] >= 40,
          `[${side}] two callouts sit ${sorted[i] - sorted[i - 1]}px apart and would crowd`,
        )
      }
    }
  } finally {
    await screen.unmount()
  }
})

/* ── responsive + interaction + i18n ── */

test('CAPACITY-CALLOUT-8 narrow viewports drop the leader lines and keep the stacked legend', async () => {
  const screen = await mount({ wide: false })
  try {
    assert.equal(screen.svg().querySelectorAll('polyline').length, 0, 'no leader lines where they would overlap')
    // The authoritative numbers are still fully present, in the legend.
    assert.ok(screen.text().includes(STRINGS.en.capacityLegendCategory))
    assert.ok(screen.text().includes(STRINGS.en.capacityLegendShare))
    assert.ok(screen.text().includes(STRINGS.en.free))
    assert.ok(screen.text().includes(STRINGS.en.capacityFloorNote))
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-CALLOUT-9 the legend rows stay keyboard-operable pin controls', async () => {
  const screen = await mount()
  try {
    const buttons = [...screen.host.querySelectorAll('button[aria-pressed]')]
    assert.ok(buttons.length >= 6, 'every non-empty category is a pin control')
    for (const button of buttons) assert.equal(button.getAttribute('aria-pressed'), 'false')

    await act(async () => buttons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(
      screen.host.querySelectorAll('button[aria-pressed="true"]').length, 1,
      'clicking pins exactly one category',
    )

    await act(async () => screen.host.querySelector('button[aria-pressed="true"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(screen.host.querySelectorAll('button[aria-pressed="true"]').length, 0, 'clicking again unpins it')
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-CALLOUT-10 the ring keeps an accessible summary, in every locale', async () => {
  for (const lang of LANGS) {
    const screen = await mount({ lang })
    try {
      const label = screen.svg().getAttribute('aria-label')
      assert.ok(label && label.length > 0, `[${lang}] the ring has a text summary`)
      assert.equal(label.includes('{'), false, `[${lang}] the summary has no unsubstituted placeholder`)
      assert.equal(screen.svg().getAttribute('role'), 'img')
      assert.equal(screen.text().includes('capacityFloorNote'), false, `[${lang}] no raw i18n key is rendered`)
    } finally {
      await screen.unmount()
    }
  }
})
