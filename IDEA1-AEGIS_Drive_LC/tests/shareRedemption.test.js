// tests/shareRedemption.test.js — AEGIS Drive (IDEA1) · ลิงก์แชร์ที่ไถ่ได้จริง
//
// ยิงผ่าน Express app ตัวเดียวกับ production (server/app.js) — ไม่มีการ mock
//
// สิ่งที่ชุดนี้พิสูจน์ (ก่อนหน้านี้ไม่มีข้อไหนเป็นจริงเลย — จอสร้างแถวได้ แต่ไม่มีคอลัมน์
// token ไม่มี endpoint ไถ่ลิงก์ ไม่มี URL ให้คัดลอก password_hash ไม่ถูกอ่านโดยโค้ดใด
// hits ไม่เคยเพิ่ม และ vlan_scope ถูกเก็บไว้โดยไม่มีใครตรวจ):
//   A. ผู้รับที่ไม่ได้ล็อกอินเปิดลิงก์แล้ว "ได้ไบต์ของไฟล์จริง" ครบทุกไบต์
//   B. รหัสลิงก์ถูกตรวจด้วย bcrypt จริง — รหัสผิดไม่ได้ไฟล์ และมี rate limit
//   C. ตัวนับเพิ่มเมื่อไถ่สำเร็จ และ "ไม่เพิ่ม" เมื่อแค่เห็นฟอร์ม/กรอกรหัสผิด
//   D. ขอบเขตเครือข่ายถูกบังคับในโค้ดจริง (IP นอกช่วง → ไม่ได้ไฟล์)
//   E. เพิกถอน/หมดอายุ/ไฟล์ vault → ไถ่ไม่ได้ และทุกความล้มเหลวตอบหน้าเดียวกัน
//   F. token ดิบไม่เคยถูกเก็บลงตาราง (เก็บแต่ sha256) และไม่หลุดใน audit
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { Client, loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-share-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.TRUSTED_PROXY_CIDRS = '127.0.0.2/32'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initAvatarStorage } = await import('../server/storage/avatarStore.js')
const store = await import('../server/db/store.js')
const { usingPostgres, closePool, query, readAudit } = await import('../server/db/connection.js')
const { ipAllowed } = await import('../server/routes/share.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[share redemption tests] database mode: ${DB_MODE}`)

// ⚠️ ห้ามใช้คำที่ tests/vaultPostgres.test.js ถือเป็น "เครื่องหมายของความลับใน vault"
//    (CONFIDENTIAL / merger-terms / Meridian / .pdf ฯลฯ) — ชุดนั้นสแกนทุกคอลัมน์ข้อความ
//    ในทุกตารางเพื่อพิสูจน์ว่า vault ไม่รั่ว ถ้าไฟล์ธรรมดาของชุดนี้มีคำเหล่านั้นในชื่อ
//    (ซึ่งถูกเก็บเป็น plaintext ตามการออกแบบ เพราะชื่อไฟล์ใน Data Lake ไม่ใช่ความลับ)
//    ชุดนั้นจะล้มด้วยเหตุผลที่ไม่เกี่ยวกับ vault เลย
const FILE_BODY = 'Q3 pricing model. Unit cost 412.50 THB, margin 31.4 percent.'
const FILE_NAME = 'sharetest-q3-pricing.txt'

let driveServer, proxyServer, baseUrl, directBaseUrl

before(async () => {
  await initStorage()
  await initAvatarStorage()
  driveServer = createApp().listen(0, '127.0.0.1')
  await new Promise((r) => driveServer.once('listening', r))
  directBaseUrl = `http://127.0.0.1:${driveServer.address().port}`

  // A real TCP hop models the trusted edge. It connects from 127.0.0.2 (the
  // only CIDR trusted by the child app), strips /drive, discards inbound
  // forwarding chains, and overwrites attribution exactly like tracked nginx.
  proxyServer = createServer((clientReq, clientRes) => {
    const sourceIp = String(clientReq.headers['x-test-client-ip'] ?? '198.51.100.250')
    const headers = {
      ...clientReq.headers,
      'x-forwarded-for': sourceIp,
      'x-real-ip': sourceIp,
      'x-forwarded-proto': 'http',
      'x-forwarded-host': clientReq.headers.host,
    }
    delete headers.forwarded
    delete headers['x-test-client-ip']

    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: driveServer.address().port,
      localAddress: '127.0.0.2',
      method: clientReq.method,
      path: clientReq.url.replace(/^\/drive(?=\/|$)/, '') || '/',
      headers,
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers)
      upstreamRes.pipe(clientRes)
    })
    upstream.on('error', (error) => clientRes.destroy(error))
    clientReq.pipe(upstream)
  })
  proxyServer.listen(0, '127.0.0.1')
  await new Promise((r) => proxyServer.once('listening', r))
  baseUrl = `http://127.0.0.1:${proxyServer.address().port}/drive`
})

