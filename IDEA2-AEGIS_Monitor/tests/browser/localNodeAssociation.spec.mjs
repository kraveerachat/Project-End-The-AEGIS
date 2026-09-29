import { expect, test } from '@playwright/test'

const token = (byte) => Buffer.alloc(32, byte).toString('base64url')
const challenge = {
  version: 1,
  purpose: 'AEGIS-BROWSER-NODE-ASSOCIATION-V1',
  audience: 'https://monitor.test.invalid',
  challenge_id: token(1),
  challenge_nonce: token(2),
  session_binding: token(3),
  issued_at_ms: 1_000,
  expires_at_ms: 31_000,
}
const assertion = {
  claims: { ...challenge, node_id: 'machine-a-node', key_version: 4 },
  signature: Buffer.alloc(64, 4).toString('base64url'),
}

async function emptyOperator(page, request) {
  await request.get('/__fixture/reset?scenario=empty')
  await page.goto('/monitor/')
  await expect(page.getByText('No cameras assigned')).toBeVisible()
}

test('invisible Operator association relays public proof and stores no browser authority', async ({ page, request }) => {
  const calls = []
  await page.route('**/monitor/api/local-node/challenge', async (route) => {
    calls.push('challenge')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(challenge) })
  })
  await page.route('http://127.0.0.1:8078/v1/browser-association/assert', async (route) => {
    calls.push('agent')
    expect(route.request().headers().cookie).toBeUndefined()
    expect(route.request().postDataJSON()).toEqual(challenge)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(assertion) })
  })
  await page.route('**/monitor/api/local-node/verify', async (route) => {
    calls.push('verify')
    expect(route.request().postDataJSON()).toEqual(assertion)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ associated: true, expiresAt: Date.now() + 300_000 }) })
  })

  await emptyOperator(page, request)
  await expect.poll(() => calls.join(',')).toBe('challenge,agent,verify')
  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }))
  expect(browserStorage.session).toEqual({})
  expect(browserStorage.local).toEqual({
    aegis_lang: 'th',
    aegis_shell_theme: 'light',
  })
  await expect(page.locator('body')).not.toContainText(/local node|association/i)
})

test('Agent unavailability keeps the authenticated UI honest and creates no camera stream', async ({ page, request }) => {
  let verifyCalls = 0
  let streamCalls = 0
  await page.route('**/monitor/api/local-node/challenge', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(challenge) }))
  await page.route('http://127.0.0.1:8078/**', (route) => route.abort('connectionrefused'))
  await page.route('**/monitor/api/local-node/verify', (route) => { verifyCalls += 1; return route.abort() })
  await page.route('**/monitor/api/cameras/*/stream', (route) => { streamCalls += 1; return route.abort() })

  await emptyOperator(page, request)
  await page.waitForTimeout(100)
  await expect(page.getByText('No cameras assigned')).toBeVisible()
  expect(verifyCalls).toBe(0)
  expect(streamCalls).toBe(0)
})

test('SOC session does not initiate local-node association', async ({ page, request }) => {
  let associationCalls = 0
  await request.get('/__fixture/reset?scenario=two-cameras')
  await page.route('**/monitor/api/local-node/**', (route) => { associationCalls += 1; return route.abort() })
  await page.goto('/monitor/')
  await expect(page.getByText('Test SOC')).toBeVisible()
  await page.waitForTimeout(100)
  expect(associationCalls).toBe(0)
})
