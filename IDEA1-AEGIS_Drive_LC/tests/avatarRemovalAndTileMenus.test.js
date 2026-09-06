// tests/avatarRemovalAndTileMenus.test.js — AEGIS Drive (IDEA1)
//
// Three UI regressions that shared one shape: the browser, not the app, was
// deciding what the user saw.
//
// 1. Removing the profile picture left it on screen. The avatar URL is constant
//    and `GET /api/users/:id/avatar` answers `Cache-Control: private,
//    max-age=60`, so after a successful DELETE the browser kept serving the old
//    bytes — through a React remount (same URL), through a refresh, and through
//    logout/login inside that window. The screen also asked the server nothing:
//    it rendered an <img> and waited for a 404 that the cache never delivered.
//
// 2. + 3. The Files and Private Vault tile menus were positioned inside the
//    tile. The Vault tile is `overflow-hidden` (its ciphertext veil is a
//    clip-path layer), so the tile clipped its own menu; and both tiles create
//    stacking contexts, so a menu could be painted under a neighbouring tile.
//    Neither is fixable by changing coordinates — the menu has to be drawn
//    outside the tile.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let dom
let createRoot
let vite
let Avatar
let AnchoredMenu

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
  ;({ Avatar, AnchoredMenu } = await vite.ssrLoadModule('/src/components/ui.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  dom?.window.close()
})

async function mount(element) {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  return {
    host,
    img: () => dom.window.document.querySelector('img'),
    async rerender(next) { await act(async () => root.render(next)) },
    async unmount() { await act(async () => root.unmount()); host.remove() },
  }
}

/* ── 1. the avatar the server says is gone is never requested ── */

test('AVATAR-1 hasAvatar=false renders no <img> at all, so the HTTP cache cannot resurrect it', async () => {
  const screen = await mount(React.createElement(Avatar, { userId: '7', name: 'Kanya Srisai', hasAvatar: false }))
  try {
    assert.equal(screen.img(), null, 'no image element is created when the server says there is none')
    // The fallback is the initials, which must still be present and readable.
    assert.match(screen.host.textContent, /KS/, 'the initials fallback renders instead')
  } finally {
    await screen.unmount()
  }
})

test('AVATAR-2 removal takes effect on re-render alone — no remount, no cache-buster needed', async () => {
  const withPicture = React.createElement(Avatar, { userId: '7', name: 'Kanya Srisai', hasAvatar: true, version: 'abc123' })
  const screen = await mount(withPicture)
  try {
    assert.ok(screen.img(), 'an avatar is requested while one exists')

    // Exactly what the session update after a successful DELETE produces.
    await screen.rerender(React.createElement(Avatar, { userId: '7', name: 'Kanya Srisai', hasAvatar: false, version: null }))
    assert.equal(screen.img(), null, 'the picture disappears from the same mounted component')
  } finally {
    await screen.unmount()
  }
})

test('AVATAR-3 a replaced picture gets a distinct URL, so a cached one cannot win', async () => {
  const screen = await mount(React.createElement(Avatar, { userId: '7', name: 'K S', hasAvatar: true, version: 'v1' }))
  try {
    const first = screen.img().getAttribute('src')
    await screen.rerender(React.createElement(Avatar, { userId: '7', name: 'K S', hasAvatar: true, version: 'v2' }))
    const second = screen.img().getAttribute('src')

    assert.notEqual(first, second, 'a new version means a new URL')
    assert.match(second, /[?&]v=v2/, 'the version travels in the query string')
  } finally {
    await screen.unmount()
  }
})

test('AVATAR-4 other people’s avatars keep the original blind-load + 404 fallback', async () => {
  // Access/Files render avatars for users whose hasAvatar the client never
  // learns. Those must keep asking, or every other user would lose their photo.
  const screen = await mount(React.createElement(Avatar, { userId: '9', name: 'Somchai P' }))
  try {
    assert.ok(screen.img(), 'an unknown hasAvatar still requests the image')
    assert.doesNotMatch(screen.img().getAttribute('src'), /[?&]v=/, 'and carries no version it does not have')
  } finally {
    await screen.unmount()
  }
})