after(async () => {
  await new Promise((r) => proxyServer.close(r))
  await new Promise((r) => driveServer.close(r))
  if (usingPostgres) {
    // เก็บกวาดของตัวเองให้หมด — แถวไฟล์ที่ค้างไว้จะไปโผล่ในชุดทดสอบอื่นที่ใช้ฐานเดียวกัน
    // (shares ถูกลบก่อน files เพราะ file_id เป็น FK แบบ CASCADE — ลบตามลำดับนี้ชัดเจนกว่า
    //  พึ่ง cascade ให้ทำงานเงียบ ๆ)
    await query('DELETE FROM shares')
    await query(`DELETE FROM files WHERE name LIKE 'sharetest-%'`)
    await query(`DELETE FROM network_zones WHERE name LIKE 'share-test%'`)
    await closePool()
  }
  // bytes อยู่ใน STORAGE_ROOT ชั่วคราวของชุดนี้เอง — หายไปพร้อมโฟลเดอร์
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  await store.__resetSharesForTests()
})

/** อัปโหลดไฟล์จริง (bytes ลงดิสก์) แล้วคืนแถว */
async function uploadFile(client, { name = FILE_NAME, content = FILE_BODY } = {}) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'application/octet-stream' }), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `อัปโหลดล้มเหลว: ${JSON.stringify(res.data)}`)
  return res.data.file
}

/** สร้างลิงก์แชร์ → คืน { share, path, token } */
async function createShare(client, fileId, opts = {}) {
  const body = { fileId, expiry: '24h', authType: 'none', scope: 'any', ...opts }
  const res = await client.req('/api/shares', { method: 'POST', body })
  assert.equal(res.status, 201, `สร้างลิงก์ล้มเหลว: ${JSON.stringify(res.data)}`)
  return { share: res.data.share, path: res.data.path, token: res.data.path.split('/').pop() }
}

/**
 * ผู้รับ = ไม่มี cookie ไม่มี session ไม่มี CSRF token เลย (เหมือนคนเปิดลิงก์จากอีเมล)
 *
 * ⚠️ ทุก recipient ระบุ source จำลองให้ test reverse proxy ซึ่งจะลบ forwarding
 *    header ขาเข้าแล้วเขียน X-Forwarded-For ใหม่ เหมือน trusted nginx edge —
 *    ถ้าทุกเทสต์ยิงจาก 127.0.0.1 เหมือนกันหมด เทสต์ brute-force จะล็อก IP นั้นค้างไว้
 *    แล้วเทสต์ถัดไปล้มเพราะ 429 โดยที่โค้ดโปรดักชันไม่ได้ผิดอะไรเลย
 *    (การล็อกต่อ IP เป็นพฤติกรรมที่ถูกต้อง — เทสต์ต่างหากที่ต้องเป็นผู้รับต่างคนกัน)
 *    ใช้ช่วง TEST-NET (RFC 5737) เพื่อไม่ให้ไปพ้องกับ IP ของใครจริง
 */
