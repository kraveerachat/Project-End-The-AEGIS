import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { before, after, test } from 'node:test'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '../..')
const dist = {
  '/': resolve(root, 'HUB-AEGIS_Entry/dist'),
  '/drive': resolve(root, 'IDEA1-AEGIS_Drive_LC/dist'),
  '/monitor': resolve(root, 'IDEA2-AEGIS_Monitor/dist'),
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' }
const browserPath = [process.env.AEGIS_BROWSER_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => p && existsSync(p))
let server
let browser
let origin

before(async () => {
  assert.ok(browserPath, 'Chrome/Edge required for R4 browser contract')
  for (const folder of Object.values(dist)) assert.ok(existsSync(resolve(folder, 'index.html')), `Build first: ${folder}`)
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (pathname === '/config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ modules: { drive: `${origin}/drive/`, monitoring: `${origin}/monitor/` } }))
      return
    }
    const user = {
      id: '1', username: 'admin', displayName: 'Veerachat J.', accountName: 'Veerachat J.',
      role: 'Admin', mustResetPassword: false,
      preferences: { theme: 'light', language: 'th', density: 'comfortable', interfaceStyle: 'classic' },
    }
    const menu = [
      { id: 'dashboard', icon: 'Home', labelKey: 'navDashboard', group: 'work' },
      { id: 'files', icon: 'Folder', labelKey: 'navFiles', group: 'work' },
      { id: 'settings', icon: 'Settings', labelKey: 'navSettings', group: 'system' },
    ]
    if (pathname === '/drive/api/login' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'))
      if (body.username === 'invalid') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'r4_auth=1; Path=/drive; SameSite=Strict' })
      res.end(JSON.stringify({ user, menu, csrfToken: 'r4-test-only' }))
      return
    }
    if (pathname === '/drive/api/me' && req.headers.cookie?.includes('r4_auth=1')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ user, menu, csrfToken: 'r4-test-only' }))
      return
    }
    if (pathname === '/drive/api/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'r4_auth=; Path=/drive; Max-Age=0; SameSite=Strict' })
      res.end('{}')
      return
    }
    if (pathname === '/drive/api/dashboard' && req.headers.cookie?.includes('r4_expire=1')) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    if (pathname.startsWith('/drive/api/') && pathname !== '/drive/api/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(pathname === '/drive/api/preferences' ? { preferences: user.preferences } : {}))
      return
    }
    if (pathname === '/drive/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    if (pathname.startsWith('/drive/api/') || pathname.startsWith('/monitor/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    const prefix = pathname.startsWith('/drive/') ? '/drive' : pathname.startsWith('/monitor/') ? '/monitor' : '/'
    const relative = prefix === '/' ? pathname : pathname.slice(prefix.length)
    const folder = dist[prefix]
    const file = resolve(folder, `.${relative === '/' ? '/index.html' : relative}`)
    if (!file.startsWith(`${folder}${sep}`)) { res.writeHead(403); res.end(); return }
    try {
      const bytes = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' })
      res.end(bytes)
    } catch {
      if (prefix !== '/' && !extname(relative)) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(await readFile(resolve(folder, 'index.html')))
      } else { res.writeHead(404); res.end() }
    }
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
})

after(async () => {
  await browser?.close()
  await new Promise((ok) => server?.close(ok))
})

