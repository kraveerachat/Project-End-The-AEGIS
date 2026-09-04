import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

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
    const { Card, Segmented } = await vite.ssrLoadModule('/src/components/ui.jsx')
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