function recipient(ip = '198.51.100.10') {
  const c = new Client(baseUrl)
  const withIp = (extra = {}) => ({ 'X-Test-Client-IP': ip, ...extra })
  return {
    raw: (pathname, opts = {}) => c.raw(pathname, { ...opts, headers: withIp(opts.headers) }),
    rawPost: (pathname, body) => c.raw(pathname, {
      method: 'POST', body,
      headers: withIp({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    }),
    req: (pathname, opts = {}) => c.req(pathname, { ...opts, headers: withIp(opts.headers) }),
  }
}

// ═══ A. ไถ่ลิงก์แล้วได้ไฟล์จริง ═══════════════════════════════════════════════

test('ผู้รับที่ไม่ได้ล็อกอินเปิดลิงก์แล้วได้ไบต์ของไฟล์จริงครบทุกไบต์', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const { path: sharePath, share } = await createShare(owner, file.id)

  assert.match(sharePath, /^\/s\/[A-Za-z0-9_-]{20,}$/, 'ต้องคืน path ที่มี token ยาวพอจะเดาไม่ได้')
  assert.equal(share.redeemable, true)

  const got = await recipient().raw(sharePath)
  assert.equal(got.status, 200, `ผู้รับต้องได้ไฟล์ — ได้ ${got.status}`)
  assert.equal(got.buffer.toString('utf8'), FILE_BODY, 'ไบต์ที่ได้ต้องเหมือนไฟล์ต้นฉบับเป๊ะ')

  // header ต้องบังคับให้ดาวน์โหลด ไม่ใช่ให้เบราว์เซอร์ render (ไฟล์ HTML/SVG = XSS)
  assert.equal(got.headers.get('content-type'), 'application/octet-stream')
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  assert.match(got.headers.get('content-disposition'), /^attachment;/)
  assert.ok(got.headers.get('content-disposition').includes(encodeURIComponent(FILE_NAME)))
})

test('token ที่เดาสุ่ม / รูปแบบผิด → หน้าเดียวกันหมด ไม่บอกว่ามีอยู่จริงไหม', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const { token } = await createShare(owner, file.id)

  const cases = ['x', 'a'.repeat(43), `${token}x`, token.slice(0, -1), '../../etc/passwd']
  for (const bad of cases) {
    const res = await recipient().raw(`/s/${encodeURIComponent(bad)}`)
    assert.equal(res.status, 404, `token '${bad.slice(0, 12)}…' ต้องได้ 404 — ได้ ${res.status}`)
    const html = res.buffer.toString('utf8')
    assert.ok(!html.includes(FILE_NAME), 'หน้า error ต้องไม่หลุดชื่อไฟล์')
    assert.ok(!html.includes(FILE_BODY), 'หน้า error ต้องไม่หลุดเนื้อไฟล์')
  }

  // token ที่ถูกต้องยังใช้ได้ปกติ (การยิงผิดไม่ได้ทำลายลิงก์)
  assert.equal((await recipient().raw(`/s/${token}`)).status, 200)
})

// ═══ B. รหัสลิงก์ ══════════════════════════════════════════════════════════════

