// Regression cover for the production Private Vault bug: typing one character
// in the vault setup modal moved focus to the top-right close button, so the
// rest of the passphrase never reached the field.
//
// Two defects combined in the shared Modal:
//   1. the autofocus effect depended on `onClose`, which every screen passes as
//      an inline arrow (`onClose={() => setModal(null)}`), so a controlled-input
//      re-render gave it a new identity and re-ran initial focus; and
//   2. `querySelector('input, button')` returns the first match in document
//      order, and ModalClose is rendered before the form, so the close X won.
import assert from 'node:assert/strict'
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
  // react-dom captures `canUseDOM` at import time and falls back to a legacy
  // change-event path when it is false, which silently swallows simulated
  // typing. The jsdom globals therefore have to exist before it is loaded.
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
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

/* ── harness ──────────────────────────────────────────────────────── */

function mount() {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  return {
    root,
    async render(element) {
      await act(async () => root.render(element))
    },
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
      dom.window.document.body.focus?.()
    },
  }
}

// A stable, cheap description of the focused element. Comparing DOM nodes with
// assert.equal serialises the whole tree on failure, which is unreadable.
function focused() {
  const el = dom.window.document.activeElement
  if (!el || el === dom.window.document.body) return 'body'
  return `${el.tagName.toLowerCase()}#${el.id || '-'}@${el.getAttribute('aria-label') ?? '-'}`
}

// Real typing, not a state poke: drive the value through the native setter and
// dispatch the input event so the controlled onChange actually fires.
async function type(input, text) {
  const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  for (const char of text) {
    await act(async () => {
      nativeSetter.call(input, input.value + char)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
}

async function pressEscape() {
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/* A faithful stand-in for the Vault setup modal: ModalClose first in DOM order,
   a controlled passphrase field after it, and an inline onClose whose identity
   changes on every render — exactly the shape that broke in production. */
function VaultLikeModal({ open, onClose, autofocusMarker = true }) {
  const [value, setValue] = React.useState('')
  return React.createElement(
    Modal,
    { open, onClose: () => onClose(), width: 460, labelledBy: 'setup-title' },
    React.createElement(ModalClose, { key: 'close', onClose: () => onClose(), label: 'Close' }),
    React.createElement('h2', { key: 'title', id: 'setup-title' }, 'Set up vault'),
    React.createElement('input', {
      key: 'field',
      id: 'vault-new-key',
      type: 'password',
      value,
      onChange: (e) => setValue(e.target.value),
      ...(autofocusMarker ? { 'data-modal-autofocus': '' } : {}),
    }),
    React.createElement('button', { key: 'submit', type: 'button' }, 'Create vault'),
  )
}

/* ── the regression ───────────────────────────────────────────────── */

test('opening the vault setup modal focuses the passphrase field, not the close button', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose() {} }))
    assert.equal(focused(), 'input#vault-new-key@-')
  } finally {
    await h.unmount()
  }
})

test('typing a passphrase never hands focus to the close button', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose() {} }))
    const input = dom.window.document.getElementById('vault-new-key')
    input.focus()
    assert.equal(focused(), 'input#vault-new-key@-')

    await type(input, 'correct-horse-battery')

    assert.equal(input.value, 'correct-horse-battery', 'every character reached the controlled field')
    assert.equal(focused(), 'input#vault-new-key@-', 'focus stayed in the passphrase field across re-renders')
  } finally {
    await h.unmount()
  }
})

test('a re-render from the owner screen does not re-run initial focus', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose() {} }))
    const submit = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Create vault')
    submit.id = 'submit'
    submit.focus()
    assert.equal(focused(), 'button#submit@-')

    // A brand-new inline onClose identity, exactly like onClose={() => setModal(null)}.
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose() {} }))
    assert.equal(focused(), 'button#submit@-', 'a new onClose identity must not move focus')
  } finally {
    await h.unmount()
  }
})

test('without an explicit marker the first form control still beats the close button', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose() {}, autofocusMarker: false }))
    assert.equal(focused(), 'input#vault-new-key@-')
  } finally {
    await h.unmount()
  }
})

