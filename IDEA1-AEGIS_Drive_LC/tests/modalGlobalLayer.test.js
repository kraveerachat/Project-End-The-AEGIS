// Production evidence, Private Vault unlock modal:
//   page content dimmed, Sidebar dimmed, sticky TopBar still white and clear
//   above the scrim.
//
// The cause was structural, not numeric. TopBar is `sticky` with
// `z-index: var(--z-sticky)`, so it establishes its own stacking context in the
// root. The Modal was rendered from inside the screen subtree, under
// `<div class="fade-in">` — and `.fade-in` animates opacity with
// `animation-fill-mode: both`, so the browser keeps that div's stacking context
// alive after the animation finishes. The Modal's `z-index: 50` was therefore
// scoped inside a `z-index: auto` box and could never outrank a real z-20
// sibling of that box. Raising numbers inside Vault.jsx could not have fixed it.
//
// The fix is a portal to a document.body modal root, which these tests pin down
// structurally. Pixel quality is NOT proven here — jsdom computes no blur, no
// compositing and no paint order. The backdrop treatment is covered by a static
// CSS contract below so a later stylesheet cleanup cannot silently restore the
// clear-TopBar regression; manual browser acceptance remains required.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer } from 'vite'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let dom
let createRoot
let vite
let Modal
let ModalClose

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/drive/vault',
    pretendToBeVisual: true,
  })
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
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
  })
  ;({ Modal, ModalClose } = await vite.ssrLoadModule('/src/components/ui.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  dom?.window.close()
})

const doc = () => dom.window.document

/* An app shell with the same layering that produced the bug: a sticky TopBar
   sibling above <main>, and the modal owned by a screen deep inside a
   `.fade-in` wrapper. */
function ShellWithModal({ open, onClose = () => {} }) {
  return React.createElement(
    'div',
    { className: 'h-full flex' },
    React.createElement('aside', { key: 'side', id: 'sidebar' }, 'Sidebar'),
    React.createElement(
      'div',
      { key: 'col', className: 'flex-1 flex flex-col' },
      React.createElement('header', {
        key: 'top',
        id: 'topbar',
        className: 'sticky top-0 z-[var(--z-sticky)]',
      }, 'TopBar'),
      React.createElement(
        'main',
        { key: 'main', id: 'main', className: 'flex-1 overflow-y-auto' },
        React.createElement(
          'div',
          { className: 'fade-in' },
          React.createElement(
            Modal,
            { open, onClose, width: 420, labelledBy: 'shell-modal-title' },
            React.createElement(ModalClose, { key: 'x', onClose, label: 'Close' }),
            React.createElement('h2', { key: 'h', id: 'shell-modal-title' }, 'Unlock vault'),
            React.createElement('input', { key: 'f', id: 'vault-key', type: 'password', 'data-modal-autofocus': '', readOnly: true, defaultValue: '' }),
          ),
        ),
      ),
    ),
  )
}

function mount() {
  const host = doc().createElement('div')
  host.id = 'root'
  doc().body.appendChild(host)
  const root = createRoot(host)
  return {
    async render(element) { await act(async () => root.render(element)) },
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

/* ── the portal ───────────────────────────────────────────────────── */

test('the modal renders through a global portal root on document.body, not inside the screen subtree', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(ShellWithModal, { open: true }))

    const modalRoot = doc().getElementById('aegis-modal-root')
    assert.ok(modalRoot, 'an explicit application-level modal root exists')
    assert.equal(modalRoot.parentElement, doc().body, 'and it is a direct child of <body>')
    assert.equal(modalRoot.getAttribute('data-aegis-modal-root'), '')

    const dialog = doc().querySelector('[role="dialog"]')
    assert.ok(dialog, 'the dialog rendered')
    assert.ok(modalRoot.contains(dialog), 'the dialog lives in the modal root')

    // The critical structural claim: the modal is NOT inside the screen subtree
    // whose stacking context trapped it.
    assert.equal(doc().getElementById('main').contains(dialog), false, 'not under <main>')
    assert.equal(doc().querySelector('.fade-in').contains(dialog), false, 'not under the animated screen wrapper')
    assert.equal(doc().getElementById('root').contains(dialog), false, 'not under the React host at all')
  } finally {
    await h.unmount()
  }
})

test('exactly one scrim is present, and it is a fixed full-viewport layer', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(ShellWithModal, { open: true }))

    const layers = doc().querySelectorAll('.modal-layer')
    assert.equal(layers.length, 1, 'one modal layer')
    const scrims = doc().querySelectorAll('.modal-scrim')
    assert.equal(scrims.length, 1, 'exactly one scrim — never one per screen')

    assert.equal(scrims[0].getAttribute('aria-hidden'), 'true', 'the scrim is not announced')
    assert.equal(layers[0].parentElement.id, 'aegis-modal-root')
    assert.ok(layers[0].contains(scrims[0]))
    assert.ok(layers[0].contains(doc().querySelector('[role="dialog"]')))
  } finally {
    await h.unmount()
  }
})