test('รหัสลิงก์: ต้องกรอกถูกจึงได้ไฟล์ — GET เปล่าได้แค่ฟอร์ม ไม่ได้ไบต์', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const { token, share } = await createShare(owner, file.id, {
    authType: 'password', password: 'link-pass-2026',
  })
  assert.equal(share.hasPassword, true, 'API ต้องบอกว่าลิงก์นี้ต้องใช้รหัส')

  // GET → ฟอร์ม (ไม่ใช่ไฟล์)
  const form = await recipient().raw(`/s/${token}`)
  assert.equal(form.status, 200)
  const html = form.buffer.toString('utf8')
  assert.ok(html.includes('<form'), 'ต้องได้ฟอร์มกรอกรหัส')
  assert.ok(!html.includes(FILE_BODY), '⚠️ เนื้อไฟล์ต้องไม่หลุดมากับหน้าฟอร์มเด็ดขาด')
  const formTag = html.match(/<form\b[^>]*>/i)?.[0] ?? ''
  assert.match(formTag, /method="post"/i, 'ฟอร์มต้อง POST กลับ URL ปัจจุบัน')
  assert.doesNotMatch(formTag, /\saction=/i, 'ห้ามสร้าง relative action ที่ทำให้ /s/s/ ซ้ำ')
  const action = /\saction="([^"]*)"/i.exec(formTag)?.[1] ?? ''
  const browserPost = new URL(action, `${baseUrl}/s/${token}`)
  assert.equal(browserPost.pathname, `/drive/s/${token}`, 'browser ต้อง POST กลับ public URL เดิม')
  assert.doesNotMatch(browserPost.pathname, /\/s\/s\//, 'production base path ต้องไม่มี /s/s/')

  // รหัสผิด → ไม่ได้ไฟล์
  const wrong = await recipient().req(`/s/${token}`, {
    method: 'POST',
    body: 'password=not-the-password',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(wrong.status, 401, `รหัสผิดต้องได้ 401 — ได้ ${wrong.status}`)

  // รหัสถูก → ได้ไฟล์
  const c = recipient()
  const ok = await c.rawPost(`/s/${token}`, 'password=link-pass-2026')
  assert.equal(ok.status, 200, `รหัสถูกต้องได้ไฟล์ — ได้ ${ok.status}`)
  assert.equal(ok.buffer.toString('utf8'), FILE_BODY)
})

test('รหัสลิงก์: bcrypt hash ถูกเก็บจริง ไม่ใช่รหัสดิบ และไม่หลุดออกทาง API', async (t) => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const PW = 'link-pass-2026-secret'
  await createShare(owner, file.id, { authType: 'password', password: PW })

  // API ต้องไม่คืน hash หรือรหัสออกไปที่ไหนเลย
  const list = JSON.stringify((await owner.req('/api/shares')).data)
  assert.ok(!list.includes(PW), 'รหัสลิงก์ต้องไม่หลุดใน GET /api/shares')
  assert.ok(!list.includes('password_hash') && !list.includes('passwordHash'), 'ต้องไม่คืนฟิลด์ hash')
  assert.ok(!list.includes('token_hash') && !list.includes('tokenHash'), 'ต้องไม่คืน hash ของ token')

  if (!usingPostgres) {
    t.skip('ตรวจเนื้อคอลัมน์ในตารางต้องมี Postgres')
    return
  }
  const { rows } = await query('SELECT password_hash, token_hash FROM shares ORDER BY id DESC LIMIT 1')
  assert.match(rows[0].password_hash, /^\$2[aby]\$\d{2}\$/, 'คอลัมน์ต้องเก็บ bcrypt hash')
  assert.ok(!rows[0].password_hash.includes(PW), 'ห้ามมีรหัสดิบอยู่ในคอลัมน์')
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/, 'token ต้องถูกเก็บเป็น sha256 hex')
})

test('รหัสลิงก์: เดารหัสรัว ๆ ถูก rate limit (ไม่ปล่อยให้ไล่เดาไม่จำกัด)', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const { token } = await createShare(owner, file.id, {
    authType: 'password', password: 'brute-force-target-pw',
  })

  // ⚠️ ถ้าไม่มีด่านนี้ ลิงก์ที่ตั้งรหัสสั้นจะถูกไล่เดาได้ไม่จำกัดครั้งจากเครื่องเดียว
  //    โดยที่เจ้าของไฟล์ไม่มีทางรู้ — เพดานเดียวกับหน้า login (5 ครั้ง)
  const attacker = '198.51.100.66' // IP ของผู้ไล่เดาโดยเฉพาะ — การล็อกต้องไปโดนแค่ IP นี้
  let sawLockout = false
  for (let i = 0; i < 7; i++) {
    const res = await recipient(attacker).rawPost(`/s/${token}`, `password=guess-${i}`)
    if (res.status === 429) { sawLockout = true; break }
    assert.equal(res.status, 401, `ครั้งที่ ${i + 1} ควรเป็น 401 หรือ 429 — ได้ ${res.status}`)
  }
  assert.equal(sawLockout, true, 'ต้องถูกล็อกหลังเดาผิดหลายครั้ง')

  // ⚠️ และรหัสที่ถูกต้องก็ต้องถูกล็อกด้วยระหว่างนั้น — ไม่งั้น lockout ไม่มีความหมาย
  const evenCorrect = await recipient(attacker).rawPost(`/s/${token}`, 'password=brute-force-target-pw')
  assert.equal(evenCorrect.status, 429, 'ระหว่างถูกล็อก แม้รหัสถูกก็ต้องไม่ได้ไฟล์')
})