/* ── the server has to actually supply those facts ── */

test('AVATAR-5 the session payload carries hasAvatar and an opaque version', () => {
  const api = fs.readFileSync(path.join(rootDir, 'server/routes/api.js'), 'utf8')

  assert.match(api, /hasAvatar: Boolean\(u\.avatarKey\)/, 'publicUser reports whether a picture exists')
  assert.match(api, /avatarVersion: avatarVersionOf\(u\.avatarKey\)/)

  // The version must be a hash, never the storage key itself — that key is a
  // real path inside the Storage Layer.
  assert.match(api, /createHash\('sha256'\)\.update\(String\(key\)\)/, 'the version is a hash of the key')
  assert.doesNotMatch(api, /avatarKey: u\.avatarKey/, 'the raw storage key never leaves the server')
})

// AVATAR-6 used to assert, by regex, that each avatar route called a
// specifically-named session setter. That is the wrong altitude: it pinned an
// internal helper name rather than the behaviour, so refactoring the two call
// sites into one shared helper broke the test while the product was correct —
// and, worse, it would still have passed while /api/me returned the wrong
// answer, because it never called /api/me.
//
// The behaviour it was reaching for is now covered end to end, through the
// real app, real sessions and real cookies, in
// tests/avatarSessionPersistence.test.js:
//
//   AVATAR-SESSION-A  a fresh login keeps an avatar that exists in the DB
//   AVATAR-SESSION-B  the login response and /api/me agree
//   AVATAR-SESSION-C  upload is visible on /api/me and stays visible
//   AVATAR-SESSION-D  delete clears it on /api/me
//   AVATAR-SESSION-E  a repeat delete still leaves the session reconciled
//   AVATAR-SESSION-F  a stale second session is corrected, not left asserting
//   AVATAR-SESSION-G  removal survives a real logout/login round trip
//   AVATAR-SESSION-H  no storage key or filename reaches the client
//   AVATAR-SESSION-I  replacing the picture changes the version

test('AVATAR-7 Settings publishes the change to the session, not just to its own card', () => {
  const settings = fs.readFileSync(path.join(rootDir, 'src/screens/Settings.jsx'), 'utf8')
  const topbar = fs.readFileSync(path.join(rootDir, 'src/components/TopBar.jsx'), 'utf8')

  // The TopBar reads the session user, so a card-local state bump could never
  // have updated it — that is why the picture stayed in the corner.
  assert.match(settings, /onSaved\?\.\(\{ \.\.\.user, hasAvatar: false, avatarVersion: null \}\)/)
  assert.match(settings, /onSaved\?\.\(\{ \.\.\.user, hasAvatar: true, avatarVersion: res\.data\?\.avatarVersion \?\? null \}\)/)
  assert.doesNotMatch(settings, /avatarBust/, 'the remount hack is gone — it never defeated the cache')

  assert.match(topbar, /hasAvatar=\{user\.hasAvatar\}/, 'the TopBar avatar is driven by the session')
  assert.match(topbar, /version=\{user\.avatarVersion\}/)
})

/* ── 2. + 3. the tile menus are drawn outside the tile ── */

test('MENU-1 the menu renders outside its anchor’s subtree, so no tile can clip it', async () => {
  const anchorRef = { current: null }
  function Harness() {
    const ref = React.useRef(null)
    anchorRef.current = ref
    return React.createElement(
      'div',
      // The exact trap: a clipping, stacking-context-forming tile.
      { style: { overflow: 'hidden', transform: 'translateY(-2px)' }, id: 'tile' },
      React.createElement('button', { ref, type: 'button' }, 'more'),
      React.createElement(AnchoredMenu, { open: true, anchorRef: ref, onClose() {}, label: 'More actions' },
        React.createElement('button', { type: 'button', role: 'menuitem' }, 'Download')),
    )
  }
  const screen = await mount(React.createElement(Harness))
  try {
    const menu = dom.window.document.querySelector('[role="menu"]')
    assert.ok(menu, 'the menu renders')
    const tile = dom.window.document.getElementById('tile')
    assert.equal(tile.contains(menu), false, 'it is NOT inside the clipping tile')
    assert.equal(menu.closest('#tile'), null, 'nothing in its ancestry can clip or re-layer it')
    assert.match(menu.className, /fixed/, 'it is positioned against the viewport, not the tile')
  } finally {
    await screen.unmount()
  }
})

