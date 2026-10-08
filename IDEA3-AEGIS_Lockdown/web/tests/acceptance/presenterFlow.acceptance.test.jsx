import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createSqliteRepository } from '../../server/repositories/sqliteRepository.js'
import App from '../../src/App.jsx'

/**
 * AEGIS IDEA3 local, non-production presenter-flow acceptance (browser UI -> real HTTP -> real server).
 *
 * The real <App/> runs in jsdom. Its fetch is bridged to a REAL listening Express app (real session, CSRF,
 * origin check, SQLite audit repository). No upstream is configured, so Live state is genuinely NOT_CONFIGURED.
 * Nothing here can reach MQTT, an ESP32, a relay, or Production.
 */
const PASSWORD = 'presenter-local-only-pw-1'
const realFetch = globalThis.fetch
let server
let repository
let origin

function bridgeFetch() {
  let cookie = ''
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('origin', origin)
    if (cookie) headers.set('cookie', cookie)
    const response = await realFetch(origin + url, { ...init, headers })
    for (const setCookie of response.headers.getSetCookie?.() ?? []) cookie = setCookie.split(';')[0]
    return response
  }
}

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: PASSWORD,
    AEGIS_WEB_BASE_PATH: '/security',
  })
  repository = createSqliteRepository({ path: ':memory:' })
  const app = createApp({ config, repository })
  server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)) })
  origin = `http://127.0.0.1:${server.address().port}`
  bridgeFetch()
  window.history.pushState({}, '', '/security/dashboard')
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await new Promise((resolve) => server.close(resolve))
  repository.close()
})

const nav = (label) => fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByText(label))
const main = () => document.querySelector('main') ?? document.body

async function signIn(password = PASSWORD) {
  render(<App />)
  fireEvent.change(await screen.findByLabelText('ชื่อผู้ดูแลระบบ'), { target: { value: 'admin' } })
  fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ Security Center' }))
}

async function enableDemo() {
  nav('ตั้งค่า')
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Demo Mode' }))
  await waitFor(() => expect(screen.getByText('DEMO')).toBeVisible())
}