// ═══ C. ตัวนับ ═════════════════════════════════════════════════════════════════

test('ตัวนับเพิ่มเมื่อไถ่สำเร็จ และไม่เพิ่มเมื่อเห็นฟอร์ม/กรอกรหัสผิด', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  // ลิงก์ไม่มีรหัส — ไถ่สามครั้ง
  const open = await createShare(owner, file.id)
  const hitsOf = async (id) => (await owner.req('/api/shares')).data.shares.find((s) => s.id === id)?.hits
  assert.equal(await hitsOf(open.share.id), 0, 'ลิงก์ใหม่ต้องเริ่มที่ 0')

  for (let i = 1; i <= 3; i++) {
    assert.equal((await recipient().raw(open.path)).status, 200)
    assert.equal(await hitsOf(open.share.id), i, `ไถ่ครั้งที่ ${i} ตัวนับต้องเป็น ${i}`)
  }

  // ลิงก์ที่มีรหัส — การเห็นฟอร์มและการกรอกผิด ต้องไม่นับเป็นการเข้าถึงไฟล์
  const locked = await createShare(owner, file.id, { authType: 'password', password: 'counter-probe-pw' })
  await recipient().raw(locked.path)                                  // เห็นฟอร์ม
  await recipient().rawPost(locked.path, 'password=wrong')             // กรอกผิด
  assert.equal(await hitsOf(locked.share.id), 0, 'ยังไม่ได้ไฟล์ = ยังไม่นับ')

  assert.equal((await recipient().rawPost(locked.path, 'password=counter-probe-pw')).status, 200)
  assert.equal(await hitsOf(locked.share.id), 1, 'ไถ่สำเร็จแล้วจึงนับ')
})

// ═══ D. ขอบเขตเครือข่าย ════════════════════════════════════════════════════════

test('ipAllowed: เทียบ CIDR ถูกต้อง (รวม IPv4-mapped IPv6 และรายการว่าง)', () => {
  assert.equal(ipAllowed('192.168.10.5', []), true, 'รายการว่าง = ไม่จำกัด')
  assert.equal(ipAllowed('192.168.10.5', ['192.168.10.0/24']), true)
  assert.equal(ipAllowed('192.168.11.5', ['192.168.10.0/24']), false)
  assert.equal(ipAllowed('::ffff:192.168.10.5', ['192.168.10.0/24']), true, 'IPv4-mapped ต้องถูก normalize')
  assert.equal(ipAllowed('10.10.0.9', ['192.168.10.0/24', '10.10.0.0/28']), true, 'เข้าช่วงใดช่วงหนึ่งก็ผ่าน')
  assert.equal(ipAllowed('10.10.0.99', ['10.10.0.0/28']), false, 'นอก /28 ต้องไม่ผ่าน')
  assert.equal(ipAllowed('8.8.8.8', ['0.0.0.0/0']), true, '/0 = ทุก IPv4')
  assert.equal(ipAllowed('2001:db8::1', ['192.168.10.0/24']), false, 'IPv6 แท้เทียบกับ CIDR v4 ไม่ผ่าน (fail-closed)')
  assert.equal(ipAllowed('192.168.10.5', ['not-a-cidr']), false, 'CIDR พังต้องไม่ผ่าน ไม่ใช่ผ่านหมด')
})