test('MENU-2 a closed menu renders nothing, so only one can ever be open', async () => {
  const screen = await mount(
    React.createElement(AnchoredMenu, { open: false, anchorRef: { current: null }, onClose() {} },
      React.createElement('button', { type: 'button', role: 'menuitem' }, 'Download')),
  )
  try {
    assert.equal(dom.window.document.querySelector('[role="menu"]'), null)
  } finally {
    await screen.unmount()
  }
})

test('MENU-3 the screens delegate placement and dismissal instead of hand-rolling them', () => {
  const files = fs.readFileSync(path.join(rootDir, 'src/screens/Files.jsx'), 'utf8')
  const vault = fs.readFileSync(path.join(rootDir, 'src/screens/Vault.jsx'), 'utf8')

  for (const [name, source] of [['Files', files], ['Vault', vault]]) {
    assert.match(source, /<AnchoredMenu/, `${name} uses the shared anchored menu`)
    assert.match(source, /anchorRef=\{menuBtnRef\}/, `${name} anchors it to the overflow button`)
    // The old in-tile placement must be gone, or the clipping returns.
    assert.doesNotMatch(source, /className="absolute right-0 top-9/, `${name} no longer positions a menu inside the tile`)
    assert.doesNotMatch(source, /className="absolute right-2 top-10/, `${name} no longer positions a menu inside the tile`)
  }

  // Vault's own click-away tested `menuRef.contains(target)`. Once the menu is
  // portalled, every menu item is outside that subtree, so it would have closed
  // the menu before the action ran.
  assert.doesNotMatch(vault, /menuRef\.current\?\.contains/, 'the stale click-away is removed')
  assert.doesNotMatch(vault, /ref=\{menuRef\}/, 'and its now-undefined ref binding with it')
})

test('MENU-4 Vault keeps its locked/unlocked command sets exactly as they were', () => {
  const vault = fs.readFileSync(path.join(rootDir, 'src/screens/Vault.jsx'), 'utf8')

  // This pass moved where the menu is drawn, never what it offers. While
  // locked the menu must still expose only the two neutral entries, and the
  // button's accessible name must still avoid the real filename.
  assert.match(vault, /vaultEncryptedDetails/)
  assert.match(vault, /vaultLockedManageHint/)
  assert.match(vault, /aria-label=\{named \? `\$\{t\('moreActions'\)\} — \$\{entry\.name\}` : t\('moreActions'\)\}/,
    'the filename is still only named once unlocked')
  assert.match(vault, /const previewable = unlocked && previewKindFor/, 'preview is still structurally impossible while locked')
})

test('MENU-5 the menu is clamped into the viewport rather than trusting the anchor', () => {
  const ui = fs.readFileSync(path.join(rootDir, 'src/components/ui.jsx'), 'utf8')

  // A narrow tile at the right edge is exactly where the old menu ran off.
  assert.match(ui, /Math\.min\(Math\.max\(MENU_MARGIN, left\)/, 'horizontal position is clamped to the viewport')
  assert.match(ui, /const flip = h > below && above > below/, 'it flips above the anchor when below is too short')
  assert.match(ui, /max-w-\[calc\(100vw-16px\)\]/, 'it can never be wider than the screen')
  assert.match(ui, /window\.addEventListener\('scroll', sync, true\)/, 'it follows its anchor on scroll (capture: <main> scrolls, not window)')
})
