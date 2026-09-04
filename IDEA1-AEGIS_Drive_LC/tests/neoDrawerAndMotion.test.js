// tests/neoDrawerAndMotion.test.js — AEGIS Drive (IDEA1)
//
// Two things this covers.
//
// 1. The drawer scrim. It used to be an inline
//    `color-mix(in srgb, var(--ink) 30%, transparent)` in Sidebar.jsx. --ink is
//    near-white in every dark theme, so on narrow layouts that formula laid 30 %
//    WHITE over the page and the whole shell read as milky and smoke-filled.
//    index.css already warns about exactly this hazard, two lines above
//    --modal-scrim, and the modal avoided it by using a literal per-theme
//    colour. The drawer now does the same.
//
// 2. The Neo motion + lighting layer. It is allowed to be expressive, but it is
//    not allowed to animate anything that costs layout, and it must disappear
//    entirely under prefers-reduced-motion.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf8')
const sidebar = fs.readFileSync(path.join(rootDir, 'src/components/Sidebar.jsx'), 'utf8')
const reveal = fs.readFileSync(path.join(rootDir, 'src/lib/useScrollReveal.js'), 'utf8')

/** The body of a rule, given its selector. */
function ruleBody(selector) {
  const at = css.indexOf(selector)
  assert.notEqual(at, -1, `no rule for "${selector}"`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

/* ── the drawer scrim ── */

test('NEO-DRAWER-1 the drawer scrim is a per-theme token, never mixed from --ink', () => {
  // The regression itself: --ink inverts per theme, so mixing it produces a
  // white film in dark mode instead of a dim.
  assert.equal(
    /background:\s*['"]?color-mix\(in srgb, var\(--ink\)/.test(sidebar), false,
    'Sidebar.jsx must not mix a scrim colour out of --ink',
  )
  assert.match(sidebar, /className="drawer-scrim/, 'the drawer uses the themed scrim class')

  const body = ruleBody('.drawer-scrim {')
  assert.match(body, /background:\s*var\(--drawer-scrim\)/, 'it paints the token, not a literal')
})

test('NEO-DRAWER-2 every theme defines a drawer scrim that darkens rather than washes', () => {
  // One definition per theme root. Each must be a dark colour: a scrim that is
  // lighter than the surface it covers is the bug this test exists for.
  const themes = [
    { name: 'classic light', at: css.indexOf(':root {') },
    { name: 'classic dark', at: css.indexOf(':root[data-theme="dark"] {') },
    { name: 'neo light', at: css.indexOf(':root[data-ui-style="neo"] {') },
    { name: 'neo dark', at: css.indexOf(':root[data-ui-style="neo"][data-theme="dark"] {') },
  ]
  for (const theme of themes) {
    assert.notEqual(theme.at, -1, `${theme.name}: root block exists`)
    const block = css.slice(theme.at, css.indexOf('\n}', theme.at))
    const match = block.match(/--drawer-scrim:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)
    assert.ok(match, `${theme.name} must define --drawer-scrim as a literal rgba`)

    const [, r, g, b, a] = match
    const luminance = (Number(r) * 0.299 + Number(g) * 0.587 + Number(b) * 0.114) / 255
    assert.ok(luminance < 0.35, `${theme.name}: the scrim must be a dark colour, got luminance ${luminance.toFixed(2)}`)
    assert.ok(Number(a) > 0.2 && Number(a) < 0.7, `${theme.name}: alpha ${a} should separate without sealing the page off`)
  }
})

test('NEO-DRAWER-3 the drawer separates with a lighter touch than a modal', () => {
  // A drawer is a shift of attention, not a gate: its blur stays well under the
  // modal's so the page behind remains legible.
  const drawer = ruleBody('.drawer-scrim {')
  const drawerBlur = Number(drawer.match(/backdrop-filter:\s*blur\((\d+)px\)/)[1])
  assert.ok(drawerBlur > 0 && drawerBlur <= 3, `drawer blur ${drawerBlur}px should stay subtle`)
  assert.match(css, /--modal-blur:/, 'the modal keeps its own, heavier blur token')
})

test('NEO-DRAWER-4 the Neo drawer panel is squared against the viewport edge', () => {
  // The desktop sidebar floats as a rounded card; the drawer is flush left, so
  // rounding that edge reads as a rendering fault.
  assert.match(sidebar, /className="app-drawer-panel/, 'the drawer panel is identifiable')
  const body = ruleBody(':root[data-ui-style="neo"] .app-drawer-panel .app-sidebar {')
  assert.match(body, /border-radius:\s*0 18px 18px 0/, 'only the inner corners are rounded')
})

/* ── the Neo motion layer ── */

test('NEO-MOTION-1 the polish layer animates only compositor-friendly properties', () => {
  const start = css.indexOf('Neo motion + edge lighting')
  assert.notEqual(start, -1, 'the Neo motion layer is present')
  const end = css.indexOf('.interface-style-grid', start)
  const layer = css.slice(start, end)

  // Anything in a transition/animation list here must be cheap to animate.
  const banned = /transition:[^;]*\b(width|height|padding|margin|top|left|right|bottom|filter|backdrop-filter)\b/
  assert.equal(banned.test(layer), false, 'no layout or filter property is transitioned in the Neo layer')

  // And it must actually move something, or it is not a polish layer.
  assert.match(layer, /transform:\s*translateY\(-1px\)/, 'buttons lift on hover')
  assert.match(layer, /transform:\s*translateX\(2px\)/, 'nav items settle on hover')
  assert.match(layer, /transform:\s*scale\(0\.97\)/, 'controls compress on press')
})

test('NEO-MOTION-2 lighting is a hairline edge catch, not a glow on everything', () => {
  assert.match(css, /--neo-edge-light:\s*inset 0 1px 0/, 'the edge light is a 1px inset highlight')
  assert.match(css, /--neo-edge-light-soft:\s*inset 0 1px 0/)

  // Dark mode must not use white for the catch — at this size it reads as a seam.
  const darkRoot = css.slice(
    css.indexOf(':root[data-ui-style="neo"][data-theme="dark"] {'),
    css.indexOf('\n}', css.indexOf(':root[data-ui-style="neo"][data-theme="dark"] {')),
  )
  const darkEdge = darkRoot.match(/--neo-edge-light:\s*inset 0 1px 0 (rgba\([^)]+\))/)
  assert.ok(darkEdge, 'dark mode redefines the edge light')
  assert.equal(/rgba\(255,\s*255,\s*255/.test(darkEdge[1]), false, 'dark mode does not use pure white for the catch')

  // Inside the Neo polish layer the glow belongs to selection only — the one
  // thing a screen has exactly one of. (Classic's own pre-existing use of
  // --active-glow on a primary action is its accepted baseline and is not
  // governed here; this pass must not change Classic's visual language.)
  const start = css.indexOf('Neo motion + edge lighting')
  const layer = css.slice(start, css.indexOf('.interface-style-grid', start))
  const glowed = [...layer.matchAll(/([^\n{]+)\{[^}]*var\(--active-glow\)/g)].map((m) => m[1])
  assert.ok(glowed.length > 0, 'the Neo layer does use the selection glow')
  for (const selector of glowed) {
    assert.match(
      selector, /is-active|aria-checked="true"/,
      `--active-glow may only mark a selected element, not "${selector.trim()}"`,
    )
  }
})

test('NEO-MOTION-3 one easing curve, and it eases out without bouncing', () => {
  const curve = css.match(/--neo-ease:\s*cubic-bezier\(([^)]+)\)/)
  assert.ok(curve, 'Neo declares a single easing token')
  const [x1, y1, x2, y2] = curve[1].split(',').map((n) => Number(n.trim()))
  assert.ok(y1 <= 1.001 && y2 <= 1.001, 'no control point overshoots 1 — no bounce or elastic')
  assert.ok(y1 > x1, 'the curve front-loads its motion, i.e. it eases out')
})

/* ── reduced motion and the reveal safety rule ── */

test('NEO-MOTION-4 prefers-reduced-motion switches the whole layer off', () => {
  const at = css.lastIndexOf('@media (prefers-reduced-motion: reduce)')
  const block = css.slice(at)
  assert.match(block, /:root\[data-ui-style="neo"\] \.ui-card[\s\S]*transform:\s*none !important/)
  assert.match(block, /:root\[data-ui-style="neo"\] \.ui-modal[\s\S]*animation:\s*none !important/)
  assert.match(block, /\[data-reveal\][\s\S]*opacity:\s*1 !important/, 'revealed content is simply shown')
})

test('NEO-REVEAL-1 the reveal enhances a visible default and can never strand content hidden', () => {
  // The from-state exists ONLY under the JS-set attribute...
  assert.match(css, /:root\[data-neo-reveal="on"\] \[data-reveal\]:not\(\[data-revealed\]\)/)
  const hiddenRule = ruleBody(':root[data-neo-reveal="on"] [data-reveal]:not([data-revealed]) {')
  assert.match(hiddenRule, /opacity:\s*0/)
  // ...so a bare [data-reveal] with no armed root is never hidden by any rule.
  assert.equal(
    /^\s*\[data-reveal\][^{]*\{[^}]*opacity:\s*0/m.test(css), false,
    'no unscoped rule may hide a revealable section',
  )

  // ...and the hook refuses to arm without the capabilities it depends on.
  assert.match(reveal, /prefers-reduced-motion: reduce/, 'reduced motion disarms it')
  assert.match(reveal, /typeof window\.IntersectionObserver !== 'function'/, 'missing IO disarms it')
  assert.match(reveal, /setTimeout\(\(\) => targets\.forEach\(reveal\)/, 'a failsafe reveals anything unreported')
  assert.match(reveal, /delete doc\.documentElement\.dataset\.neoReveal/, 'teardown disarms the from-state')
})

test('NEO-REVEAL-2 the reveal is Neo-only, so Classic keeps its accepted baseline', () => {
  const app = fs.readFileSync(path.join(rootDir, 'src/App.jsx'), 'utf8')
  assert.match(app, /useScrollReveal\(mainRef, screen, interfaceStyle === 'neo'\)/)
})