test('ขอบเขตเครือข่าย: IP นอกช่วงไถ่ลิงก์ไม่ได้จริง (บังคับในโค้ด ไม่ใช่ป้ายบอก)', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await uploadFile(admin)

  // zone ที่ "ไม่ครอบ" 127.0.0.1 ซึ่งเป็น IP ที่เทสต์นี้ยิงมาจาก
  const cidr = '203.0.113.0/24' // TEST-NET-3 (RFC 5737) — ไม่ใช่ IP ของใครจริง
  const zone = await admin.req('/api/zones', { method: 'POST', body: { name: 'share-test zone', cidr } })
  assert.equal(zone.status, 201, `ต้องเพิ่ม zone ได้ — ${JSON.stringify(zone.data)}`)

  try {
    const { path: sharePath, share } = await createShare(admin, file.id, { scope: 'zones' })
    assert.deepEqual(share.scopeCidrs, [cidr], 'ลิงก์ต้อง snapshot CIDR ของ zone ไว้')

    // ⚠️ หัวใจของเฟสนี้: คำขอจาก 127.0.0.1 อยู่นอก 203.0.113.0/24 → ต้องไม่ได้ไฟล์
    const blocked = await recipient().raw(sharePath)
    assert.equal(blocked.status, 403, `IP นอกขอบเขตต้องได้ 403 — ได้ ${blocked.status}`)
    const html = blocked.buffer.toString('utf8')
    assert.ok(!html.includes(FILE_BODY), 'เนื้อไฟล์ต้องไม่หลุดมาในหน้า 403')

    // ⚠️ และต้องไม่ถูกนับเป็นการเข้าถึงสำเร็จ
    const hits = (await admin.req('/api/shares')).data.shares.find((s) => s.id === share.id)?.hits
    assert.equal(hits, 0, 'คำขอที่ถูกปฏิเสธต้องไม่เพิ่มตัวนับ')

    // Trusted edge ที่เห็น source อยู่ในช่วง → ผ่าน (พิสูจน์ว่าเทียบ canonical req.ip)
    const allowed = await recipient('203.0.113.42').raw(sharePath)
    assert.equal(allowed.status, 200, `IP ในขอบเขตต้องได้ไฟล์ — ได้ ${allowed.status}`)
    assert.equal(allowed.buffer.toString('utf8'), FILE_BODY)

    // B2-T5: audit ต้องบันทึก address เดียวกับที่ใช้ตัดสิน CIDR
    const event = (await readAudit(50)).find((e) => e.action === 'SHARE_REDEEM' && e.result === 'OK')
    assert.equal(event?.sourceIp, '203.0.113.42')
  } finally {
    const zones = (await admin.req('/api/zones')).data.zones
    const row = zones.find((z) => z.cidr === cidr)
    if (row) await admin.req(`/api/zones/${row.id}`, { method: 'DELETE' })
  }
})

test('B2-T8 direct caller cannot forge XFF to bypass a restricted share', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await uploadFile(admin, { name: 'sharetest-forged-xff.txt' })
  const cidr = '203.0.113.0/24'
  const zone = await admin.req('/api/zones', { method: 'POST', body: { name: 'share-test forged-xff', cidr } })
  assert.equal(zone.status, 201)

  try {
    const { path: sharePath, share } = await createShare(admin, file.id, { scope: 'zones' })
    const attacker = new Client(directBaseUrl)
    const denied = await attacker.raw(sharePath, {
      headers: { 'X-Forwarded-For': '203.0.113.42' },
    })
    assert.equal(denied.status, 403)
    assert.ok(!denied.buffer.toString('utf8').includes(FILE_BODY))
    const hits = (await admin.req('/api/shares')).data.shares.find((s) => s.id === share.id)?.hits
    assert.equal(hits, 0)
  } finally {
    const zones = (await admin.req('/api/zones')).data.zones
    const row = zones.find((z) => z.cidr === cidr)
    if (row) await admin.req(`/api/zones/${row.id}`, { method: 'DELETE' })
  }
})

