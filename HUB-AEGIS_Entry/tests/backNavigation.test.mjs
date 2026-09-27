import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'

const dist = resolve(import.meta.dirname, '../dist')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' }
const browserPath = [
  process.env.AEGIS_BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate))
let server
let browser
let origin

before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/drive' || path === '/monitor') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<!doctype html><html><body><h1>${path.slice(1)} login fixture</h1></body></html>`)
      return
    }
    const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`)
    if (!file.startsWith(`${dist}${sep}`)) { res.writeHead(403); res.end(); return }
    try {
      const bytes = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' })
      res.end(bytes)
    } catch {
      res.writeHead(404); res.end()
    }
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  origin = `http://127.0.0.1:${server.address().port}`
  assert.ok(browserPath, 'Install Chrome/Edge/Chromium or set AEGIS_BROWSER_PATH for the browser regression')
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox'],
  })
})

after(async () => {
  await browser?.close()
  await new Promise((ok) => server?.close(ok))
})

for (const [module, index] of [['drive', 0], ['monitor', 1]]) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`Welcome → Hub → ${module} → browser Back restores a usable picker (${reducedMotion})`, async () => {
      const context = await browser.newContext({ reducedMotion })
      const page = await context.newPage()
      await page.addInitScript(() => {
        window.__hubLifecycle = []
        window.__hubInstance = crypto.randomUUID()
        for (const event of ['pagehide', 'pageshow', 'visibilitychange']) {
          window.addEventListener(event, (e) => {
            const entry = { event, persisted: e.persisted ?? null, visibility: document.visibilityState }
            window.__hubLifecycle.push(entry)
            const history = JSON.parse(sessionStorage.getItem('__hubLifecycle') || '[]')
            sessionStorage.setItem('__hubLifecycle', JSON.stringify([...history, entry]))
          })
        }
      })
      try {
        await page.goto(origin)
        await page.locator('.sparkle-btn').click()
        const cards = page.locator('button.lum-card')
        await cards.first().waitFor({ state: 'visible' })
        assert.equal(await cards.count(), 2)
        const instanceBefore = await page.evaluate(() => window.__hubInstance)

        await cards.nth(index).click()
        await page.locator('[role="status"]').waitFor({ state: 'visible' })
        await page.waitForURL(`${origin}/${module}`, { timeout: 5000 })
        await page.goBack()
        await page.waitForTimeout(150)

        const restored = await page.evaluate(() => ({
          instance: window.__hubInstance,
          events: window.__hubLifecycle,
          tabEvents: JSON.parse(sessionStorage.getItem('__hubLifecycle') || '[]'),
          overlay: !!document.querySelector('[role="status"]'),
          buttons: document.querySelectorAll('button.lum-card').length,
          url: location.href,
          navigationType: performance.getEntriesByType('navigation')[0]?.type,
          historyState: history.state,
        }))
        assert.equal(restored.overlay, false, `stale entering overlay after Back: ${JSON.stringify(restored)}`)
        assert.equal(restored.buttons, 2, `Hub menu missing after Back: ${JSON.stringify({ instanceBefore, restored })}`)
        assert.ok(restored.tabEvents.some((e) => e.event === 'pagehide'))
        assert.ok(restored.tabEvents.some((e) => e.event === 'pageshow'))
        await cards.first().waitFor({ state: 'visible', timeout: 3000 })
        assert.equal(await cards.count(), 2)
        assert.equal(await cards.nth(index).isEnabled(), true)
        await page.goBack()
        await page.locator('.sparkle-btn').waitFor({ state: 'visible', timeout: 3000 })
        assert.equal(await page.locator('button.lum-card').count(), 0,
          'a second Back from the picker must restore Welcome')
        // A preserved instance proves BFCache restored React state rather than remounting.
        if (restored.instance === instanceBefore) {
          assert.ok(restored.events.some((e) => e.event === 'pageshow' && e.persisted === true))
        }
      } finally {
        await context.close()
      }
    })
  }
}

test('fresh entry is light and Welcome → Hub adds a reversible history entry', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(origin)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    const before = await page.evaluate(() => history.length)
    await page.locator('.sparkle-btn').click()
    await page.locator('button.lum-card').first().waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => history.length), before + 1)
    await page.goBack()
    await page.locator('.sparkle-btn').waitFor({ state: 'visible' })
  } finally {
    await context.close()
  }
})

for (const [name, initial, expected] of [
  ['legacy migration', { aegis_theme: 'dark' }, 'dark'],
  ['canonical precedence', { aegis_theme: 'dark', aegis_shell_theme: 'light' }, 'light'],
  ['system light', { aegis_shell_theme: 'system' }, 'light'],
]) {
  test(`R4 shell theme ${name}`, async () => {
    const context = await browser.newContext({ colorScheme: 'light' })
    const page = await context.newPage()
    await page.addInitScript((entries) => {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
    }, initial)
    try {
      await page.goto(origin)
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), expected)
      assert.equal(await page.evaluate(() => localStorage.getItem('aegis_shell_theme')),
        initial.aegis_shell_theme ?? initial.aegis_theme)
    } finally {
      await context.close()
    }
  })
}

test('persisted pageshow clears a pending handoff and cancels its timer', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(origin)
    await page.locator('.sparkle-btn').click()
    const cards = page.locator('button.lum-card')
    await cards.first().waitFor({ state: 'visible' })
    await cards.first().click()
    await page.locator('[role="status"]').waitFor({ state: 'visible' })
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.waitForTimeout(1000)
    assert.equal(new URL(page.url()).pathname, '/')
    assert.equal(await page.locator('[role="status"]').count(), 0)
    assert.equal(await cards.count(), 2)
  } finally {
    await context.close()
  }
})

test('first module choice wins a same-turn double activation', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(origin)
    await page.locator('.sparkle-btn').click()
    await page.locator('button.lum-card').first().waitFor({ state: 'visible' })
    await page.evaluate(() => {
      const [drive, monitor] = document.querySelectorAll('button.lum-card')
      drive.click()
      monitor.click()
    })
    await page.waitForURL(`${origin}/drive`, { timeout: 5000 })
    assert.equal(new URL(page.url()).pathname, '/drive')
  } finally {
    await context.close()
  }
})

test('system shell theme follows OS changes without replacing the stored system value', async () => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('aegis_shell_theme', 'system'))
  try {
    await page.goto(origin)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    assert.equal(await page.evaluate(() => localStorage.getItem('aegis_shell_theme')), 'system')
  } finally { await context.close() }
})
