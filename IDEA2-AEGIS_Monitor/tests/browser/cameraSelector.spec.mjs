import { test, expect } from '@playwright/test'

const first = 'View entry-z — Test main entrance'
const second = 'View CAM-02 — Test parking'
const offline = 'View offline-7 — Test reception'
const stats = async request => (await request.get('/__fixture/stats')).json()
const activeIds = async request => (await stats(request)).active.sort()
const normalStreams = ['CAM-02', 'entry-z']
const card = (page, name) => page.getByRole('button', { name, exact: true })

test.beforeEach(async ({ request }) => { await request.post('/__fixture/reset') })

test('App defaults to server order with live previews and a zero-request selected mirror', async ({ page, request }) => {
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('group', { name: 'Assigned cameras' }).getByRole('button')).toHaveCount(3)
  await expect(card(page, first)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Restricted fixture camera')).toHaveCount(0)
  await expect(page.getByText('Hidden Person')).toHaveCount(0)
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  await expect(page.locator('.feedimg')).toHaveCount(2)
  await expect(card(page, second).locator('.feedimg')).toHaveCount(1)
  await expect(card(page, second)).toContainText('Live')
  await expect(card(page, first)).toContainText('Live')
  await expect(card(page, first).locator('img')).toHaveCount(0)
  await expect.poll(() => card(page, first).locator('canvas').evaluate(canvas =>
    canvas.getContext('2d').getImageData(160, 90, 1, 1).data[3])).toBeGreaterThan(0)
  expect((await stats(request)).opened.filter(id => id === 'entry-z')).toHaveLength(1)
  const mirrored = card(page, first).locator('canvas')
  const firstFrame = await mirrored.evaluate(canvas => canvas.toDataURL())
  await expect.poll(() => mirrored.evaluate(canvas => canvas.toDataURL())).not.toBe(firstFrame)
})

test('switch changes stream/header/selection/both panels and closes the old connection', async ({ page, request }) => {
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  const oldImage = await page.locator('.hero .feedimg').elementHandle()
  await expect(card(page, first).locator('canvas')).toHaveCount(1)
  const oldCanvas = await card(page, first).locator('canvas').elementHandle()
  await card(page, second).click()
  await expect(card(page, second)).toHaveAttribute('aria-pressed', 'true')
  await expect(card(page, first)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.hero .hchip').first()).toContainText('CAM-02 · Test parking')
  await expect(page.locator('.hero .feedimg')).toHaveAttribute('src', /\/CAM-02\/stream\?t=0$/)
  await expect(page.locator('.acpanel')).toContainText('Fixture Bob')
  await expect(page.locator('.acpanel')).not.toContainText('Fixture Alice')
  await expect(page.locator('.streampanel')).toContainText('Fixture Bob')
  await expect(page.locator('.streampanel')).not.toContainText('Fixture Alice')
  expect(await oldImage.getAttribute('src')).toBeNull()
  expect(await oldCanvas.evaluate(canvas => canvas.getContext('2d').getImageData(160, 90, 1, 1).data[3])).toBe(0)
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  await expect.poll(async () => (await stats(request)).closed).toContain('entry-z')
  await card(page, first).click()
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
})

test('offline selection removes the main image/context while other live previews remain', async ({ page, request }) => {
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  await card(page, offline).click()
  await expect(page.getByText('Camera offline', { exact: true })).toBeVisible()
  await expect(page.locator('.hero .feedimg')).toHaveCount(0)
  await expect(page.locator('.acpanel')).toContainText('offline-7')
  await expect(page.locator('.acpanel')).toContainText('No recent detection')
  await expect(page.locator('.canvasR')).not.toContainText('Fixture Alice')
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  expect((await stats(request)).opened).not.toContain('offline-7')
})

test('empty assignment is safe and creates no viewer', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=empty')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('No cameras assigned', { exact: true })).toBeVisible()
  await expect(page.locator('.camera-option')).toHaveCount(0)
  await expect(page.locator('.feedimg')).toHaveCount(0)
  expect((await stats(request)).opened).toEqual([])
})

test('leaving Live cancels both main and thumbnail retries', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=error')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Stream interrupted — reconnecting…')).toBeVisible()
  await card(page, second).click()
  await expect.poll(async () => (await stats(request)).active).toEqual(['CAM-02'])
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await expect.poll(async () => (await stats(request)).active).toEqual([])
  const entryRequests = (await stats(request)).opened.filter(id => id === 'entry-z').length
  // Deliberately cross the existing 2s retry deadline, not just React teardown.
  await page.waitForTimeout(2400)
  expect((await stats(request)).opened.filter(id => id === 'entry-z')).toHaveLength(entryRequests)
})

test('server availability loss unmounts the current viewer', async ({ page, request }) => {
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  await request.post('/__fixture/offline')
  await expect(page.getByText('Camera offline', { exact: true })).toBeVisible({ timeout: 8000 })
  await expect.poll(async () => (await stats(request)).active).toEqual([])
})

