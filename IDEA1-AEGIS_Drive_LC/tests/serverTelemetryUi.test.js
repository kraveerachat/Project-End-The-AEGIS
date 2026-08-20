import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')
let vite
let ServerTelemetry

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
  })
  ;({ ServerTelemetry } = await vite.ssrLoadModule('/src/components/ServerTelemetry.jsx'))
})

after(async () => {
  await vite?.close()
})

test('Server Telemetry renders six truthful unavailable metric cards', () => {
  const html = renderToStaticMarkup(React.createElement(ServerTelemetry, { t, data: null }))
  for (const label of ['CPU', 'RAM', 'Disk', 'Network', 'Twingate', 'System uptime']) {
    assert.match(html, new RegExp(`>${label}<`), `${label} card must be visible`)
  }
  assert.equal((html.match(/aria-label="[^"]+ · Unavailable"/g) ?? []).length, 6)
  assert.doesNotMatch(html, /0(?:\.0+)?\s*(?:%|°C|ms|Mbps|Kbps|GB)/)
})

test('telemetry state is conveyed with accessible text and not color alone', () => {
  const html = renderToStaticMarkup(React.createElement(ServerTelemetry, {
    t,
    data: {
      cpu: { state: 'warning', usagePercent: 71, temperatureC: 63, load: 1.42 },
    },
  }))
  assert.match(html, />Warning</)
  assert.match(html, /71%/)
  assert.match(html, /63 °C/)
  assert.match(html, /Load 1\.42/)
})
