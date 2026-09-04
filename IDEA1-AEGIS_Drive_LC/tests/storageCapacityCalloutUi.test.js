// tests/storageCapacityCalloutUi.test.js — AEGIS Drive (IDEA1)
// Post-deploy acceptance contract for the concentric, dual-base capacity chart.
// A positive value always owns a full-width band at its true angular share;
// legends, not invented geometry, keep tiny values readable.
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

const TOTAL = 128_035_676_160
const USAGE = {
  docs: 2_400_000,
  archives: 64_000,
  media: 41_000_000,
  vaultSeg: 950_000,
  versions: 128_000,
  other: 36_000,
}
const AEGIS_TOTAL = Object.values(USAGE).reduce((a, b) => a + b, 0)
const OTHER_ON_VOLUME = 18_300_000_000
const USED = OTHER_ON_VOLUME + AEGIS_TOTAL
const FREE = TOTAL - USED
const PROPS = {
  capacityBytes: { totalBytes: TOTAL, usedBytes: USED, freeBytes: FREE },
  usage: USAGE,
  unaccountedBytes: OTHER_ON_VOLUME,
}

async function mount({ lang = 'en', props = PROPS } = {}) {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(CapacityCard, { t: makeT(lang), ...props })))
  return {
    host,
    chart: () => host.querySelector('svg[role="img"]'),
    segments: (ring) => [...host.querySelectorAll(`[data-capacity-ring="${ring}"]`)],
    async unmount() { await act(async () => root.unmount()); host.remove() },
  }
}

function arcFraction(circle) {
  const radius = Number(circle.getAttribute('r'))
  const circumference = 2 * Math.PI * radius
  return Number(circle.getAttribute('stroke-dasharray').split(/[ ,]/)[0]) / circumference
}

test('CAPACITY-ACCEPT-1 one chart contains concentric outer-volume and inner-AEGIS rings', async () => {
  const screen = await mount()
  try {
    assert.ok(screen.chart(), 'the dual-ring chart has one accessible figure')
    assert.equal(screen.host.querySelectorAll('svg[role="img"]').length, 1, 'rings are concentric, not separate charts')
    assert.equal(screen.segments('volume').length, 3, 'outer ring: AEGIS used, other on volume, free')
    assert.equal(screen.segments('aegis').length, 6, 'inner ring: every positive AEGIS category')
    const outerRadius = Number(screen.segments('volume')[0].getAttribute('r'))
    const innerRadius = Number(screen.segments('aegis')[0].getAttribute('r'))
    assert.ok(outerRadius > innerRadius, 'the volume ring is physically outside the AEGIS ring')
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-ACCEPT-2 every positive segment uses its ring full width with butt caps', async () => {
  const screen = await mount()
  try {
    for (const ring of ['volume', 'aegis']) {
      const segments = screen.segments(ring)
      const widths = new Set(segments.map((node) => node.getAttribute('stroke-width')))
      assert.equal(widths.size, 1, `${ring}: tiny categories must not fall back to thin ticks`)
      for (const node of segments) {
        assert.equal(node.getAttribute('stroke-linecap'), 'butt', `${ring}: round caps would overstate tiny shares`)
      }
    }
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-ACCEPT-3 angular shares use their declared denominator without a visibility floor', async () => {
  const screen = await mount()
  try {
    const volumeAegis = screen.host.querySelector('[data-capacity-ring="volume"][data-capacity-segment="aegis"]')
    const innerArchives = screen.host.querySelector('[data-capacity-ring="aegis"][data-capacity-segment="archives"]')
    assert.ok(Math.abs(arcFraction(volumeAegis) - AEGIS_TOTAL / TOTAL) < 1e-8, 'outer AEGIS share is relative to the whole volume')
    assert.ok(Math.abs(arcFraction(innerArchives) - USAGE.archives / AEGIS_TOTAL) < 1e-8, 'inner archive share is relative to AEGIS bytes')
  } finally {
    await screen.unmount()
  }
})

test('CAPACITY-ACCEPT-4 both legends disclose their base and tiny values remain truthfully labelled', async () => {
  for (const lang of LANGS) {
    const screen = await mount({ lang })
    try {
      const text = screen.host.textContent
      assert.ok(text.includes(STRINGS[lang].capacityVolumeGroup), `${lang}: volume legend title`)
      assert.ok(text.includes(STRINGS[lang].capacityAegisGroup), `${lang}: AEGIS legend title`)
      assert.ok(text.includes(STRINGS[lang].capacityTinyShare), `${lang}: tiny true shares are disclosed instead of rounded to zero`)
    } finally {
      await screen.unmount()
    }
  }
})

test('CAPACITY-ACCEPT-5 zero AEGIS categories stay in the legend but do not invent arcs', async () => {
  const screen = await mount({
    props: {
      capacityBytes: { totalBytes: 1000, usedBytes: 300, freeBytes: 700 },
      usage: { docs: 0, archives: 0, media: 0, vaultSeg: 0, versions: 0, other: 0 },
      unaccountedBytes: 300,
    },
  })
  try {
    assert.equal(screen.segments('aegis').length, 0, 'zero values create no geometry')
    for (const key of ['docs', 'archives', 'media', 'vaultSeg', 'versions', 'other']) {
      assert.ok(screen.host.textContent.includes(STRINGS.en[key]), `${key} remains discoverable in the legend`)
    }
  } finally {
    await screen.unmount()
  }
})