for (const width of [320, 375, 768, 1024, 1440]) {
  test(`R4 Drive login TH/EN/ZH geometry stable at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    try {
      await page.goto(`${origin}/drive/`)
      await page.locator('.login-card').waitFor()
      await page.evaluate(() => document.fonts.ready)
      const measure = () => page.evaluate(() => {
        const names = ['.login-card', '.login-brand-panel', '.login-form-panel', '#login-username', '#login-password', '.login-submit', '.login-layers', '.login-top-controls']
        return Object.fromEntries(names.map((name) => {
          const r = document.querySelector(name).getBoundingClientRect()
          return [name, [r.x, r.y, r.width, r.height].map((v) => Math.round(v))]
        }))
      })
      const baseline = await measure()
      if (process.env.AEGIS_R4_SCREENSHOT_DIR) {
        await mkdir(process.env.AEGIS_R4_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({ path: resolve(process.env.AEGIS_R4_SCREENSHOT_DIR, `drive-login-${width}-th.png`), fullPage: true })
      }
      for (const lang of ['EN', 'ZH', 'TH']) {
        await page.getByRole('radio', { name: lang }).click()
        await page.evaluate(() => document.fonts.ready)
        const actual = await measure()
        for (const name of Object.keys(baseline)) {
          assert.deepEqual(actual[name], baseline[name], `${width}px ${lang} moved ${name}`)
        }
        const clipped = await page.evaluate(() => [...document.querySelectorAll('.login-brand-tag,.login-subtitle,.login-layer-name,.login-layer-description,.login-layer-status')]
          .filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
          .map((el) => `${el.className}:${el.textContent}`))
        assert.deepEqual(clipped, [], `${width}px ${lang} clipped copy`)
      }
    } finally { await context.close() }
  })
}

test('R4 Drive Login preserves static atmosphere without Human-rejected travelling lines in both themes', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/drive/`)
    await page.locator('.login-card').waitFor()
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByRole('button', { name: /dark mode/i }).click()
      const visual = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        beam: !!document.querySelector('.login-ambient-beam'),
        line: !!document.querySelector('.login-energy-line'),
        trace: !!document.querySelector('[data-field-trace]'),
        sweep: getComputedStyle(document.querySelector('.login-mark-stage'), '::after').content,
        aura: !!document.querySelector('[data-field-aura]'),
        border: getComputedStyle(document.querySelector('.login-card')).borderTopColor,
      }))
      assert.equal(visual.theme, theme)
      assert.equal(visual.beam, true)
      assert.equal(visual.line, false)
      assert.equal(visual.trace, false)
      assert.ok(['none', 'normal'].includes(visual.sweep), 'no painted white logo sweep, even with motion disabled')
      assert.equal(visual.aura, true)
      assert.notEqual(visual.border, 'rgba(75, 112, 178, 0.22)')
      if (process.env.AEGIS_R4_SCREENSHOT_DIR) {
        await mkdir(process.env.AEGIS_R4_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({ path: resolve(process.env.AEGIS_R4_SCREENSHOT_DIR, `drive-login-${theme}.png`), fullPage: true })
      }
    }
  } finally { await context.close() }
})