test('B2-T11 share IP limiter cannot be bypassed with changing forged XFF', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner, { name: 'sharetest-rate-source.txt' })
  const direct = new Client(directBaseUrl)
  const shares = []
  for (let i = 0; i < 6; i++) {
    shares.push(await createShare(owner, file.id, {
      authType: 'password', password: `rate-source-password-${i}`,
    }))
  }

  for (let i = 0; i < 5; i++) {
    const wrong = await direct.raw(shares[i].path, {
      method: 'POST',
      body: `password=wrong-${i}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-For': `198.51.100.${i + 1}`,
      },
    })
    assert.equal(wrong.status, 401)
  }
  const locked = await direct.raw(shares[5].path, {
    method: 'POST',
    body: 'password=still-wrong',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': '198.51.100.200',
    },
  })
  assert.equal(locked.status, 429)
})

test('B2-T11 login IP limiter cannot be bypassed with changing forged XFF', async () => {
  const direct = new Client(directBaseUrl)
  for (let i = 0; i < 5; i++) {
    const wrong = await direct.req('/api/login', {
      method: 'POST',
      body: { username: `missing-b2-user-${i}`, password: 'wrong-password' },
      headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` },
    })
    assert.equal(wrong.status, 401)
  }
  const locked = await direct.req('/api/login', {
    method: 'POST',
    body: { username: 'missing-b2-user-last', password: 'wrong-password' },
    headers: { 'X-Forwarded-For': '192.0.2.200' },
  })
  assert.equal(locked.status, 429)
})

test('scope zones แต่ยังไม่มี zone ใดถูกกำหนด → ปฏิเสธการสร้าง (ไม่สร้างลิงก์ที่อ้างว่าจำกัด)', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await uploadFile(admin)

  // เคลียร์ zone ให้ว่างก่อน
  for (const z of (await admin.req('/api/zones')).data.zones) {
    await admin.req(`/api/zones/${z.id}`, { method: 'DELETE' })
  }

  // ⚠️ ถ้ายอมสร้าง ลิงก์จะมี vlan_scope ว่าง = ไม่จำกัดจริง ๆ แต่ป้ายบอกว่าจำกัด
  const res = await admin.req('/api/shares', {
    method: 'POST',
    body: { fileId: file.id, expiry: '24h', authType: 'none', scope: 'zones' },
  })
  assert.equal(res.status, 400, `ต้องปฏิเสธ — ได้ ${res.status}`)
})

// ═══ E. เพิกถอน / หมดอายุ / vault ══════════════════════════════════════════════

test('เพิกถอนแล้วไถ่ไม่ได้ทันที และตัวนับไม่ขยับ', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const { path: sharePath, share } = await createShare(owner, file.id)

  assert.equal((await recipient().raw(sharePath)).status, 200)
  assert.equal((await owner.req(`/api/shares/${share.id}`, { method: 'DELETE' })).status, 200)

  const after = await recipient().raw(sharePath)
  assert.equal(after.status, 404, `ลิงก์ที่ถูกเพิกถอนต้องไถ่ไม่ได้ — ได้ ${after.status}`)
  assert.ok(!after.buffer.toString('utf8').includes(FILE_BODY))
})

