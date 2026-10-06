import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => normalizePath(path.join(rootDir, 'tests/fixtures', name))

test('shared authenticated primitives expose one Neo styling contract without changing semantics', async () => {
  const vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: [
        { find: './lib/hooks.js', replacement: fixture('mockHooks.js') },
        { find: '../lib/hooks.js', replacement: fixture('mockHooks.js') },
      ],
    },
  })
  try {
    const { Card, Segmented, ThemeToggle } = await vite.ssrLoadModule('/src/components/ui.jsx')
    const { Sidebar } = await vite.ssrLoadModule('/src/components/Sidebar.jsx')
    const { TopBar } = await vite.ssrLoadModule('/src/components/TopBar.jsx')

    const cardMarkup = renderToStaticMarkup(React.createElement(Card, null, 'Measured data'))
    assert.match(cardMarkup, /class="[^"]*ui-card/)
    assert.match(cardMarkup, /data-material="solid"/)

    const segmentedMarkup = renderToStaticMarkup(React.createElement(Segmented, {
      ariaLabel: 'Theme',
      value: 'light',
      onChange() {},
      options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
    }))
    assert.match(segmentedMarkup, /role="radiogroup"/)
    assert.match(segmentedMarkup, /class="[^"]*ui-segmented/)
    assert.equal((segmentedMarkup.match(/role="radio"/g) ?? []).length, 2)

    const thaiThemeToggle = renderToStaticMarkup(React.createElement(ThemeToggle, {
      theme: 'dark',
      setTheme() {},
      t: makeT('th'),
    }))
    assert.match(thaiThemeToggle, /aria-label="เปลี่ยนเป็นโหมดสว่าง"/)

    const t = (key) => key
    const sidebarMarkup = renderToStaticMarkup(React.createElement(Sidebar, {
      t,
      nav: [{ id: 'dashboard', icon: 'gauge', labelKey: 'navDashboard', group: 'navGroupWorkspace' }],
      screen: 'dashboard',
      setScreen() {},
      collapsed: false,
      setCollapsed() {},
      metrics: null,
      resolvedTheme: 'light',
      mobileOpen: false,
      closeMobile() {},
    }))
    assert.match(sidebarMarkup, /class="[^"]*app-sidebar/)
    assert.match(sidebarMarkup, /data-material="shell-glass"/)
    assert.match(sidebarMarkup, /aria-current="page"/)

    for (const language of ['en', 'th', 'zh']) {
      const translate = makeT(language)
      const railMarkup = renderToStaticMarkup(React.createElement(Sidebar, {
        t: translate,
        nav: [{ id: 'dashboard', icon: 'gauge', labelKey: 'navDashboard', group: 'navGroupWorkspace' }],
        screen: 'dashboard',
        setScreen() {},
        collapsed: true,
        setCollapsed() {},
        metrics: null,
        resolvedTheme: 'dark',
        mobileOpen: false,
        closeMobile() {},
        neoDashboard: true,
      }))
      assert.match(railMarkup, /data-rail-state="compact"/)
      assert.match(railMarkup, /style="width:72px/)
      assert.match(railMarkup, new RegExp(`aria-label="${translate('navDashboard')}"`))
    }

    const dom = new JSDOM('<!doctype html><div id="root"></div>')
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const previousGetComputedStyle = globalThis.getComputedStyle
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.window = dom.window
    globalThis.document = dom.window.document
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
    globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0)
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(dom.window.document.getElementById('root'))
    try {
      await act(async () => root.render(React.createElement(Sidebar, {
        t,
        nav: [{ id: 'dashboard', icon: 'gauge', labelKey: 'navDashboard', group: 'navGroupWorkspace' }],
        screen: 'dashboard',
        setScreen() {},
        collapsed: true,
        setCollapsed() {},
        metrics: null,
        resolvedTheme: 'dark',
        mobileOpen: false,
        closeMobile() {},
        neoDashboard: true,
      })))
      const frame = dom.window.document.querySelector('.app-sidebar-frame')
      assert.equal(frame.dataset.railState, 'compact')
      const enter = new dom.window.Event('pointerover', { bubbles: true })
      Object.defineProperty(enter, 'pointerType', { value: 'mouse' })
      await act(async () => frame.dispatchEvent(enter))
      await act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
      assert.equal(frame.dataset.railState, 'hover')
      assert.equal(frame.style.width, '72px', 'hover expansion must not resize the Dashboard')
      assert.match(frame.textContent, /navDashboard/)
      const leave = new dom.window.Event('pointerout', { bubbles: true })
      Object.defineProperty(leave, 'pointerType', { value: 'mouse' })
      await act(async () => frame.dispatchEvent(leave))
      assert.equal(frame.dataset.railState, 'compact')
    } finally {
      await act(async () => root.unmount())
      globalThis.window = previousWindow
      globalThis.document = previousDocument
      globalThis.getComputedStyle = previousGetComputedStyle
      globalThis.requestAnimationFrame = previousRequestAnimationFrame
      globalThis.cancelAnimationFrame = previousCancelAnimationFrame
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
      dom.window.close()
    }

    const topbarMarkup = renderToStaticMarkup(React.createElement(TopBar, {
      t,
      user: { id: '1', username: 'admin', displayName: 'Admin', role: 'Admin' },
      health: { data: { layers: { application: {}, metadata: {} } } },
      onSignOut() {},
      openMobileNav() {},
    }))
    assert.match(topbarMarkup, /class="[^"]*app-topbar/)
    assert.match(topbarMarkup, /data-material="shell-glass"/)
    assert.match(topbarMarkup, /class="[^"]*avatar-accent/)
  } finally {
    await vite.close()
  }
})