test('data-modal-autofocus wins over an earlier form control', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(
      Modal,
      { open: true, onClose() {}, labelledBy: 'm' },
      React.createElement(ModalClose, { key: 'x', onClose() {} }),
      React.createElement('h2', { key: 'h', id: 'm' }, 'Filter'),
      React.createElement('input', { key: 'a', id: 'first', readOnly: true, defaultValue: '' }),
      React.createElement('input', { key: 'b', id: 'second', 'data-modal-autofocus': '', readOnly: true, defaultValue: '' }),
    ))
    assert.equal(focused(), 'input#second@-')
  } finally {
    await h.unmount()
  }
})

test('a disabled form control is skipped for initial focus', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(
      Modal,
      { open: true, onClose() {}, labelledBy: 'd' },
      React.createElement(ModalClose, { key: 'x', onClose() {} }),
      React.createElement('h2', { key: 'h', id: 'd' }, 'Busy'),
      React.createElement('input', { key: 'a', id: 'locked', disabled: true, readOnly: true, defaultValue: '' }),
      React.createElement('input', { key: 'b', id: 'open-field', readOnly: true, defaultValue: '' }),
    ))
    assert.equal(focused(), 'input#open-field@-')
  } finally {
    await h.unmount()
  }
})

test('Escape always reaches the current onClose callback', async () => {
  const h = mount()
  try {
    const calls = []
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose: () => calls.push('stale') }))
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose: () => calls.push('current') }))
    await pressEscape()
    assert.deepEqual(calls, ['current'], 'the latest onClose ran, not the one captured when the modal opened')
  } finally {
    await h.unmount()
  }
})

test('Escape stops closing once the modal is closed', async () => {
  const h = mount()
  try {
    let closed = 0
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose: () => { closed += 1 } }))
    await h.render(React.createElement(VaultLikeModal, { open: false, onClose: () => { closed += 1 } }))
    await pressEscape()
    assert.equal(closed, 0, 'the keydown listener is removed with the modal')
  } finally {
    await h.unmount()
  }
})

test('the close button still closes the modal and stays keyboard reachable', async () => {
  const h = mount()
  try {
    let closed = 0
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose: () => { closed += 1 } }))
    const close = dom.window.document.querySelector('[aria-label="Close"]')
    assert.ok(close, 'ModalClose renders a labelled control')
    assert.equal(close.tagName, 'BUTTON')
    assert.equal(close.getAttribute('tabindex'), null, 'close button is not removed from the tab order')
    assert.equal(close.disabled, false)

    close.focus()
    assert.equal(focused(), 'button#-@Close', 'the close button can still take focus')

    await act(async () => close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(closed, 1)
  } finally {
    await h.unmount()
  }
})

test('clicking the scrim closes through the current callback', async () => {
  const h = mount()
  try {
    const calls = []
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose: () => calls.push('stale') }))
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose: () => calls.push('current') }))
    const scrim = dom.window.document.querySelector('[aria-hidden="true"]')
    await act(async () => scrim.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(calls, ['current'])
  } finally {
    await h.unmount()
  }
})

test('reopening the modal performs initial focus again', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(VaultLikeModal, { open: true, onClose() {} }))
    assert.equal(focused(), 'input#vault-new-key@-')

    await h.render(React.createElement(VaultLikeModal, { open: false, onClose() {} }))
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null, 'a closed modal renders nothing')

    await h.render(React.createElement(VaultLikeModal, { open: true, onClose() {} }))
    assert.equal(focused(), 'input#vault-new-key@-', 'a fresh open re-runs initial focus')
  } finally {
    await h.unmount()
  }
})

test('a confirm-style modal with no form control stays keyboard accessible', async () => {
  const h = mount()
  try {
    let closed = 0
    await h.render(React.createElement(
      Modal,
      { open: true, onClose: () => { closed += 1 }, labelledBy: 'confirm-title' },
      React.createElement(ModalClose, { key: 'x', onClose: () => { closed += 1 } }),
      React.createElement('h2', { key: 'h', id: 'confirm-title' }, 'Revoke share'),
      React.createElement('button', { key: 'cancel', id: 'cancel', type: 'button' }, 'Cancel'),
      React.createElement('button', { key: 'confirm', id: 'confirm', type: 'button' }, 'Revoke'),
    ))
    assert.equal(dom.window.document.activeElement.tagName, 'BUTTON', 'focus still lands on a real control')
    assert.ok(dom.window.document.querySelector('#cancel'))
    assert.ok(dom.window.document.querySelector('#confirm'))

    await pressEscape()
    assert.equal(closed, 1, 'Escape still closes a modal that has no form field')
  } finally {
    await h.unmount()
  }
})
