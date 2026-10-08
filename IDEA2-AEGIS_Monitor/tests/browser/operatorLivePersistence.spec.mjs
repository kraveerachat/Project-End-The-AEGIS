import { test, expect } from '@playwright/test'

const stats = async request => (await request.get('/__fixture/stats')).json()
const nav = (page, label) => page.getByRole('navigation', { name: 'Console sections' })
  .getByRole('button', { name: label, exact: true })

async function openSingleCamera(page, request, scenario = 'single-camera') {
  await request.post(`/__fixture/reset?scenario=${scenario}`)
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  const cameraId = scenario === 'single-camera-2' ? 'CAM-02' : 'entry-z'
  await expect.poll(async () => (await stats(request)).active).toEqual([cameraId])
  return cameraId
}

test.beforeEach(async ({ request }) => { await request.post('/__fixture/reset') })

test('authenticated Operator without an activated or permitted Live view creates no viewer', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=no-live-menu')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Archival footage' })).toBeVisible()
  await expect(page.locator('.hero')).toHaveCount(0)
  const idle = await stats(request)
  expect(idle.opened).toEqual([])
  expect(idle.active).toEqual([])
})

test('historical detection cannot paint a fabricated box over the current Operator stream', async ({ page, request }) => {
  await openSingleCamera(page, request)
  await expect(page.locator('.acpanel')).toContainText('Fixture Alice')
  await expect(page.locator('.hero .feedimg')).toBeVisible()
  await expect(page.locator('.hero .bbox')).toHaveCount(0)
})

test('re-authenticating on Archive does not activate Live until Operator selects it', async ({ page, request }) => {
  const cameraId = await openSingleCamera(page, request)
  await nav(page, 'Archival footage').click()
  await request.post('/__fixture/expire')
  await expect(page.locator('#mon-username')).toBeVisible({ timeout: 8000 })
  await expect.poll(async () => (await stats(request)).active).toEqual([])
  const beforeLogin = await stats(request)

  await page.locator('#mon-username').fill('fixture-operator')
  await page.locator('#mon-password').fill('fixture-password')
  await page.locator('form button[type="submit"]').click()
  await expect(page.getByRole('heading', { name: 'Archival footage' })).toBeVisible()
  const afterLogin = await stats(request)
  expect(afterLogin.opened).toEqual(beforeLogin.opened)
  expect(afterLogin.active).toEqual([])
  await nav(page, 'Live canvas').click()
  await expect.poll(async () => (await stats(request)).active).toEqual([cameraId])
})

test('Operator keeps the same single-camera viewer through Archive, Diagnostics, Settings and Live', async ({ page, request }) => {
  const cameraId = await openSingleCamera(page, request)
  const initial = await stats(request)
  expect(initial.opened.length).toBeGreaterThan(0)
  const initialCloseCount = initial.closed.length

  for (const label of ['Archival footage', 'Camera diagnostics', 'Settings']) {
    await nav(page, label).click()
    await expect(page.locator('.hero .feedimg')).toHaveCount(1)
    await expect(page.locator('.hero')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Toggle fullscreen feed' })).toHaveCount(0)
    const during = await stats(request)
    expect(during.active).toEqual([cameraId])
    expect(during.opened).toEqual(initial.opened)
    expect(during.closed).toHaveLength(initialCloseCount)
  }

  await nav(page, 'Live canvas').click()
  await expect(page.locator('.hero')).toBeVisible()
  const returned = await stats(request)
  expect(returned.active).toEqual([cameraId])
  expect(returned.opened).toEqual(initial.opened)
  expect(returned.closed).toHaveLength(initialCloseCount)
})

test('Operator logout from Archive closes the retained viewer', async ({ page, request }) => {
  const cameraId = await openSingleCamera(page, request)
  const before = await stats(request)
  await nav(page, 'Archival footage').click()
  await expect.poll(async () => (await stats(request)).active).toEqual([cameraId])
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect.poll(async () => (await stats(request)).active).toEqual([])
  const after = await stats(request)
  expect(after.opened).toEqual(before.opened)
  expect(after.closed.length).toBe(before.closed.length + 1)
  expect(after.closed.at(-1)).toBe(cameraId)
})

test('session expiry while Operator is on Archive tears down the retained viewer', async ({ page, request }) => {
  const cameraId = await openSingleCamera(page, request)
  await nav(page, 'Archival footage').click()
  await expect.poll(async () => (await stats(request)).active).toEqual([cameraId])
  await request.post('/__fixture/expire')
  await expect.poll(async () => (await stats(request)).active, { timeout: 8000 }).toEqual([])
  expect((await stats(request)).closed).toContain(cameraId)
  await expect(page.locator('.hero')).toHaveCount(0)
})

for (const scenario of ['single-camera', 'single-camera-2']) {
  test(`single-camera Operator ${scenario} has only the hero video, without a selector`, async ({ page, request }, info) => {
    const cameraId = await openSingleCamera(page, request, scenario)
    await expect(page.locator('.hero .feedimg')).toBeVisible()
    await expect(page.locator('.camera-selector')).toHaveCount(0)
    await expect(page.getByText('Cameras (1)')).toHaveCount(0)
    await expect(page.locator('.camera-preview')).toHaveCount(0)
    await expect(page.locator('.feedimg')).toHaveCount(1)
    await expect(page.locator('.acpanel')).toBeVisible()
    await expect(page.locator('.streampanel')).toBeVisible()
    expect((await stats(request)).active).toEqual([cameraId])
    if (scenario === 'single-camera') {
      await page.screenshot({ path: info.outputPath('single-camera-operator.png'), fullPage: true })
    }
  })
}

test('multi-camera Operator retains the selector and camera-switch cleanup', async ({ page, request }) => {
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.camera-selector')).toBeVisible()
  await expect.poll(async () => (await stats(request)).active.sort()).toEqual(['CAM-02', 'entry-z'])
  const oldImage = await page.locator('.hero .feedimg').elementHandle()
  await page.getByRole('button', { name: 'View CAM-02 — Test parking', exact: true }).click()
  await expect(page.locator('.hero .feedimg')).toHaveAttribute('src', /\/CAM-02\/stream\?t=0$/)
  expect(await oldImage.getAttribute('src')).toBeNull()
  await expect.poll(async () => (await stats(request)).closed).toContain('entry-z')
})

test('SOC passive Live releases its viewer on navigation without retaining demand', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=soc-passive')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.camera-selector')).toBeVisible()
  await expect.poll(async () => (await stats(request)).active).toEqual(['passive:opaque-view-a'])
  await nav(page, 'Archival footage').click()
  await expect.poll(async () => (await stats(request)).active).toEqual([])
  await expect(page.locator('.hero')).toHaveCount(0)
})
