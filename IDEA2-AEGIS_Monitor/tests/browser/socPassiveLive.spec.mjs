import { test, expect } from '@playwright/test'

const stats = async request => (await request.get('/__fixture/stats')).json()

test('idle SOC has no camera viewer, even when logical link telemetry says online', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=soc-idle')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('No active Operator live views')).toBeVisible()
  await expect(page.locator('.feedimg')).toHaveCount(0)
  expect((await stats(request)).opened).toEqual([])
})

test('SOC selects distinct same-alias Node sources without an Engine or logical camera request', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=soc-passive')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('group', { name: 'Active Operator views' }).getByRole('button')).toHaveCount(2)
  await expect(page.getByRole('button', { name: /CAM-01.*machine-a/i })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.hero .feedimg')).toHaveAttribute('src', /\/api\/live\/active-views\/opaque-view-a\/stream/)
  await expect(page.locator('.acpanel')).toContainText('Machine A person')
  await expect(page.locator('.canvasR')).not.toContainText('Machine B person')
  await expect.poll(async () => (await stats(request)).active).toEqual(['passive:opaque-view-a'])
  await page.getByRole('button', { name: /CAM-01.*machine-b/i }).click()
  await expect(page.locator('.hero .feedimg')).toHaveAttribute('src', /\/api\/live\/active-views\/opaque-view-b\/stream/)
  await expect(page.locator('.acpanel')).toContainText('Machine B person')
  await expect(page.locator('.canvasR')).not.toContainText('Machine A person')
  await expect.poll(async () => (await stats(request)).active).toEqual(['passive:opaque-view-b'])
  expect((await stats(request)).opened.every(id => id.startsWith('passive:'))).toBe(true)
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await expect.poll(async () => (await stats(request)).active).toEqual([])
})
