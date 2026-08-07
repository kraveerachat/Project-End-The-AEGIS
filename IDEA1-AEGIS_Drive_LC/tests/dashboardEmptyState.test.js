import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import {
  createEmptyDashboardData,
  normalizeDashboardData,
  shouldShowDashboardFetchError,
} from '../src/lib/dashboardState.js'
import { isPlatformWired } from '../src/lib/fetchState.js'
import { makeT } from '../src/lib/strings.js'

test('Dashboard data ที่ยังไม่เชื่อม backend มีโครงครบและใช้ค่าศูนย์/รายการว่าง', () => {
  const data = createEmptyDashboardData()

  assert.deepEqual(data.metrics, {
    storageBytes: 0,
    storageTotalBytes: 0,
    dataLakeBytes: 0,
    files: 0,
    activeShares: 0,
  })
  assert.equal(data.securityAlerts, 0)
  assert.deepEqual(data.shares, [])
  assert.deepEqual(data.loginHistory, [])
  assert.deepEqual(data.activity7d, [])
  assert.deepEqual(data.recentFiles, [])
})

test('Dashboard รับข้อมูลจริงมาทับ placeholder ได้โดยไม่เปลี่ยน layout contract', () => {
  const data = normalizeDashboardData({
    metrics: { storageBytes: 5_000, storageTotalBytes: 20_000, files: 3 },
    securityAlerts: 2,
    shares: [{ id: 'share-1' }],
    recentFiles: null,
  })

  assert.equal(data.metrics.storageBytes, 5_000)
  assert.equal(data.metrics.storageTotalBytes, 20_000)
  assert.equal(data.metrics.files, 3)
  assert.equal(data.metrics.activeShares, 0)
  assert.equal(data.securityAlerts, 2)
  assert.deepEqual(data.shares, [{ id: 'share-1' }])
  assert.deepEqual(data.recentFiles, [])
})

test('แสดง fetch error เฉพาะเมื่อ health ยืนยันว่า platform เชื่อมต่ออยู่', () => {
  assert.equal(shouldShowDashboardFetchError('server', { ok: true }), true)
  assert.equal(shouldShowDashboardFetchError('network', null), false)
  assert.equal(shouldShowDashboardFetchError('timeout', { ok: false }), false)
  assert.equal(shouldShowDashboardFetchError(null, { ok: true }), false)
})

test('in-memory fallback ยังไม่ใช่ platform ที่เชื่อมต่อ — ไม่ขึ้นกล่อง error ทับ empty state', () => {
  assert.equal(shouldShowDashboardFetchError('server', { ok: true, db: 'memory' }), false)
  assert.equal(shouldShowDashboardFetchError('network', { ok: true, db: 'memory' }), false)
  assert.equal(shouldShowDashboardFetchError('server', { ok: true, db: 'postgres' }), true)
})

test('Dashboard placeholder ขึ้นกับ health เท่านั้น ไม่เปลี่ยนเพราะ dashboard payload เป็น null', () => {
  assert.equal(!isPlatformWired({ ok: true, db: 'memory' }), true)
  assert.equal(!isPlatformWired({ ok: true, db: 'postgres' }), false)
  assert.equal(!isPlatformWired(null), true)
})

test('Dashboard ห้าม early-return เป็น error page จนกริดการ์ดหายทั้งหน้า', async () => {
  const source = await fs.readFile(new URL('../src/screens/Dashboard.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /if\s*\(dash\.error\)\s*return\s*<ErrorState/)
  assert.match(source, /const usingPlaceholder = !isPlatformWired\(health\.data\)/)
  assert.doesNotMatch(source, /useApi\(['"]\/healthz['"]/)
  assert.match(source, /normalizeDashboardData\(usingPlaceholder \? null : dash\.data\)/)
  assert.match(source, /usage=\{usingPlaceholder \? \{\} : storage\.data\?\.usage/)
})

test('Vite dev proxy ส่ง health check ไป backend เพื่อไม่สร้างสถานะ offline ปลอม', async () => {
  const source = await fs.readFile(new URL('../vite.config.js', import.meta.url), 'utf8')
  assert.match(source, /['"]\/drive\/healthz['"]\s*:/)
})

test('Sidebar ใช้ byte metrics ชุดเดียวกับ Dashboard และไม่มี total 1024 GB ที่แต่งขึ้น', async () => {
  const source = await fs.readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /metrics\?\.storageGB|metrics\?\.storageTotalGB|\?\?\s*1024/)
  assert.match(source, /metrics\?\.storageBytes/)
  assert.match(source, /metrics\?\.storageTotalBytes/)
})

test('Uploads ปกติบอกตามจริงว่า Data Lake ยังไม่มี encryption at rest', () => {
  assert.equal(makeT('en')('dropSub'), 'Stored in the Data Lake · encryption at rest is not configured')
  assert.equal(makeT('th')('dropSub'), 'จัดเก็บใน Data Lake · ยังไม่ได้เปิดใช้การเข้ารหัสขณะจัดเก็บ')
  assert.equal(makeT('th')('layerStorageDesc'), 'Data Lake · ยังไม่เข้ารหัสขณะจัดเก็บ')
  assert.equal(makeT('zh')('dropSub'), '存储到 Data Lake · 尚未配置静态加密')
})

test('Dashboard ไม่มี Demo Override และ Files ต้องเรียก verify endpoint จริง', async () => {
  const [dashboard, files, uploads] = await Promise.all([
    fs.readFile(new URL('../src/screens/Dashboard.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/screens/Files.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/screens/Uploads.jsx', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(dashboard, /demoOpen|setOverride|demoForce|demoControls|FlaskConical/)
  assert.match(files, /apiFetch\(`\/api\/files\/\$\{encodeURIComponent\(file\.id\)\}\/verify`/)
  assert.doesNotMatch(files, /willFail\s*=|file\.verified\s*\|\|\s*verifyState/)
  assert.doesNotMatch(uploads, /file becoming ciphertext|ไฟล์ถูกเข้ารหัสก่อนแตะดิสก์/)
})

test('P1 labels ระบุ semantic scope จริง และทุกจอ format ความจุจาก byte helper เดียวกัน', async () => {
  const [sidebar, dashboard, access] = await Promise.all([
    fs.readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/screens/Dashboard.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/screens/Access.jsx', import.meta.url), 'utf8'),
  ])

  assert.match(sidebar, /fmtBytes\(storageBytes\)/)
  assert.match(sidebar, /fmtBytes\(totalBytes\)/)
  assert.doesNotMatch(sidebar, /\/\s*1e9/)
  assert.match(dashboard, /valueLabel=\{hasCapacity \? fmtBytes\(m\.storageBytes\)/)
  assert.doesNotMatch(dashboard, /m\.storageBytes\s*\/\s*1e9/)

  assert.equal(makeT('th')('statSecurity'), 'เหตุการณ์ DENIED/BLOCKED (100 รายการล่าสุด)')
  assert.equal(makeT('th')('accountReady'), 'บัญชีพร้อมใช้งาน')
  assert.equal(makeT('th')('sessionsThisInstance'), 'เซสชัน (อินสแตนซ์นี้)')
  assert.match(access, /t\('accountReady'\)/)
  assert.match(access, /u\.activeSessions/)
})