for (const width of [320, 375, 768, 1024, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`final polish Login/HUB ${theme} TH/EN/ZH geometry and legible brand at ${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
      const page = await context.newPage()
      await page.addInitScript((theme) => localStorage.setItem('aegis_shell_theme', theme), theme)
      const rows = []
      try {
        for (const route of ['/drive/', '/']) {
          await page.goto(`${origin}${route}`)
          if (route === '/') await page.locator('.sparkle-btn').click()
          await page.locator(route === '/' ? 'button.lum-card' : '.login-card').first().waitFor()
          await page.evaluate(() => document.fonts.ready)
          // Welcome's click position can leave the first mobile card hovered.
          // Compare language geometry in the same (unhovered) interaction state.
          await page.mouse.move(0, 0)
          await page.waitForTimeout(400)
          if (route === '/') {
            const brand = await page.locator('header > div').first().evaluate((el) => {
              const mark = el.querySelector('img').getBoundingClientRect()
              const word = el.querySelector('.hub-wordmark')
              const descriptor = el.querySelector('.hub-brand-descriptor')
              return { mark: mark.width, word: word?.textContent, wordVisible: word && getComputedStyle(word).display !== 'none', descriptor: descriptor?.textContent, descriptorVisible: descriptor && getComputedStyle(descriptor).display !== 'none' }
            })
            assert.ok(brand.mark >= (width >= 640 ? 36 : 30), 'brand mark visibly larger than old 28px')
            assert.equal(brand.word, 'AEGIS')
            assert.equal(brand.wordVisible, true, 'mobile must not hide the project identity')
            assert.equal(brand.descriptor, 'EDGE-GUARD INFRASTRUCTURE')
            assert.equal(brand.descriptorVisible, width >= 640)
          }
          const measure = () => page.evaluate((route) => {
            const selectors = route === '/' ? ['header', '[data-hub-brand]', '.hub-wordmark', '[data-hub-controls]', 'main', 'main h1', '.hub-subtitle', 'button.lum-card']
              : ['.login-card', '.login-brand-panel', '.login-form-panel', '#login-username', '#login-password', '.login-submit', '.login-layers', '.login-top-controls', ...[0, 1, 2, 3].map((i) => `[data-layer-id="${i}"]`)]
            const rects = Object.fromEntries(selectors.map((s) => {
              const r = document.querySelector(s).getBoundingClientRect()
              return [s, [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100)]
            }))
            const overflow = document.documentElement.scrollWidth > innerWidth
            const clipped = [...document.querySelectorAll(route === '/' ? '.hub-wordmark,.hub-brand-descriptor,.lum-title,.lum-desc' : '.login-brand-tag,.login-subtitle,.login-layer-name,.login-layer-description,.login-layer-status')]
              .filter((el) => getComputedStyle(el).display !== 'none' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)).map((el) => el.className)
            const overlap = route === '/' && rects['[data-hub-brand]'][0] + rects['[data-hub-brand]'][2] > rects['[data-hub-controls]'][0]
            return { rects, overflow, clipped, overlap: Boolean(overlap), theme: document.documentElement.dataset.theme }
          }, route)
          const baseline = await measure()
          if (route === '/drive/') {
            await page.locator('#login-username').fill('retained-operator')
            await page.locator('#login-password').fill('test-only-password')
            await page.getByRole('switch').click()
            await page.locator('.login-password-toggle').click()
          }
          for (const language of ['EN', 'ZH', 'TH', 'EN', 'ZH', 'TH']) {
            await page.getByRole('radio', { name: language, exact: true }).click()
            await page.evaluate(() => document.fonts.ready)
            const actual = await measure()
            assert.deepEqual(actual.rects, baseline.rects, `${route} ${theme} ${width} ${language} structural jump`)
            assert.equal(actual.overflow, false, 'no horizontal overflow')
            assert.deepEqual(actual.clipped, [], 'no clipped copy')
            assert.equal(actual.overlap, false, 'brand and controls must not collide')
            assert.equal(actual.theme, theme)
            rows.push({ route, theme, width, language, ...actual })
            if (route === '/drive/') {
              assert.equal(await page.locator('#login-username').inputValue(), 'retained-operator')
              assert.equal(await page.locator('#login-password').inputValue(), 'test-only-password')
              assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true')
              assert.equal(await page.locator('#login-password').getAttribute('type'), 'text')
            }
          }
          const toggle = page.locator(route === '/' ? '[data-hub-controls] > button[aria-label]' : '.theme-toggle')
          await toggle.click()
          assert.deepEqual((await measure()).rects, baseline.rects, 'theme toggle must not move structural geometry')
          await toggle.click()
          await page.mouse.move(0, 0)
          await page.waitForTimeout(400) // Capture settled theme colours, not their existing transition.
          if (process.env.AEGIS_R4_SCREENSHOT_DIR) {
            await mkdir(process.env.AEGIS_R4_SCREENSHOT_DIR, { recursive: true })
            await page.screenshot({ path: resolve(process.env.AEGIS_R4_SCREENSHOT_DIR, `polish-${route === '/' ? 'hub' : 'login'}-${theme}-${width}.png`), fullPage: true })
          }
        }
        if (process.env.AEGIS_R4_SCREENSHOT_DIR) {
          const { writeFile } = await import('node:fs/promises')
          await writeFile(resolve(process.env.AEGIS_R4_SCREENSHOT_DIR, `geometry-${theme}-${width}.json`), JSON.stringify(rows, null, 2))
        }
      } finally { await context.close() }
    })
  }
}

for (const theme of ['light', 'dark']) {
for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`final polish live login motion, immediate input and one-time lower reveal (${theme}, ${reducedMotion})`, async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 640 }, reducedMotion })
    const page = await context.newPage()
    await page.addInitScript(() => {
      window.__loginRevealSamples = []
      const start = performance.now()
      const sample = () => {
        const items = [...document.querySelectorAll('[data-login-motion]')].map((el) => ({ name: el.dataset.loginMotion, opacity: Number(getComputedStyle(el).opacity), y: new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 }))
        if (items.length) window.__loginRevealSamples.push({ at: performance.now() - start, items })
        if (performance.now() - start < 2500) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await page.addInitScript((theme) => localStorage.setItem('aegis_shell_theme', theme), theme)
    try {
      await page.goto(`${origin}/drive/`)
      await page.locator('#login-username').waitFor()
      assert.equal(await page.locator('#login-username').isEnabled(), true)
      assert.equal(await page.locator('#login-password').isEnabled(), true)
      await page.locator('#login-username').fill('typing-during-entry')
      await page.locator('#login-password').fill('test-only-password')
      await page.waitForTimeout(700)
      const names = await page.locator('[data-login-motion]').evaluateAll((els) => els.map((el) => el.dataset.loginMotion))
      for (const name of ['mark', 'wordmark', 'tagline', 'title', 'subtitle', 'username', 'password', 'remember', 'submit', 'layers', 'controls']) assert.ok(names.includes(name), `${name} motion group missing`)
      const samples = await page.evaluate(() => window.__loginRevealSamples)
      if (reducedMotion === 'no-preference') {
        assert.ok(samples.some((s) => s.items.some((i) => i.name === 'wordmark' && i.opacity < 1 && i.y > 0)), 'actual restrained reveal must run')
        assert.ok(samples.some((s) => {
          const username = s.items.find((i) => i.name === 'username')
          const password = s.items.find((i) => i.name === 'password')
          return username && password && username.opacity > password.opacity + 0.05
        }), 'field groups arrive in logical stagger order')
      } else assert.ok(samples.every((s) => s.items.every((i) => i.y === 0 && i.opacity === 1)), 'reduced motion never starts a translated/hidden reveal')
      await page.locator('.login-layers').scrollIntoViewIfNeeded()
      await page.waitForTimeout(700)
      const settled = () => page.locator('.login-layer-row').evaluateAll((els) => els.map((el) => ({ opacity: Number(getComputedStyle(el).opacity), y: new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 })))
      assert.deepEqual(await settled(), Array(4).fill({ opacity: 1, y: 0 }))
      await page.evaluate(() => scrollTo(0, 0))
      await page.waitForTimeout(100)
      await page.locator('.login-layers').scrollIntoViewIfNeeded()
      assert.deepEqual(await settled(), Array(4).fill({ opacity: 1, y: 0 }), 'scroll back must not replay lower rows')
      assert.equal(await page.locator('#login-username').inputValue(), 'typing-during-entry')
      const visibility = page.locator('.login-password-toggle')
      const position = () => visibility.evaluate((el) => {
        const control = el.getBoundingClientRect()
        const input = document.querySelector('#login-password').getBoundingClientRect()
        return { centerOffset: Math.abs(control.y + control.height / 2 - input.y - input.height / 2), scale: new DOMMatrixReadOnly(getComputedStyle(el).transform).a }
      })
      assert.ok((await position()).centerOffset < 1, 'visibility control stays centered')
      await visibility.hover()
      await page.mouse.down()
      await page.waitForTimeout(160)
      const pressed = await position()
      assert.ok(pressed.centerOffset < 1, 'press motion must not replace vertical positioning')
      if (reducedMotion === 'no-preference') assert.ok(pressed.scale < 1, 'visibility control gives restrained press feedback')
      else assert.equal(pressed.scale, 1, 'reduced motion suppresses press transform')
      await page.mouse.up()
      await page.locator('#login-password').focus()
      await page.keyboard.press('Tab')
      assert.equal(await visibility.evaluate((el) => el.matches(':focus-visible')), true)
      assert.notEqual(await visibility.evaluate((el) => getComputedStyle(el).outlineStyle), 'none', 'keyboard focus remains visible')
      const sweep = await page.locator('.login-mark-stage').evaluate((el) => getComputedStyle(el, '::after').content)
      assert.ok(['none', 'normal'].includes(sweep))
      const continuous = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations === Infinity && a.playState === 'running').length)
      assert.equal(continuous, 0, 'readable login has no continuous decorative movement')
    } finally { await context.close() }
  })
}
}

test('R4 real entry flow: HUB and Monitor Login exchange one shell theme', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.goto(origin)
    await page.locator('button[aria-label]').first().click()
    assert.equal(await page.evaluate(() => localStorage.getItem('aegis_shell_theme')), 'dark')
    await page.locator('.sparkle-btn').click()
    await page.locator('button.lum-card').nth(1).click()
    await page.waitForURL(`${origin}/monitor/`)
    await page.locator('#mon-username').waitFor()
    if (process.env.AEGIS_R4_SCREENSHOT_DIR) {
      await mkdir(process.env.AEGIS_R4_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: resolve(process.env.AEGIS_R4_SCREENSHOT_DIR, 'monitor-login-dark-reference.png'), fullPage: true })
    }
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    await page.locator('button[aria-label]').first().click()
    assert.equal(await page.evaluate(() => localStorage.getItem('aegis_shell_theme')), 'light')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.goBack()
    await page.locator('button.lum-card').first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.goBack()
    await page.locator('.sparkle-btn').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  } finally { await context.close() }
})

test('R4 real successful Drive login arms bounded Back; logout releases it', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.goto(origin)
    await page.locator('button[aria-label]').first().click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    await page.locator('.sparkle-btn').click()
    await page.locator('button.lum-card').first().click()
    await page.waitForURL(`${origin}/drive/`)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    await page.locator('#login-username').fill('admin')
    await page.locator('#login-password').fill('test-only-password')
    await page.locator('button[type="submit"]').click()
    await page.locator('#login-username').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark',
      'Welcome-selected Dark must survive the account\'s stale Light preference')
    const length = await page.evaluate(() => history.length)
    await page.goBack()
    await page.waitForTimeout(100)
    assert.equal(await page.locator('#login-username').count(), 0)
    assert.equal(await page.locator('button.lum-card').count(), 0)
    assert.equal(await page.evaluate(() => history.length), length)
    await page.reload()
    await page.locator('#login-username').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    await page.goBack()
    await page.waitForTimeout(100)
    assert.equal(await page.locator('#login-username').count(), 0, 'restored session keeps Back boundary')
    await page.getByRole('button', { name: 'Veerachat J.' }).click()
    await page.getByRole('menuitem', { name: 'ตั้งค่า' }).click()
    await page.waitForURL(/\/drive\/settings/)
    await page.getByRole('radio', { name: 'สว่าง' }).click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    assert.equal(await page.evaluate(() => localStorage.getItem('aegis_shell_theme')), 'light')
    await page.goBack()
    await page.waitForURL(/\/drive\/dashboard/)
    assert.equal(await page.locator('#login-username').count(), 0, 'internal Back remains in Drive')
    await page.goBack()
    await page.waitForTimeout(100)
    assert.equal(await page.locator('#login-username').count(), 0, 'boundary survives internal navigation')
    await page.getByRole('button', { name: 'Veerachat J.' }).click()
    await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click()
    await page.locator('#login-username').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.goBack()
    await page.locator('button.lum-card').first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.goBack()
    await page.locator('.sparkle-btn').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  } finally { await context.close() }
})

test('R4 unauthorized Drive response releases the browser Back boundary', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/drive/`)
    await page.locator('#login-username').fill('admin')
    await page.locator('#login-password').fill('test-only-password')
    await page.locator('button[type="submit"]').click()
    await page.locator('#login-username').waitFor({ state: 'detached' })
    await context.addCookies([{ name: 'r4_expire', value: '1', url: origin }])
    await page.reload()
    await page.locator('#login-username').waitFor({ state: 'visible' })
    const length = await page.evaluate(() => history.length)
    await page.goBack()
    assert.equal(await page.evaluate(() => history.length), length, 'expiration adds no history entries')
  } finally { await context.close() }
})