test('session expiry clears the selector and its viewer', async ({ page, request }) => {
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  await request.post('/__fixture/expire')
  await expect(page.locator('.camera-option')).toHaveCount(0, { timeout: 8000 })
  await expect.poll(async () => (await stats(request)).active).toEqual([])
})

test('idle capture with server-advertised stream remains demandable', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=idle')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  await expect(page.locator('.hero .feedimg')).toHaveCount(1)
})

test('latest unknown detection cannot inherit an older authorization', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=unknown')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.acpanel')).toContainText('No authorization in the latest detection.')
  await expect(page.locator('.acpanel')).not.toContainText('Access authorized')
  await expect(page.locator('.hero')).toContainText('UNKNOWN IN FRAME')
})

test('closing the browser page releases its multipart viewer', async ({ page, request }) => {
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
  await page.close()
  await expect.poll(async () => (await stats(request)).active).toEqual([])
})

test('desktop selector has three live preview columns below the main feed', async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(card(page, first)).toContainText('Live')
  const hero = await page.locator('.hero').boundingBox()
  const selector = await page.locator('.camera-selector').boundingBox()
  const boxes = await page.locator('.camera-option').evaluateAll(nodes => nodes.map(node => {
    const { x, y, width } = node.getBoundingClientRect()
    return { x, y, width }
  }))
  expect(selector.y).toBeGreaterThanOrEqual(hero.y + hero.height)
  expect(boxes).toHaveLength(3)
  expect(boxes[1].y).toBeCloseTo(boxes[0].y, 0)
  expect(boxes[2].y).toBeCloseTo(boxes[0].y, 0)
  expect(boxes[2].x).toBeGreaterThan(boxes[1].x)
  await expect(page.getByRole('button', { name: 'Next cameras' })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('selector-three-columns.png'), fullPage: true })
})

test('SOC with two server cameras gets two working choices, not a fabricated third camera', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=two-cameras')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.camera-option')).toHaveCount(2)
  await expect(page.getByText('Test SOC', { exact: true })).toBeVisible()
  await card(page, second).click()
  await expect(page.locator('.hero .hchip').first()).toContainText('CAM-02 · Test parking')
  await expect(page.locator('.acpanel')).toContainText('Fixture Bob')
  await expect(page.locator('.streampanel')).toContainText('Fixture Bob')
  await expect.poll(() => activeIds(request)).toEqual(normalStreams)
})

for (const width of [360, 768, 1024, 1440]) {
  test('all cards are selectable without viewport overflow at ' + width, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
    await expect(card(page, first)).toBeVisible()
    await page.getByRole('button', { name: 'Next cameras' }).click()
    await expect(card(page, 'View extra-8 — Test side entrance')).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Previous cameras' }).click()
    await card(page, second).focus()
    await page.keyboard.press('Enter')
    await expect(card(page, second)).toHaveAttribute('aria-pressed', 'true')
    await card(page, first).click()
    await expect(card(page, first)).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.locator('.hero .feedimg').evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
    await expect(card(page, first)).toContainText('Live')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect((await page.locator('.hero').boundingBox()).height).toBeGreaterThanOrEqual(340)
    if (width === 1024) {
      const selector = await page.locator('.camera-selector').boundingBox()
      const access = await page.locator('.acpanel').boundingBox()
      expect(access.y).toBeGreaterThanOrEqual(selector.y + selector.height)
      expect(access.width).toBeGreaterThanOrEqual(250)
      expect(await page.locator('.acpanel').evaluate(panel => panel.scrollWidth <= panel.clientWidth + 1)).toBe(true)
    }
    expect(errors).toEqual([])
    await page.screenshot({ path: info.outputPath('selector-' + width + '.png'), fullPage: true })
  })
}

test('paging bounds demand to three cameras and releases every old-page viewer', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=all-streams')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => activeIds(request)).toEqual(['CAM-02', 'entry-z', 'offline-7'])
  await expect(page.locator('.camera-preview img')).toHaveCount(2)
  await expect(card(page, first).locator('canvas')).toHaveCount(1)
  expect((await stats(request)).opened).not.toContain('extra-8')
  await page.getByRole('button', { name: 'Next cameras' }).click()
  await expect.poll(() => activeIds(request)).toEqual(['extra-8'])
  await expect(page.locator('.camera-option')).toHaveCount(1)
  await expect(page.locator('.hero .hchip').first()).toContainText('extra-8')
  await expect(page.locator('.canvasR')).toContainText('No recent detection')
  for (const id of ['CAM-02', 'entry-z', 'offline-7']) expect((await stats(request)).closed).toContain(id)
  await page.getByRole('button', { name: 'Previous cameras' }).click()
  await expect.poll(() => activeIds(request)).toEqual(['CAM-02', 'entry-z', 'offline-7'])
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await expect.poll(() => activeIds(request)).toEqual([])
})

test('light theme preserves readable, selected camera cards', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('aegis_theme', 'light'))
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(card(page, first)).toContainText('Live')
  await expect(card(page, first)).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: info.outputPath('selector-light.png'), fullPage: true })
})