test('the modal layer outranks the sticky shell surfaces it must cover', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(ShellWithModal, { open: true }))

    const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf8')
    const tokenValue = (name) => Number(new RegExp(`--${name}:\\s*(\\d+)`).exec(css)?.[1])
    const zModal = tokenValue('z-modal')
    const zSticky = tokenValue('z-sticky')
    const zDrawer = tokenValue('z-drawer')

    assert.ok(Number.isFinite(zModal) && Number.isFinite(zSticky), 'the z-scale tokens still exist')
    assert.ok(zModal > zSticky, `the modal layer (${zModal}) must sit above the sticky TopBar (${zSticky})`)
    assert.ok(zModal > zDrawer, `and above the mobile Sidebar drawer (${zDrawer})`)

    // The layer takes its z-index from that token in CSS, not from an inline
    // number sprinkled into a screen.
    assert.match(css, /\.modal-layer\s*\{[^}]*z-index:\s*var\(--z-modal\)/s)
    const dialog = doc().querySelector('[role="dialog"]')
    assert.equal(dialog.style.zIndex, '', 'the dialog claims no ad-hoc z-index of its own')
    assert.equal(doc().querySelector('.modal-scrim').style.zIndex, '')
  } finally {
    await h.unmount()
  }
})

test('closing the modal removes the layer but leaves the portal root in place', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(ShellWithModal, { open: true }))
    assert.equal(doc().querySelectorAll('.modal-layer').length, 1)

    await h.render(React.createElement(ShellWithModal, { open: false }))
    assert.equal(doc().querySelector('[role="dialog"]'), null, 'a closed modal renders nothing')
    assert.equal(doc().querySelectorAll('.modal-scrim').length, 0, 'and leaves no orphaned scrim')
    assert.ok(doc().getElementById('aegis-modal-root'), 'the reusable root stays')
  } finally {
    await h.unmount()
  }
})

test('two modals from the same screen never stack two scrims at once', async () => {
  // Vault renders three <Modal> elements (unlock, setup, delete) and gates them
  // on one piece of state. Only the open one may contribute a scrim.
  const h = mount()
  try {
    await h.render(React.createElement(
      'div',
      null,
      React.createElement(Modal, { key: 'a', open: true, onClose() {}, labelledBy: 'a' },
        React.createElement('h2', { id: 'a' }, 'One')),
      React.createElement(Modal, { key: 'b', open: false, onClose() {}, labelledBy: 'b' },
        React.createElement('h2', { id: 'b' }, 'Two')),
      React.createElement(Modal, { key: 'c', open: false, onClose() {}, labelledBy: 'c' },
        React.createElement('h2', { id: 'c' }, 'Three')),
    ))
    assert.equal(doc().querySelectorAll('.modal-scrim').length, 1)
    assert.equal(doc().querySelectorAll('[role="dialog"]').length, 1)
  } finally {
    await h.unmount()
  }
})

/* ── PR #38 focus behaviour survives the portal ───────────────────── */

test('the portal does not regress initial autofocus, Escape, scrim click, or the close button', async () => {
  const h = mount()
  try {
    let closed = 0
    await h.render(React.createElement(ShellWithModal, { open: true, onClose: () => { closed += 1 } }))

    assert.equal(doc().activeElement.id, 'vault-key', 'focus still lands on the data-modal-autofocus field')

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(closed, 1, 'Escape still closes')

    await act(async () => {
      doc().querySelector('.modal-scrim').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(closed, 2, 'the scrim click still closes')

    const close = doc().querySelector('[aria-label="Close"]')
    assert.equal(close.getAttribute('tabindex'), null, 'the close button stays in the tab order')
    await act(async () => close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(closed, 3, 'the close button still closes')
  } finally {
    await h.unmount()
  }
})

test('reopening through the portal performs initial autofocus again', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(ShellWithModal, { open: true }))
    assert.equal(doc().activeElement.id, 'vault-key')

    await h.render(React.createElement(ShellWithModal, { open: false }))
    doc().body.focus?.()

    await h.render(React.createElement(ShellWithModal, { open: true }))
    assert.equal(doc().activeElement.id, 'vault-key', 'a fresh open re-runs initial focus')
  } finally {
    await h.unmount()
  }
})

test('a re-render with a new inline onClose identity does not move focus or duplicate the scrim', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(ShellWithModal, { open: true, onClose() {} }))
    const close = doc().querySelector('[aria-label="Close"]')
    close.focus()
    assert.equal(doc().activeElement, close)

    await h.render(React.createElement(ShellWithModal, { open: true, onClose() {} }))
    assert.equal(doc().activeElement, close, 'onCloseRef semantics survive the portal')
    assert.equal(doc().querySelectorAll('.modal-scrim').length, 1, 'and the portal did not re-mount a second layer')
  } finally {
    await h.unmount()
  }
})

