// Shared jsdom harness for the Private Vault screen suites.
//
// react-dom captures `canUseDOM` at import time, so the jsdom globals must be
// installed before it is loaded — that ordering is the whole reason this lives
// in one place instead of being copy-pasted per suite.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createServer, normalizePath } from 'vite'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const backendStub = normalizePath(path.join(rootDir, 'tests/fixtures/vaultScreenBackend.js'))

// Every module the Vault screen (and the shared ui.jsx it renders) reaches the
// network or the crypto engine through. All three resolve to one fixture.
const STUBBED = new Set(['../lib/hooks.js', '../lib/api.js', '../lib/vaultCrypto.js'])

export async function startVaultScreenEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/drive/vault',
    pretendToBeVisual: true,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  // The download path calls bare `URL.createObjectURL`, which in an SSR-loaded
  // module resolves to Node's global URL, not jsdom's. Patch both so the test
  // observes the same call the browser would make.
  const objectUrls = []
  const createObjectURL = () => {
    const url = `blob:mock/${objectUrls.length}`
    objectUrls.push(url)
    return url
  }
  const revokeObjectURL = () => {}
  const restoreUrl = { create: globalThis.URL.createObjectURL, revoke: globalThis.URL.revokeObjectURL }
  globalThis.URL.createObjectURL = createObjectURL
  globalThis.URL.revokeObjectURL = revokeObjectURL
  dom.window.URL.createObjectURL = createObjectURL
  dom.window.URL.revokeObjectURL = revokeObjectURL
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

  // jsdom cannot navigate, and the download path finishes with a real
  // `<a download>` click. Swallow the navigation only — the click itself, and
  // everything the screen did to produce it, is still exercised.
  dom.window.document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[href]')
    if (anchor && anchor.getAttribute('href')?.startsWith('blob:')) event.preventDefault()
  }, true)

  const { createRoot } = await import('react-dom/client')

  const vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [{
      name: 'vault-screen-backend-stub',
      enforce: 'pre',
      resolveId: (source) => (STUBBED.has(source) ? backendStub : null),
    }],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
  })

  const { Vault } = await vite.ssrLoadModule('/src/screens/Vault.jsx')

  return {
    dom,
    Vault,
    objectUrls,
    async stop() {
      globalThis.URL.createObjectURL = restoreUrl.create
      globalThis.URL.revokeObjectURL = restoreUrl.revoke
      await vite.close()
      delete globalThis.IS_REACT_ACT_ENVIRONMENT
      dom.window.close()
    },
    mount() {
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      return {
        async render(element) { await act(async () => root.render(element)) },
        async unmount() {
          await act(async () => root.unmount())
          host.remove()
        },
      }
    },
  }
}

/* ── interaction helpers ──────────────────────────────────────────── */

/** Let queued promise chains (apiFetch → setState → effect) finish. */
export async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
}

export async function click(dom, el) {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  await settle()
}

export async function pressKey(dom, key, target) {
  await act(async () => {
    const node = target ?? dom.window.document.body
    node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await settle()
}

/** Real typing through the native setter, so the controlled onChange fires. */
export async function type(dom, input, text) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  for (const char of text) {
    await act(async () => {
      setter.call(input, input.value + char)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
}

export const byText = (dom, selector, text) =>
  [...dom.window.document.querySelectorAll(selector)].find((el) => el.textContent.trim() === text)

export const byTextContaining = (dom, selector, text) =>
  [...dom.window.document.querySelectorAll(selector)].find((el) => el.textContent.includes(text))

/** One element per rendered vault tile — the honest way to count cards. */
export const tileMenuButtons = (dom) => [...dom.window.document.querySelectorAll('[data-vault-tile-menu]')]

export const tileIds = (dom) => tileMenuButtons(dom).map((b) => b.getAttribute('data-vault-tile-menu'))

/** Drive the real <input type="file"> the screen renders. */
export async function uploadFile(dom, { name, type: mime = 'image/gif', body = 'bytes' }) {
  const input = dom.window.document.querySelector('input[type="file"]')
  if (!input) throw new Error('the unlocked vault should render a file input')
  const file = new dom.window.File([body], name, { type: mime })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  await settle()
}

/**
 * The whole unlock interaction: open the modal, type the key, submit.
 * `t` is the real string table, so a copy change breaks this loudly instead of
 * silently selecting the wrong button.
 */
export async function unlock(dom, t, passphrase) {
  const cta = byText(dom, 'button', t('unlockVault'))
  if (!cta) throw new Error('a configured, locked vault should offer Unlock vault')
  await click(dom, cta)
  const field = dom.window.document.getElementById('vault-key')
  if (!field) throw new Error('the unlock modal should render the vault key field')
  await type(dom, field, passphrase)
  await click(dom, byText(dom, 'button', t('decrypt')))
}

export async function lockVault(dom, t) {
  const btn = byText(dom, 'button', t('lockVault'))
  if (!btn) throw new Error('an unlocked vault should offer Lock vault')
  await click(dom, btn)
}