test('R4 Monitor Login resyncs shell theme after same-tab BFCache forward', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.goto(origin)
    await page.locator('button[aria-label]').first().click() // Welcome Dark
    await page.locator('.sparkle-btn').click()
    await page.locator('button.lum-card').nth(1).click()
    await page.locator('#mon-username').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    await page.goBack()
    await page.locator('button.lum-card').first().waitFor()
    await page.locator('button[aria-label]').first().click() // Hub Light
    assert.equal(await page.evaluate(() => localStorage.getItem('aegis_shell_theme')), 'light')
    await page.goForward()
    await page.locator('#mon-username').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  } finally { await context.close() }
})

test('R4 fresh browser remains Light from Welcome through both module logins', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.goto(origin)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.locator('.sparkle-btn').click()
    await page.locator('button.lum-card').first().click()
    await page.locator('#login-username').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.goBack()
    await page.locator('button.lum-card').nth(1).click()
    await page.locator('#mon-username').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  } finally { await context.close() }
})

test('R4 localized login error keeps card and form geometry stable at 320px', async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/drive/`)
    await page.locator('#login-username').fill('invalid')
    await page.locator('#login-password').fill('test-only-password')
    await page.locator('button[type="submit"]').click()
    await page.locator('[role="alert"]').waitFor()
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.fonts.ready)
    const measure = () => page.evaluate(() => Object.fromEntries(
      ['.login-card', '.login-form-panel', '.login-form', '#login-username', '#login-password', '.login-remember-row', '.login-submit', '.login-error', '.login-layers']
        .map((name) => {
          const el = document.querySelector(name)
          const r = el.getBoundingClientRect()
          const translateY = name === '.login-submit' ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 : 0
          return [name, [r.y - translateY, r.height].map((x) => Math.round(x * 1000) / 1000)]
        }),
    ))
    const baseline = await measure()
    for (const language of ['EN', 'ZH', 'TH']) {
      await page.getByRole('radio', { name: language }).click()
      await page.evaluate(() => document.fonts.ready)
      assert.deepEqual(await measure(), baseline, `${language} moved failed-login geometry`)
    }
  } finally { await context.close() }
})