/* ── static style contract ────────────────────────────────────────── */

test('the backdrop dim and blur are one shared scrim treatment, not per-screen inline styles', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf8')
  const rule = /\.modal-scrim\s*\{([^}]*)\}/s.exec(css)
  assert.ok(rule, '.modal-scrim is defined in the stylesheet')
  const body = rule[1]

  assert.match(body, /position:\s*fixed|position:\s*absolute/, 'the scrim is positioned')
  assert.match(body, /inset:\s*0/, 'and covers the full layer')
  assert.match(body, /background:\s*var\(--modal-scrim\)/, 'the dim comes from a token')
  assert.match(body, /backdrop-filter:\s*blur\(var\(--modal-blur\)\)/, 'the blur is declared here, once')
  assert.match(body, /-webkit-backdrop-filter:\s*blur\(var\(--modal-blur\)\)/, 'with the WebKit prefix for Safari')
})

test('the blur stays restrained (2–4px) and both themes define a readable dim', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf8')

  const blur = /--modal-blur:\s*([\d.]+)px/.exec(css)
  assert.ok(blur, '--modal-blur is a design token, not a magic number in a component')
  const px = Number(blur[1])
  assert.ok(px >= 2 && px <= 4, `restrained blur expected, got ${px}px — a heavy frosted-glass panel is not the intent`)

  // Light theme dims with the ink colour; dark theme cannot reuse that formula
  // because --ink is near-white there, so it gets its own value.
  const lightRoot = /:root\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(/--modal-scrim:/.test(lightRoot[1]), 'the light theme defines --modal-scrim')

  const darkRoot = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(darkRoot, 'the dark theme block still exists')
  assert.ok(/--modal-scrim:/.test(darkRoot[1]), 'the dark theme overrides --modal-scrim so the shell dims rather than washes out')
})

test('nothing blurs the TopBar on its own — the coherent layer is the whole point', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf8')
  const topbar = fs.readFileSync(path.join(rootDir, 'src/components/TopBar.jsx'), 'utf8')

  assert.doesNotMatch(topbar, /backdrop-filter|backdropFilter/, 'the TopBar declares no blur of its own')

  // The only backdrop-filter that actually blurs is the shared scrim; the modal
  // card explicitly opts out so the dialog stays crisp.
  const blurring = [...css.matchAll(/(^|\n)([^\n{}]+)\{([^}]*backdrop-filter:[^}]*)\}/g)]
    .filter(([, , , decls]) => [...decls.matchAll(/backdrop-filter:\s*([^;]+)/g)]
      .some(([, value]) => value.trim() !== 'none'))
    .map(([, , selector]) => selector.trim())
  assert.deepEqual([...new Set(blurring)], ['.modal-scrim'], 'exactly one blurring rule in the stylesheet')

  assert.match(css, /\.modal-card\s*\{[^}]*backdrop-filter:\s*none/s, 'the dialog card itself is never frosted')
})

test('reduced motion keeps the dim and blur and only drops the entrance animation', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf8')
  const block = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.modal-scrim,\s*\n\s*\.modal-card\s*\{([^}]*)\}/.exec(css)
  assert.ok(block, 'reduced motion addresses the modal layer explicitly')
  assert.match(block[1], /animation:\s*none/, 'the entrance animation is removed')
  assert.doesNotMatch(block[1], /backdrop-filter|background/, 'but the dim and blur are static and stay')
})

test('the shared Modal no longer carries the retired "NO backdrop blur" contract', () => {
  const ui = fs.readFileSync(path.join(rootDir, 'src/components/ui.jsx'), 'utf8')
  assert.doesNotMatch(ui, /NO backdrop blur/, 'the superseded product decision is not left as a stale instruction')
  assert.match(ui, /createPortal/, 'the Modal portals rather than relying on z-index luck')
  assert.doesNotMatch(ui, /zIndex:\s*'?\d{3,}/, 'no arbitrary very-large z-index was introduced')
})

test('no screen fixes its own modal layering with a private z-index', () => {
  const vault = fs.readFileSync(path.join(rootDir, 'src/screens/Vault.jsx'), 'utf8')
  assert.doesNotMatch(vault, /z-\[?\s*\d{3,}/, 'Vault.jsx does not raise a huge z-index of its own')
  assert.doesNotMatch(vault, /var\(--z-modal\)/, 'Vault.jsx does not reach into the modal layer directly')
  assert.doesNotMatch(vault, /modal-scrim|backdrop-filter/, 'and does not duplicate the scrim treatment')
})
