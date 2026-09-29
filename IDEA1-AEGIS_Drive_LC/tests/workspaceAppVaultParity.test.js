// tests/workspaceAppVaultParity.test.js — AEGIS Drive (IDEA1) · PR220-R2 corrective · real App Files ↔ Vault parity
//
// Human Acceptance on the PR220-R2 deployment failed two presentation checks that the
// isolated suites (nameEntryDialogParity mounts NewFolderDialog alone) could not see:
//
//   A  Vault "New Folder" must look exactly like Files "New Folder" (Files is the source of truth)
//   B  dragging external OS files over Vault must show the same drop affordance Files shows
//
// This suite mounts the REAL authenticated App with the REAL Files screen and the REAL
// Private Vault screen (Vault → VaultTreeScreen → VaultDialogs → NameEntryDialog). Only
// auth, transport and the Vault crypto/upload engines are stubbed — exactly the modules
// the Vault screen harness stubs — so every presentation decision under test is the
// production one. Both authorized roles run every check; neither may see a different UI.
//
//   APP-NF-1   (role) Vault New Folder, opened from the real toolbar, has the Files visual signature
//   APP-NF-2   (role) Vault validation stays caller-owned: sibling collision keeps the primary disabled
//   APP-DROP-1 (role) external drag over Vault paints the Files drop affordance (same classes, same geometry)
//   APP-DROP-2 (role) nested enter/leave does not flicker; leaving the surface, drop, Escape and window
//                     drop/dragend all clear it; the drop still enqueues exactly once through the old path
//   APP-DROP-3 (role) internal AEGIS item drags and the Trash view never advertise external upload;
//                     locking removes the surface with the tree
//   APP-DROP-4 Files keeps its PR220-R2 drop presentation byte-for-byte (source of truth pinned)
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { resetBackend } from './fixtures/themeTransitionBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { settle, click, type, unlock, lockVault } from './helpers/vaultScreenHarness.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => normalizePath(path.join(rootDir, 'tests/fixtures', name))
const t = makeT('th')   // the Human Acceptance screenshots are Thai

/* ── one jsdom for the file (react-dom captures canUseDOM at import) ─────── */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/files',
  pretendToBeVisual: true,
})
const W = dom.window
const GLOBALS = {
  window: W,
  document: W.document,
  navigator: W.navigator,
  localStorage: W.localStorage,
  sessionStorage: W.sessionStorage,
  HTMLElement: W.HTMLElement,
  Element: W.Element,
  Node: W.Node,
  MutationObserver: W.MutationObserver,
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
}
W.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
W.Element.prototype.scrollIntoView = () => {}
W.Element.prototype.animate = () => ({ cancel() {}, finish() {}, finished: Promise.resolve(), onfinish: null })
W.IntersectionObserver = GLOBALS.IntersectionObserver
W.ResizeObserver = GLOBALS.ResizeObserver
const previous = new Map()

/* every module the real App + Files + Vault reach the network or crypto engine through */
const STUBS = new Map([
  ['./lib/auth.js', 'appVaultAuth.js'], ['../lib/auth.js', 'appVaultAuth.js'],
  ['./lib/api.js', 'appVaultApi.js'], ['../lib/api.js', 'appVaultApi.js'], ['./api.js', 'appVaultApi.js'],
  ['../lib/vaultCrypto.js', 'vaultScreenBackend.js'], ['./vaultCrypto.js', 'vaultScreenBackend.js'],
  ['/src/lib/vaultCrypto.js', 'vaultScreenBackend.js'],
  ['../lib/vaultChunkCrypto.js', 'vaultScreenBackend.js'], ['./vaultChunkCrypto.js', 'vaultScreenBackend.js'],
  ['../lib/vaultChunkedUpload.js', 'vaultScreenBackend.js'], ['./vaultChunkedUpload.js', 'vaultScreenBackend.js'],
  ['../lib/vaultChunkedDownload.js', 'vaultScreenBackend.js'],
  // Files and Vault stay REAL; the other screens are irrelevant to these surfaces
  ...['Dashboard', 'Shares', 'FileHistory', 'Storage', 'Audit', 'Access']
    .map((screen) => [`./screens/${screen}.jsx`, 'appShellStubs.jsx']),
])

let vite
let App
let kek
let createRoot