describe('Security Center presenter flow against the real server', () => {
  it('rejects a wrong password with a safe message and keeps the operator signed out', async () => {
    await signIn('wrong-password')
    expect(await screen.findByRole('alert')).toHaveTextContent('เข้าสู่ระบบไม่สำเร็จ')
    expect(screen.queryByRole('navigation', { name: 'เมนูหลัก' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/stack|exception|401|bcrypt/i)
  })

  it('shows honest Live state: NOT_CONFIGURED integrations, no simulated banner, no invented incidents', async () => {
    await signIn()
    await screen.findByText('Live evidence')
    expect(screen.queryByText('DEMO')).not.toBeInTheDocument()
    expect(main().textContent).not.toMatch(/demo-inc-001|ESP32-LOCK-01/)
    nav('ตั้งค่า')
    await screen.findByRole('checkbox', { name: 'Demo Mode' })
    expect(screen.getByRole('checkbox', { name: 'Demo Mode' })).not.toBeChecked()
    nav('เหตุการณ์')
    await waitFor(() => expect(main().textContent).not.toMatch(/demo-inc-001/))
  })

  it('walks all ten pages in labelled Demo Mode, with server round-trips, then leaves no trace in the live ledger', async () => {
    await signIn()
    await screen.findByText('Live evidence')
    const liveRowsBefore = repository.queryAudit({ limit: 250 }).length

    await enableDemo()
    expect(screen.getByText('Demo evidence')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(/ข้อมูลจำลองเพื่อสาธิต UI — ไม่ใช่สถานะระบบจริง/)

    // 1. Dashboard
    nav('แดชบอร์ด')
    await waitFor(() => expect(main().textContent).toMatch(/demo-inc-001/))
    expect(main().textContent).toMatch(/ข้อมูลจำลอง ไม่ใช่ระบบจริง/)

    // 2. Overview: isolation is explicit
    nav('ภาพรวมระบบ')
    await waitFor(() => expect(main().textContent).toMatch(/isolated-demo-provider/))
    expect(main().textContent).toMatch(/Live mergeNOT ALLOWED/)

    // 3. IDEA1 and 4. IDEA2 integration examples
    nav('IDEA1 Security')
    await waitFor(() => expect(main().textContent).toMatch(/LOGIN.*DENIED.*10\.30\.0\.24/))
    nav('IDEA2 Detection')
    await waitFor(() => expect(main().textContent).toMatch(/PERSON_DETECTED.*CAM-02/))

    // 5. IDEA3 Lockdown: physical relay state is never claimed
    nav('IDEA3 Lockdown')
    await waitFor(() => expect(main().textContent).toMatch(/ESP32-LOCK-01/))
    expect(main().textContent).toMatch(/Relay evidence unavailable/)
    expect(main().textContent).toMatch(/physical sensor not configured/)
    expect(main().textContent).not.toMatch(/Relay.*CONFIRMED|PHYSICALLY CONFIRMED/i)

    // 6. Alerts: acknowledge round-trips through the server and is audited (in the simulated ledger)
    nav('การแจ้งเตือน')
    await waitFor(() => expect(main().textContent).toMatch(/demo-alert-001/))
    const before = within(main()).getAllByRole('button', { name: 'รับทราบ' }).length
    fireEvent.click(within(main()).getAllByRole('button', { name: 'รับทราบ' })[0])
    await waitFor(() => expect(within(main()).queryAllByRole('button', { name: 'รับทราบ' })).toHaveLength(before - 1))

    // 7. Incidents: correlation, stage separation, analyst note
    nav('เหตุการณ์')
    await waitFor(() => expect(main().textContent).toMatch(/demo-inc-001/))
    expect(main().textContent).toMatch(/UNKNOWNEXECUTEDไม่มีหลักฐานเวลา/)
    expect(main().textContent).toMatch(/UNKNOWNPHYSICALLY VERIFIEDไม่มีหลักฐานเวลา/)
    expect(main().textContent).toMatch(/หลักฐานทางกายภาพยังไม่ยืนยัน/)
    fireEvent.change(screen.getByLabelText('บันทึกของผู้วิเคราะห์'), { target: { value: 'ตรวจกล้อง CAM-02 ระหว่างซ้อมนำเสนอ' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกและสร้าง Audit' }))

    // 8. Audit: simulated rows + the presenter's own actions; no tamper-chain claim
    nav('บันทึกตรวจสอบ')
    await waitFor(() => expect(main().textContent).toMatch(/ACKNOWLEDGE/))
    await waitFor(() => expect(main().textContent).toMatch(/ADD_NOTE/))
    expect(main().textContent).toMatch(/demo-audit-001/)
    expect(main().textContent).toMatch(/NOT VERIFIED/)
    expect(main().textContent).not.toMatch(/ตรวจสอบ chain ล่าสุดสำเร็จ/)

    // 9. Devices: requested state is not physical evidence
    nav('อุปกรณ์')
    await waitFor(() => expect(screen.getByText('คำขอ: OPEN')).toBeVisible())
    expect(screen.getByText('หลักฐานทางกายภาพ: UNKNOWN')).toBeVisible()

    // 10. Recovery: blocked, dry-run only, cannot publish
    nav('การกู้คืน')
    await waitFor(() => expect(main().textContent).toMatch(/Recovery gateway/))
    expect(main().textContent).toMatch(/DISABLED/)
    expect(main().textContent).toMatch(/ไม่ส่ง MQTT และไม่เปลี่ยนสถานะ Relay หรือ Uplink/)
    const dryRun = screen.getByRole('button', { name: 'ตรวจสอบความพร้อมแบบ Dry-run' })
    expect(dryRun).toBeDisabled()
    fireEvent.change(screen.getByLabelText('พิมพ์ VALIDATE ONLY เพื่อยืนยัน'), { target: { value: 'RESTORE' } })
    expect(dryRun).toBeDisabled()
    fireEvent.change(screen.getByLabelText('พิมพ์ VALIDATE ONLY เพื่อยืนยัน'), { target: { value: 'VALIDATE ONLY' } })
    fireEvent.click(dryRun)
    nav('บันทึกตรวจสอบ')
    await waitFor(() => expect(main().textContent).toMatch(/DRY_RUN/))
    expect(main().textContent).toMatch(/Recovery gateway|DRY_RUN/)

    // Settings: deactivate Demo; Live is restored and untouched
    nav('ตั้งค่า')
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Demo Mode' }))
    await screen.findByText('Live evidence')
    expect(screen.queryByText('DEMO')).not.toBeInTheDocument()
    nav('บันทึกตรวจสอบ')
    await waitFor(() => expect(main().textContent).not.toMatch(/demo-audit-001|ACKNOWLEDGE|ADD_NOTE|DRY_RUN/))
    nav('การแจ้งเตือน')
    await waitFor(() => expect(main().textContent).not.toMatch(/demo-alert-001/))

    // Durable Live ledger: only the two truthful mode switches were added.
    const added = repository.queryAudit({ limit: 250 }).slice(0, repository.queryAudit({ limit: 250 }).length - liveRowsBefore)
    expect(added.map((entry) => `${entry.category}/${entry.action}`)).toEqual(['SETTINGS/DEMO_MODE', 'SETTINGS/DEMO_MODE'])
  })

  it('ends the session on logout and refuses further protected access', async () => {
    await signIn()
    await screen.findByText('Live evidence')
    fireEvent.click(screen.getByRole('button', { name: 'ออกจากระบบ' }))
    expect(await screen.findByRole('button', { name: 'เข้าสู่ Security Center' })).toBeVisible()
    expect((await globalThis.fetch('/security/api/security/snapshot')).status).toBe(401)
  })
})
