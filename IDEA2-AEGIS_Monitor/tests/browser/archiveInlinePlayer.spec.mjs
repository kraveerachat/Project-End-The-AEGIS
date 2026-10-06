import { test, expect } from '@playwright/test'

const firstStart = Date.parse('2026-10-05T14:23:00Z')
const clips = [
  { id: 'clip-300', cam: 'entry-z', camName: 'Main entrance', nodeId: 'node-a', start: firstStart,
    durationSec: 300, kind: 'auth', hasAuthorized: true, hasUnknown: false, segs: [{ k: 'ok', w: 100 }] },
  { id: 'clip-83', cam: 'CAM-02', camName: 'Test parking', nodeId: 'node-a', start: firstStart + 300_000,
    durationSec: 83, kind: 'unknown', hasAuthorized: true, hasUnknown: true,
    segs: [{ k: 'ok', w: 60 }, { k: 'warn', w: 40 }] },
  { id: 'hidden-clip', cam: 'restricted-9', camName: 'Restricted camera', start: firstStart,
    durationSec: 300, kind: 'auth', segs: [{ k: 'ok', w: 100 }] },
]

test('Archive plays each scoped clip in its fixed card media region, without an expanded player', async ({ page, request }, info) => {
  await request.post('/__fixture/reset?scenario=two-cameras')
  await page.route('**/monitor/api/clips', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ clips }),
  }))
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('navigation', { name: 'Console sections' })
    .getByRole('button', { name: 'Archival footage', exact: true }).click()

  const cards = page.locator('.clipgrid article.clip')
  await expect(cards).toHaveCount(2)
  await expect(page.getByText('Restricted camera')).toHaveCount(0)

  for (const [index, id] of ['clip-300', 'clip-83'].entries()) {
    const card = cards.nth(index)
    const player = card.locator('.clipthumb video')
    await expect(player).toHaveCount(1)
    await expect(player).toHaveAttribute('src', `/monitor/api/clips/${id}/video`)
    await expect(player).toHaveAttribute('controls', '')
    await expect(player).toHaveAttribute('preload', 'metadata')
    await expect(player).not.toHaveAttribute('autoplay')
    await expect(card.locator('video')).toHaveCount(1)
    await expect(card.locator('.clipdetail')).toHaveCount(0)
    await expect(card.locator('button.clipthumb')).toHaveCount(0)
    await expect(card.getByRole('link', { name: /Download/ }))
      .toHaveAttribute('href', `/monitor/api/clips/${id}/download`)
    const mediaBox = await card.locator('.clipthumb').boundingBox()
    expect(mediaBox?.height).toBeGreaterThan(0)
    expect(mediaBox?.width / mediaBox?.height).toBeCloseTo(16 / 9, 1)
  }

  await expect(cards.nth(0)).toContainText('5:00')
  await expect(cards.nth(0)).toContainText('entry-z · Main entrance · node-a')
  await expect(cards.nth(0)).toContainText('5 ต.ค. 2569')
  await expect(cards.nth(0)).toContainText('21:23:00')
  await expect(cards.nth(0)).toContainText('Authorized only')
  await expect(cards.nth(1)).toContainText('1:23')
  await expect(cards.nth(1)).toContainText('CAM-02 · Test parking · node-a')
  await expect(cards.nth(1)).toContainText('Unknown present')
  await page.screenshot({ path: info.outputPath('archive-inline-player.png'), fullPage: true })

  await page.getByLabel('Result').selectOption('unknown')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('CAM-02')
  await page.getByLabel('Camera').selectOption('entry-z')
  await expect(cards).toHaveCount(0)
  await page.getByRole('button', { name: 'Reset filters' }).click()
  await expect(cards).toHaveCount(2)
})

test('attributed clip shows neutral detection result and never enters Authorized or Unknown filters', async ({ page, request }, info) => {
  await request.post('/__fixture/reset?scenario=two-cameras')
  await page.route('**/monitor/api/clips', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ clips: [
      { id: 'attributed', cam: 'entry-z', camName: 'Main entrance', start: firstStart,
        durationSec: 83, kind: 'unavailable', live: false, segs: [] },
    ] }),
  }))
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('navigation', { name: 'Console sections' })
    .getByRole('button', { name: 'Archival footage', exact: true }).click()
  const cards = page.locator('.clipgrid article.clip')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Detection result unavailable')
  await expect(cards.first()).not.toContainText('Authorized only')
  await expect(cards.first()).not.toContainText('Unknown')
  await expect(cards.first().locator('video')).toHaveAttribute('src', '/monitor/api/clips/attributed/video')
  await expect(cards.first().getByRole('link', { name: /Download/ }))
    .toHaveAttribute('href', '/monitor/api/clips/attributed/download')
  await page.screenshot({ path: info.outputPath('archive-neutral-result.png'), fullPage: true })
  await page.getByLabel('Result').selectOption('auth')
  await expect(cards).toHaveCount(0)
  await page.getByLabel('Result').selectOption('unknown')
  await expect(cards).toHaveCount(0)
  await page.getByLabel('Result').selectOption('all')
  await expect(cards).toHaveCount(1)
})