before(async () => {
  for (const [key, value] of Object.entries(GLOBALS)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [
      { name: 'app-vault-stubs', enforce: 'pre', resolveId: (source) => (STUBS.has(source) ? fixture(STUBS.get(source)) : null) },
      reactPlugin(),
    ],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  App = (await vite.ssrLoadModule('/src/App.jsx')).default
  kek = await (await vite.ssrLoadModule('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
})

after(async () => {
  await vite?.close()
  for (const [key, descriptor] of previous) {
    if (descriptor === undefined) delete globalThis[key]
    else Object.defineProperty(globalThis, key, descriptor)
  }
  delete globalThis.__VAULT_BACKEND__
  delete globalThis.__AEGIS_WORKSPACE_FILES__
  W.close()
})

const NOW = Date.UTC(2026, 8, 27, 9, 0, 0)
let backend
let uploads

beforeEach(async () => {
  globalThis.__AEGIS_WORKSPACE_FILES__ = [
    { id: 'd1', name: 'Projects', kind: 'folder', type: 'Folder', ext: '', size: 0, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null },
    { id: 'doc1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf', size: 1024, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null },
  ]
  const fakeTree = await createFakeTreeServer({ kek })
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  const inner = backend.respond
  backend.respond = async (req) => {
    const p = String(req.path)
    if (p.startsWith('/api/vault/tree/') && !p.startsWith('/api/vault/tree/state') && !p.startsWith('/api/vault/tree/migration')) {
      return fakeTree.fetchJson(p, { method: req.method, body: req.options?.body, signal: req.options?.signal })
    }
    return inner(req)
  }
  backend.respondBytes = async (req) => (String(req.path).startsWith('/api/vault/tree/')
    ? fakeTree.fetchBytes(String(req.path), { signal: req.options?.signal })
    : undefined)
  // the external drop's only observable effect on the transport: one queued upload per file
  uploads = []
  backend.uploadImpl = ({ file, signal }) => {
    uploads.push(file.name)
    return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  }
  globalThis.__VAULT_BACKEND__ = backend
})

/* ── mounting ────────────────────────────────────────────────────────────── */
const q = (sel) => W.document.querySelector(sel)
const qa = (sel) => [...W.document.querySelectorAll(sel)]

async function waitFor(predicate, what, ms = 6_000) {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await settle()
  assert.ok(predicate(), `${what} (page: ${W.document.body.textContent.slice(0, 400)})`)
}

async function navigate(pathname) {
  await act(async () => {
    W.history.pushState(null, '', pathname)
    W.dispatchEvent(new W.PopStateEvent('popstate'))
  })
  await settle()
}

async function mountApp(role) {
  resetBackend({ account: { language: 'th' }, user: { role }, restoreSession: true })
  W.history.replaceState(null, '', '/files')
  const root = createRoot(W.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(App)) })
  await waitFor(() => q('[data-file-id="doc1"][data-file-kind]'), 'the real Files grid renders inside the App shell')
  return {
    async openVault() {
      await navigate('/vault')
      await waitFor(() => [...qa('button')].some((b) => b.textContent.trim() === t('unlockVault')), 'the real Vault screen offers Unlock')
      await unlock(dom, t, CORRECT_PASSPHRASE)
      await waitFor(() => q('[data-testid="vault-tree-new-folder"]'), 'the unlocked TREE toolbar offers New Folder')
    },
    async unmount() {
      await act(async () => root.unmount())
      W.document.getElementById('root').replaceChildren()
      qa('#aegis-modal-root > *').forEach((n) => n.remove())
    },
  }
}

/* ── A: the create-folder visual signature ───────────────────────────────── */
function dialogSignature() {
  const dialog = q('[role="dialog"]')
  assert.ok(dialog, 'a dialog is open')
  const input = dialog.querySelector('input')
  const label = input?.id ? dialog.querySelector(`label[for="${input.id}"]`) : null
  const footer = input && [...dialog.querySelectorAll('div')].reverse().find((d) => d.querySelectorAll(':scope > button').length === 2)
  const [cancel, primary] = footer ? [...footer.querySelectorAll(':scope > button')] : []
  const close = [...dialog.querySelectorAll('button')].find((b) => /\babsolute\b/.test(b.className) && b.querySelector('svg'))
  return {
    width: dialog.style.maxWidth,
    shared: Boolean(dialog.querySelector('[data-name-entry-dialog]')),
    title: { className: dialog.querySelector('h2')?.className, text: dialog.querySelector('h2')?.textContent.trim() },
    label: label ? { className: label.className, text: label.textContent.trim() } : null,
    input: input ? { className: input.className, focused: W.document.activeElement === input } : null,
    close: close ? close.className : null,
    footer: footer ? footer.className : null,
    cancel: cancel ? { className: cancel.className, text: cancel.textContent.trim() } : null,
    primary: primary ? { className: primary.className, text: primary.textContent.trim(), disabled: primary.disabled } : null,
  }
}

async function closeDialog() {
  const dialog = q('[role="dialog"]')
  if (!dialog) return
  await act(async () => { W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await settle()
}

async function filesDialogSignature() {
  const btn = qa('button').find((b) => b.textContent.trim() === t('newFolder') && !b.closest('[role="dialog"]'))
  assert.ok(btn, 'Files toolbar offers New Folder')
  await click(dom, btn)
  const sig = dialogSignature()
  await closeDialog()
  return sig
}

for (const role of ['Admin', 'DataLake-User']) {
  test(`APP-NF-1 (${role}) Vault New Folder from the real toolbar has the Files create-folder signature`, async () => {
    const app = await mountApp(role)
    try {
      const files = await filesDialogSignature()
      // Files is the source of truth — pin what Human Acceptance approved
      assert.equal(files.width, '420px')
      assert.equal(files.title.text, 'โฟลเดอร์ใหม่')
      assert.equal(files.label?.text, 'ชื่อ', 'Files shows the visible "ชื่อ" label')
      assert.equal(files.primary?.text, 'โฟลเดอร์ใหม่')
      assert.equal(files.primary?.disabled, true, 'Files primary is disabled while the name is empty')

      await app.openVault()
      await click(dom, q('[data-testid="vault-tree-new-folder"]'))
      const vault = dialogSignature()
      assert.deepEqual(vault, files, 'Vault New Folder renders exactly the Files create-folder presentation')
    } finally { await app.unmount() }
  })

  test(`APP-NF-2 (${role}) Vault validation stays caller-owned inside the shared presentation`, async () => {
    const app = await mountApp(role)
    try {
      await app.openVault()
      await click(dom, q('[data-testid="vault-tree-new-folder"]'))
      await type(dom, q('[data-testid="vault-dialog-name-input"]'), 'Docs')
      assert.equal(q('[data-testid="vault-dialog-submit"]').disabled, false, 'a unique name enables Create')
      await click(dom, q('[data-testid="vault-dialog-submit"]'))
      await waitFor(() => qa('[data-testid="vault-folder-tile"]').some((el) => el.textContent.includes('Docs')), 'the folder is created through the Vault path')
      await click(dom, q('[data-testid="vault-tree-new-folder"]'))
      await type(dom, q('[data-testid="vault-dialog-name-input"]'), 'DOCS')
      assert.equal(q('[data-testid="vault-dialog-submit"]').disabled, true, 'case-folded sibling collision keeps the primary disabled')
      assert.ok(q('[data-testid="vault-dialog-error"]'), 'the Vault collision message is shown')
    } finally { await app.unmount() }
  })
}

/* ── B: the external-file drop affordance ────────────────────────────────── */
const FILES_TYPES = ['Files']
const INTERNAL_TYPES = ['application/x-aegis-items', 'text/uri-list', 'Files']   // Chrome adds Files to image-element drags

function drag(target, type, { types = FILES_TYPES, files = [], relatedTarget = null } = {}) {
  return act(async () => {
    const ev = new W.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { types, files, dropEffect: 'none', effectAllowed: 'all', getData: () => '', setData() {} } })
    Object.defineProperty(ev, 'relatedTarget', { value: relatedTarget })
    target.dispatchEvent(ev)
  })
}

/** the painted drop state inside `scope`: the outlined wrapper and its dashed overlay */
function dropAffordance(scope) {
  const overlay = [...scope.querySelectorAll('div')].find((d) => /\bborder-dashed\b/.test(d.className) && /\babsolute\b/.test(d.className))
  if (!overlay) return null
  const pill = overlay.querySelector('span')
  return {
    wrapper: overlay.parentElement,
    wrapperClass: overlay.parentElement.className.replace(/\s+/g, ' ').trim(),
    overlayClass: overlay.className,
    pillClass: pill?.className ?? null,
    icon: Boolean(pill?.querySelector('svg')),
    text: pill?.textContent.trim() ?? '',
  }
}

/** the Files drop wrapper: parent of its screen-reader drop hint (stable across refactors) */
function filesDropWrapper() {
  const hint = qa('p.sr-only').find((p) => p.textContent.trim() === t('filesDropHint'))
  assert.ok(hint, 'Files renders its drop hint')
  return hint.parentElement
}

/* Files' approved PR220-R2 presentation — the source of truth pinned verbatim */
const FILES_ACTIVE_WRAPPER = 'relative rounded-[var(--r-card)] transition-[outline-color,background-color] outline-2 outline-dashed outline-accent bg-[var(--accent-soft)]'
const FILES_OVERLAY = 'absolute inset-0 z-20 rounded-[var(--r-card)] border-2 border-dashed border-accent bg-[var(--accent-soft)] flex items-center justify-center pointer-events-none'
const FILES_PILL = 'inline-flex items-center gap-2 rounded-full bg-card px-4 py-2 text-[13px] font-semibold text-accent shadow-[var(--elev-1)]'

async function filesDropSignature() {
  const wrapper = filesDropWrapper()
  await drag(wrapper, 'dragenter')
  const sig = dropAffordance(wrapper.parentElement)
  await drag(wrapper, 'dragleave', { relatedTarget: W.document.body })
  return sig
}

const vaultScreen = () => q('[data-testid="vault-tree-screen"]')
function vaultWorkspace() {
  // populated: the tile workspace · empty folder: the empty-state card (reached through its own CTA)
  const ws = q('[data-testid="vault-tree-workspace"]') ?? q('[data-testid="vault-tree-new-folder-empty"]')?.parentElement
  assert.ok(ws, 'the Vault workspace (or its empty state) is rendered')
  return ws
}

/** a populated TREE workspace: one folder created through the real New Folder path */
async function createVaultFolder(name) {
  await click(dom, q('[data-testid="vault-tree-new-folder"]'))
  await type(dom, q('[data-testid="vault-dialog-name-input"]'), name)
  await click(dom, q('[data-testid="vault-dialog-submit"]'))
  await waitFor(() => q('[data-testid="vault-tree-workspace"]'), 'the populated Vault workspace renders')
}

test('APP-DROP-4 Files keeps its drop presentation (source of truth pinned)', async () => {
  const app = await mountApp('Admin')
  try {
    const files = await filesDropSignature()
    assert.ok(files, 'Files paints a drop affordance on external dragenter')
    assert.equal(files.wrapperClass, FILES_ACTIVE_WRAPPER)
    assert.equal(files.overlayClass, FILES_OVERLAY)
    assert.equal(files.pillClass, FILES_PILL)
    assert.equal(files.text, t('filesDropHint'))
    assert.equal(dropAffordance(filesDropWrapper().parentElement), null, 'leaving the Files surface clears it')
  } finally { await app.unmount() }
})

for (const role of ['Admin', 'DataLake-User']) {
  test(`APP-DROP-1 (${role}) external drag over Vault paints the Files drop affordance`, async () => {
    const app = await mountApp(role)
    try {
      const files = await filesDropSignature()
      await app.openVault()
      assert.equal(dropAffordance(vaultScreen()), null, 'idle Vault shows no drop affordance')
      // an empty folder is the most common drop moment — it must advertise the drop too
      await drag(vaultWorkspace(), 'dragenter')
      assert.ok(dropAffordance(vaultScreen()), 'the empty Vault folder paints the drop affordance')
      await drag(vaultWorkspace(), 'dragleave', { relatedTarget: W.document.body })
      await createVaultFolder('Docs')
      assert.equal(dropAffordance(vaultScreen()), null, 'idle populated Vault shows no drop affordance')
      await drag(vaultWorkspace(), 'dragenter')
      const vault = dropAffordance(vaultScreen())
      assert.ok(vault, 'external dragenter over the Vault workspace paints a drop affordance')
      assert.equal(vault.wrapperClass, files.wrapperClass, 'same outline + tint as Files')
      assert.equal(vault.overlayClass, files.overlayClass, 'same dashed full-surface overlay as Files')
      assert.equal(vault.pillClass, files.pillClass, 'same explanatory pill style as Files')
      assert.equal(vault.icon, files.icon, 'same upload icon as Files')
      assert.equal(vault.text, t('vaultDropHint'), 'Vault says truthfully where the files go')
      // geometry: the surface wraps the workspace inside the centered column, adding no box of its own
      assert.ok(vault.wrapper.contains(vaultWorkspace()), 'the affordance covers the Vault workspace')
      assert.ok(vaultScreen().contains(vault.wrapper), 'and stays inside the centered Vault column')
      assert.doesNotMatch(vault.wrapperClass, /\b(p|px|py|m|mx|my|w|max-w|min-w)-/, 'the surface adds no padding/margin/width that could move content')
    } finally { await app.unmount() }
  })

  test(`APP-DROP-2 (${role}) Vault drop state: no flicker, every exit clears it, drop enqueues once`, async () => {
    const app = await mountApp(role)
    try {
      await app.openVault()
      await createVaultFolder('Docs')
      const ws = vaultWorkspace()
      const inner = ws.querySelector('[data-testid="vault-tree-grid"]') ?? ws.firstElementChild ?? ws
      const active = () => Boolean(dropAffordance(vaultScreen()))

      // nested: enter child, then the parent reports leaving INTO the child → stays active
      await drag(ws, 'dragenter')
      await drag(inner, 'dragenter')
      await drag(ws, 'dragleave', { relatedTarget: inner })
      assert.equal(active(), true, 'moving between nested children does not flicker the affordance off')
      await drag(inner, 'dragover')
      assert.equal(active(), true, 'dragover keeps it active')

      // leaving the surface
      await drag(ws, 'dragleave', { relatedTarget: W.document.body })
      assert.equal(active(), false, 'leaving the workspace clears it')

      // Escape (drag cancelled) and window-level drop/dragend (drop landed elsewhere)
      await drag(ws, 'dragenter')
      await act(async () => { W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      assert.equal(active(), false, 'Escape clears it')
      await drag(ws, 'dragenter')
      await drag(W, 'dragend')
      assert.equal(active(), false, 'a drag that ends anywhere clears it')

      // a real drop clears it and still enqueues exactly once through the existing Vault path
      await drag(ws, 'dragenter')
      const file = new W.File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })
      await drag(inner, 'drop', { files: [file] })
      assert.equal(active(), false, 'drop clears it')
      await waitFor(() => uploads.length > 0, 'the dropped file reaches the Vault upload transport')
      await settle()
      assert.deepEqual(uploads, ['photo.jpg'], 'one drop = one queued upload (no double handling)')
    } finally { await app.unmount() }
  })

  test(`APP-DROP-3 (${role}) internal drags, the Trash view and lock never advertise external upload`, async () => {
    const app = await mountApp(role)
    try {
      await app.openVault()
      await drag(vaultWorkspace(), 'dragenter', { types: INTERNAL_TYPES })
      await drag(vaultWorkspace(), 'dragover', { types: INTERNAL_TYPES })
      assert.equal(dropAffordance(vaultScreen()), null, 'an internal AEGIS item drag is a move, never an upload affordance')

      const view = q('[data-testid="vault-workspace-view"]')
      await act(async () => {
        Object.getOwnPropertyDescriptor(W.HTMLSelectElement.prototype, 'value').set.call(view, 'trash')
        view.dispatchEvent(new W.Event('change', { bubbles: true }))
      })
      await settle()
      await drag(vaultScreen(), 'dragenter')
      await drag(vaultScreen(), 'dragover')
      assert.equal(dropAffordance(vaultScreen()), null, 'Trash never advertises external upload')

      await act(async () => {
        Object.getOwnPropertyDescriptor(W.HTMLSelectElement.prototype, 'value').set.call(view, 'active')
        view.dispatchEvent(new W.Event('change', { bubbles: true }))
      })
      await settle()
      await drag(vaultWorkspace(), 'dragenter')
      assert.ok(dropAffordance(vaultScreen()), 'back in the active view the affordance returns')
      await lockVault(dom, t)
      await settle()
      assert.equal(vaultScreen(), null, 'lock unmounts the tree')
      assert.equal(qa('div').some((d) => /\bborder-dashed\b/.test(d.className) && /\babsolute\b/.test(d.className) && d.textContent.includes(t('vaultDropHint'))), false, 'no drop affordance survives the lock')
    } finally { await app.unmount() }
  })
}
