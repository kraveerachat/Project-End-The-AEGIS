import { test, expect } from '@playwright/test'

const nav = (page, label) => page.getByRole('navigation', { name: 'Console sections' })
  .getByRole('button', { name: new RegExp(`^${label}(?:$| \\d+ unacknowledged$)`) })
const stats = async request => (await request.get('/__fixture/stats')).json()

function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map(part => {
    const channel = parseInt(part, 16) / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  return .2126 * r + .7152 * g + .0722 * b
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) /
  (Math.min(luminance(a), luminance(b)) + .05)

for (const theme of ['dark', 'light']) {
  test(`${theme}: semantic body and selected-navigation colors meet text contrast`, async ({ page, request }) => {
    await request.post('/__fixture/reset?scenario=single-camera')
    await page.addInitScript(theme => localStorage.setItem('aegis_shell_theme', theme), theme)
    await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.hero .feedimg')).toBeVisible()
    const colors = await page.locator('.app').evaluate(el => {
      const css = getComputedStyle(el)
      return Object.fromEntries(['ink', 'muted', 'surface', 'selected'].map(name =>
        [name, css.getPropertyValue(`--monitor-${name}`).trim()]))
    })
    expect(contrast(colors.ink, colors.surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.muted, colors.surface)).toBeGreaterThanOrEqual(4.5)
    const endpoints = colors.selected.match(/#[a-f0-9]{6}/gi)
    expect(endpoints).toHaveLength(2)
    for (const endpoint of endpoints) expect(contrast('#ffffff', endpoint)).toBeGreaterThanOrEqual(4.5)
  })
}

for (const scenario of ['single-camera', 'soc-passive']) {
  test(`${scenario}: unknown/mixed latest metadata keeps measured scores without face geometry`, async ({ page, request }) => {
    await request.post(`/__fixture/reset?scenario=${scenario}`)
    const people = [{ k: 'unk', name: 'Do not promote this name', conf: 88 }, { k: 'auth', name: 'Fixture matched', conf: 91 }]
    await page.route(scenario === 'soc-passive' ? '**/monitor/api/live/active-views/*/detections' : '**/monitor/api/detections',
      route => route.fulfill({ json: { detections: [{ id: 'mixed', cam: 'entry-z', at: Date.now(), people }] } }))
    await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.hero .feedimg')).toBeVisible()
    await expect(page.locator('.acpanel')).toContainText('Unknown')
    await expect(page.locator('.acpanel')).toContainText('88%')
    await expect(page.locator('.acpanel')).toContainText('Fixture matched')
    await expect(page.locator('.acpanel')).toContainText('91%')
    await expect(page.locator('.acpanel')).not.toContainText('Do not promote this name')
    await expect(page.locator('.acpanel .acbig')).toHaveCount(0)
    await expect(page.locator('.hero .bbox')).toHaveCount(0)
  })
}

for (const scenario of ['single-camera', 'single-camera-2', 'soc-passive']) {
  test(`${scenario}: real stream stays visible without invented face geometry`, async ({ page, request }) => {
    await request.post(`/__fixture/reset?scenario=${scenario}`)
    await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.hero .feedimg')).toBeVisible()
    await expect(page.locator('.acname')).toBeVisible()
    await expect(page.locator('.acpanel')).toContainText(scenario === 'single-camera-2' ? '93%' : '97%')
    // Detection metadata has a person/confidence but no exact-frame geometry.
    await expect(page.locator('.hero .bbox')).toHaveCount(0)
    await expect(page.locator('.hero .feedimg')).toHaveAttribute('src', /^\/monitor\/api\//)
    await expect(page.locator('.streampanel')).toContainText('Authorized')
  })
}

test('theme and language presentation changes preserve the existing Operator viewer', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=single-camera-2')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => (await stats(request)).active).toEqual(['CAM-02'])
  const before = await stats(request)
  await nav(page, 'Settings').click()
  const controls = page.locator('.seg-control')
  await controls.nth(1).getByRole('button').first().click()
  await expect(controls.nth(1).getByRole('button').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveClass('dark')
  await controls.nth(1).getByRole('button').last().click()
  await expect(page.locator('html')).toHaveClass('light')
  for (const language of ['ไทย', 'English', '中文']) {
    await controls.first().getByRole('button', { name: language, exact: true }).click()
    await expect(controls.first().getByRole('button', { name: language, exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  expect(await stats(request)).toEqual(before)
  await page.locator('header').getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect.poll(async () => (await stats(request)).active).toEqual([])
})

test('navigation selection is stable, keyboard-visible and motion-safe', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=single-camera')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  const live = nav(page, 'Live canvas')
  await expect(live).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => live.evaluate(el => Math.round(new DOMMatrix(getComputedStyle(el).transform).m41))).toBe(4)
  await live.focus()
  expect(await live.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await live.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
  expect(await live.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)).toBe(0)
})

const clips = [
  { id: 'visual-300', cam: 'entry-z', camName: 'Test main entrance', nodeId: 'fixture-node',
    start: Date.parse('2026-10-10T06:00:00Z'), durationSec: 300, kind: 'auth' },
  { id: 'visual-83', cam: 'CAM-02', camName: 'Test parking', nodeId: 'fixture-node',
    start: Date.parse('2026-10-10T06:05:00Z'), durationSec: 83, kind: 'unavailable' },
]
const operators = [
  { id: 1, name: 'fixture-operator', role: 'CCTV-Operator', active: true, lastLogin: null },
  { id: 2, name: 'fixture-operator2', role: 'CCTV-Operator', active: false, lastLogin: null },
]

async function noPageOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth + 1))
  const main = await page.locator('#main').boundingBox()
  expect(main.width).toBeGreaterThan(100)
}

for (const scenario of ['single-camera', 'single-camera-2', 'soc-visual']) {
  for (const theme of ['dark', 'light']) {
    for (const width of [1440, 768, 390]) {
      test(`${scenario} ${theme} ${width}px: every permitted view stays readable and available`, async ({ page, request }, info) => {
        await page.setViewportSize({ width, height: 1000 })
        await request.post(`/__fixture/reset?scenario=${scenario}`)
        await page.addInitScript(theme => localStorage.setItem('aegis_shell_theme', theme), theme)
        await page.route('**/monitor/api/clips', route => route.fulfill({ json: { clips } }))
        await page.route('**/monitor/api/operators', route => route.fulfill({
          json: { operators, assignments: { 'entry-z': 1, 'CAM-02': 2 } },
        }))
        await page.route('**/monitor/api/nodes', route => route.fulfill({ json: {
          cameras: [
            { id: 'entry-z', name: 'Test main entrance', zone: 'Entry', res: '1280×720', online: true },
            { id: 'CAM-02', name: 'Test parking', zone: 'Parking', res: '1280×720', online: false },
          ], operators, assignments: { 'entry-z': 1, 'CAM-02': 2 }, link: { status: 'online' },
        } }))
        await page.route('**/monitor/api/alerts', route => route.fulfill({ json: { alerts: [
          { id: 'visual-alert', cam: 'entry-z', camName: 'Test main entrance', at: Date.now(),
            sev: 'amber', type: 'Unknown person', title: 'Fixture event', route: 'fixture-operator', acked: false },
        ] } }))
        await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
        await expect(page.locator('.hero .feedimg')).toBeVisible()
        const menus = scenario === 'soc-visual'
          ? ['Live canvas', 'Archival footage', 'Detection stream', 'Alerts', 'Nodes & routing', 'Operators', 'Settings']
          : ['Live canvas', 'Archival footage', 'Camera diagnostics', 'Settings']
        const navigation = page.getByRole('navigation', { name: 'Console sections' })
        await expect(navigation.getByRole('button')).toHaveCount(menus.length)
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        for (const label of menus) {
          await nav(page, label).click()
          await expect(page.locator('#main .pagehead').last()).toBeVisible()
          await noPageOverflow(page)
          await expect.poll(() => page.locator('#main .viewfade').last().evaluate(el => getComputedStyle(el).opacity)).toBe('1')
          if ([1440, 390].includes(width) && ['Live canvas', 'Archival footage', 'Settings'].includes(label)) {
            await page.screenshot({ path: info.outputPath(`${label.replaceAll(' ', '-')}.png`) })
          }
        }
        await expect(page.locator('.switch-toggle')).toHaveCount(2)
        if (width === 1440) {
          const cards = await page.locator('.settings-grid > .set-card').all()
          const first = await cards[0].boundingBox()
          const second = await cards[1].boundingBox()
          expect(Math.abs(first.y - second.y)).toBeLessThan(2)
          expect(second.x).toBeGreaterThan(first.x + first.width)
        }
        await expect(page.locator('.switch-toggle').first()).toHaveAttribute('role', 'switch')
        for (const language of ['ไทย', 'English', '中文']) {
          await page.locator('.seg-control').first().getByRole('button', { name: language, exact: true }).click()
          await noPageOverflow(page)
        }
        expect(errors).toEqual([])
        if (scenario !== 'soc-visual') {
          expect(await navigation.getByRole('button', { name: 'Operators', exact: true }).count()).toBe(0)
          expect((await stats(request)).active).toHaveLength(1)
        } else {
          expect((await stats(request)).active).toEqual([])
          expect((await stats(request)).opened.every(id => id.startsWith('passive:'))).toBe(true)
        }
      })
    }
  }
}