test('ลิงก์หมดอายุแล้วไถ่ไม่ได้ (เทียบเวลาฝั่งเซิร์ฟเวอร์ ไม่เชื่อ client)', { skip: usingPostgres ? false : 'อายุลิงก์ต่ำสุดคือ 1 ชม. — ต้องดันเวลาในตารางเพื่อทดสอบโดยไม่ต้องรอจริง' }, async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const { path: sharePath, share } = await createShare(owner, file.id, { expiry: '1h' })
  assert.equal((await recipient().raw(sharePath)).status, 200, 'ก่อนหมดอายุต้องไถ่ได้')

  // ดันเวลาหมดอายุให้เป็นอดีต (จำลองการรอ 1 ชั่วโมงโดยไม่ต้องรอจริง)
  await query(`UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [share.id])

  const after = await recipient().raw(sharePath)
  assert.equal(after.status, 404, `ลิงก์หมดอายุต้องไถ่ไม่ได้ — ได้ ${after.status}`)
  assert.ok(!after.buffer.toString('utf8').includes(FILE_BODY), 'เนื้อไฟล์ต้องไม่หลุด')

  // ⚠️ และต้องไม่นับเป็นการเข้าถึงสำเร็จ
  const { rows } = await query('SELECT hits FROM shares WHERE id = $1', [share.id])
  assert.equal(rows[0].hits, 1, 'มีแค่การไถ่ครั้งแรกที่ถูกนับ')
})

test('ไฟล์ใน Vault แชร์ไม่ได้ (เซิร์ฟเวอร์ถือแต่ ciphertext ที่ถอดไม่ได้)', async (t) => {
  if (!usingPostgres) {
    t.skip('ต้องมี Postgres เพื่อสร้างแถวไฟล์ที่ vault = true')
    return
  }
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)

  // ทำให้เป็นไฟล์ vault แล้วลองแชร์ — ต้องถูกปฏิเสธตั้งแต่ตอนสร้าง
  await query('UPDATE files SET vault = true WHERE id = $1', [file.id])
  const res = await owner.req('/api/shares', {
    method: 'POST', body: { fileId: file.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  assert.equal(res.status, 400, 'สร้างลิงก์ของไฟล์ vault ต้องไม่สำเร็จ')
  await query('UPDATE files SET vault = false WHERE id = $1', [file.id])
})

// ═══ F. audit + ความลับไม่รั่ว ══════════════════════════════════════════════════

test('audit บันทึกการไถ่ลิงก์ (สำเร็จ/ถูกปฏิเสธ) โดยไม่มี token ดิบปนอยู่', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await uploadFile(owner)
  const { path: sharePath, token } = await createShare(owner, file.id, {
    authType: 'password', password: 'audit-probe-pw-2026',
  })

  await recipient().rawPost(sharePath, 'password=wrong-one')            // DENIED
  await recipient().rawPost(sharePath, 'password=audit-probe-pw-2026')  // OK

  const events = await readAudit(200)
  const redeem = events.filter((e) => (e.action ?? '') === 'SHARE_REDEEM')
  assert.ok(redeem.some((e) => e.result === 'OK'), 'ต้องมีเหตุการณ์ไถ่สำเร็จใน audit')
  assert.ok(redeem.some((e) => e.result === 'DENIED'), 'ต้องมีเหตุการณ์รหัสผิดใน audit')

  // ⚠️ token ดิบและรหัสลิงก์ต้องไม่โผล่ใน audit เลย — audit ถูกอ่านโดย Admin คนไหนก็ได้
  //    ถ้า token หลุดลง log ใครที่อ่าน audit ได้ก็ดาวน์โหลดไฟล์ของคนอื่นได้ทันที
  const dump = JSON.stringify(events)
  assert.ok(!dump.includes(token), 'token ดิบต้องไม่อยู่ใน audit')
  assert.ok(!dump.includes('audit-probe-pw-2026'), 'รหัสลิงก์ต้องไม่อยู่ใน audit')
  assert.ok(!dump.includes(FILE_NAME), 'ชื่อไฟล์ต้องถูกเก็บเป็น hash ไม่ใช่ค่าดิบ')
})

test('ผู้ใช้ที่ล็อกอินแล้วเพิกถอนลิงก์ของคนอื่นไม่ได้ และลิงก์ยังไถ่ได้', async () => {
  // Share lifecycle เป็น owner-only เหมือนการสร้าง share: Admin ไม่มี cross-owner
  // override และ 404 ไม่บอกว่า id นี้เป็นของใครหรือมีอยู่จริงหรือไม่
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const other = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await uploadFile(owner)
  const { share, path: sharePath } = await createShare(owner, file.id)

  assert.equal((await other.req(`/api/shares/${share.id}`, { method: 'DELETE' })).status, 404)
  assert.equal((await recipient().raw(sharePath)).status, 200)
})
