import { test, expect } from '@playwright/test'

const words = {
  th: ['ภาพสด', 'วิดีโอย้อนหลัง', 'การวินิจฉัยกล้อง', 'การตั้งค่า', 'สตรีมการตรวจจับ', 'การแจ้งเตือน', 'โหนดและการกำหนดเส้นทาง', 'ผู้ปฏิบัติงาน'],
  en: ['Live canvas', 'Archival footage', 'Camera diagnostics', 'Settings', 'Detection stream', 'Alerts', 'Nodes & routing', 'Operators'],
  zh: ['实时画面', '历史录像', '摄像头诊断', '设置', '检测事件流', '警报', '节点与路由', '操作员'],
}
const stats = async request => (await request.get('/__fixture/stats')).json()
for (const scenario of ['single-camera', 'single-camera-2', 'soc-visual']) {
  for (const lang of ['th', 'en', 'zh']) {
    test(`${scenario}: ${lang} applies to every permitted page without changing authority`, async ({ page, request }) => {
      await request.post(`/__fixture/reset?scenario=${scenario}`)
      await page.addInitScript(() => { if (!localStorage.getItem('aegis_lang')) localStorage.setItem('aegis_lang', 'en') })
      await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.hero .feedimg')).toBeVisible()
      await expect.poll(async () => (await stats(request)).opened.length).toBe(1)
      await page.locator('.side .nav').last().click()
      const before = await stats(request)
      await page.getByRole('button', { name: { th: 'ไทย', en: 'English', zh: '中文' }[lang], exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('lang', lang === 'zh' ? 'zh-CN' : lang)
      const menu = scenario === 'soc-visual' ? [0, 1, 4, 5, 6, 7, 3] : [0, 1, 2, 3]
      await expect(page.locator('.side .nav')).toHaveText(menu.map(i => words[lang][i]))
      expect(await page.locator('.side .nav, .side .navsec').evaluateAll(elements =>
        elements.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent))).toEqual([])
      expect((await stats(request)).opened).toEqual(before.opened)
      expect((await stats(request)).closed).toEqual(before.closed)
      for (let i = 0; i < menu.length; i++) {
        await page.locator('.side .nav').nth(i).click()
        if (menu[i] === 0) await expect(page.locator('.hero')).toBeVisible()
        else await expect(page.locator('#main .h1:visible')).toContainText(new RegExp(words[lang][menu[i]], 'i'))
        await page.setViewportSize({ width: 390, height: 844 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
        await page.setViewportSize({ width: 1440, height: 1000 })
      }
      if (scenario !== 'soc-visual') {
        const after = await stats(request)
        expect(after.opened).toEqual(before.opened)
        expect(after.closed).toEqual(before.closed)
        expect(after.active).toEqual(before.active)
        expect(await page.locator('.side .nav').count()).toBe(4)
      }
      // A second tab inherits the saved preference, not a language prop in tests.
      await page.context().newPage().then(async p => {
        await p.goto('/monitor/', { waitUntil: 'domcontentloaded' })
        await expect(p.locator('html')).toHaveAttribute('lang', lang === 'zh' ? 'zh-CN' : lang)
        await p.close()
      })
      await expect(page.locator('.side .nav').last()).toHaveText(words[lang][3])
      await page.locator('.topbar .iconbtn').last().click()
      await expect(page.locator('#mon-username')).toBeVisible()
      await expect.poll(async () => (await stats(request)).active).toEqual([])
      await expect(page.locator('html')).toHaveAttribute('lang', lang === 'zh' ? 'zh-CN' : lang)
    })
  }
}

test('translated multi-camera preview keeps the selected canvas and stream connections', async ({ page, request }) => {
  await request.post('/__fixture/reset')
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.camera-preview canvas')).toBeVisible()
  const initial = await stats(request)
  await page.locator('.side .nav').last().click()
  await page.getByRole('button', { name: '中文', exact: true }).click()
  await page.locator('.side .nav').first().click()
  await expect(page.locator('.camera-preview canvas')).toHaveAttribute('aria-label', /实时预览 — entry-z/)
  expect((await stats(request)).opened).toEqual(initial.opened)
  expect((await stats(request)).closed).toEqual(initial.closed)
  expect(errors).toEqual([])
  await expect(page.locator('.hero .bbox')).toHaveCount(0)
})

test('invalid stored language safely falls back without restarting the viewer', async ({ page, request }) => {
  await request.post('/__fixture/reset?scenario=single-camera')
  await page.goto('/monitor/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.hero .feedimg')).toBeVisible()
  const before = await stats(request)
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', {
    key: 'aegis_lang', newValue: 'invalid',
  })))
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
  await expect(page.locator('.side .nav').first()).toHaveText('ภาพสด')
  expect((await stats(request)).opened).toEqual(before.opened)
  expect((await stats(request)).closed).toEqual(before.closed)
})
