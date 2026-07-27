// tests/profileIdentity.test.js — AEGIS Drive (IDEA1) · ชื่อโปรไฟล์ + รูปโปรไฟล์ + เซสชันจริง
//
// ยิงผ่าน Express app ตัวเดียวกับ production (server/app.js) — ไม่มีการ mock
//
// สิ่งที่ชุดนี้พิสูจน์:
//   A. ชื่อโปรไฟล์แยกจาก username จริง: เปลี่ยนชื่อได้ ชื่อใหม่ไปปรากฏทั่วแอป
//      (รวมป้ายผู้อัปโหลดไฟล์) แต่ username ไม่ขยับ และล็อกอินด้วยชื่อใหม่ไม่ได้
//   B. รูปโปรไฟล์: ตรวจชนิดจาก "ไบต์จริง" ไม่ใช่ชื่อ/MIME ที่ client แจ้ง, มีเพดานขนาด,
//      ชื่อไฟล์บนดิสก์เป็นค่าสุ่ม (ไม่มีเศษชื่อจากผู้ใช้), และ **EXIF ถูกถอดออกจริง**
//      โดยตรวจไบต์บนดิสก์ ไม่ใช่เชื่อว่าโค้ดถอดให้แล้ว
//   C. เซสชันที่จอ Settings แสดงมาจาก session store จริง และเพิกถอนได้จริง
//      (เซสชันที่ถูกเพิกถอนต้องใช้ต่อไม่ได้ทันที) และเพิกถอนของคนอื่นไม่ได้
//
// ⚠️ ชุดเดียวกันต้องผ่านทั้งสองโหมด DB — ไม่ตั้ง TEST_DATABASE_URL = in-memory
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, loginClient, DEMO_ADMIN, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-profile-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initAvatarStorage, sanitizeAvatar, sniffImageType } = await import('../server/storage/avatarStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[profile identity tests] database mode: ${DB_MODE}`)

let server, baseUrl

before(async () => {
  await initStorage()
  await initAvatarStorage()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
  // คืนชื่อโปรไฟล์ให้ว่างเพื่อไม่ให้ค้างไปรบกวนไฟล์เทสต์อื่นที่ใช้ฐานเดียวกัน
  if (usingPostgres) {
    await query(`UPDATE users SET profile_name = NULL, avatar_key = NULL, avatar_mime = NULL`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

// ── ตัวช่วยสร้างรูปจริงระดับไบต์ (ไม่ใช้ไลบรารีภาพ — ประกอบ chunk/segment เอง) ──────

/** CRC32 ตามสเปก PNG — ต้องถูกต้อง ไม่งั้นไม่ใช่ PNG ที่ใช้งานได้จริง */
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

const GPS_MARKER = 'GPSLatitude=13.7563N GPSLongitude=100.5018E'
const CAMERA_MARKER = 'Canon EOS R5 serial 042-SECRET'

/** PNG 1x1 จริง + chunk metadata ที่ต้องถูกถอดออก (eXIf / tEXt / iTXt) */
function makePngWithMetadata() {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr[8] = 8              // bit depth
  ihdr[9] = 0              // color type: grayscale
  // IDAT: zlib ของ scanline เดียว (filter 0 + 1 ไบต์สี) — ค่าคงที่ที่ถูกต้องตามสเปก
  const idat = Buffer.from([0x78, 0x9c, 0x62, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('eXIf', Buffer.from(GPS_MARKER, 'latin1')),
    pngChunk('tEXt', Buffer.from(`Comment\0${CAMERA_MARKER}`, 'latin1')),
    pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${GPS_MARKER}`, 'latin1')),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** JPEG เล็กที่สุดที่ parse ได้ + APP1 (EXIF) / APP13 (IPTC) / COM ที่ต้องถูกถอดออก */
function makeJpegWithMetadata() {
  const seg = (marker, payload) => {
    const len = Buffer.alloc(2)
    len.writeUInt16BE(payload.length + 2)
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload])
  }
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(GPS_MARKER, 'latin1')])
  const sof0 = Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x11, 0x00]) // 1x1, 1 component
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),                        // SOI
    seg(0xe1, exif),                                  // APP1 · EXIF (พิกัด GPS)
    seg(0xed, Buffer.from(CAMERA_MARKER, 'latin1')),  // APP13 · IPTC
    seg(0xfe, Buffer.from(CAMERA_MARKER, 'latin1')),  // COM
    seg(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x10)])), // DQT
    seg(0xc0, sof0),                                  // SOF0
    seg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16), Buffer.alloc(2)])), // DHT
    seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),            // SOS
    Buffer.from([0x12, 0x34, 0x56]),                  // entropy data (ไม่ต้องถอดจริง)
    Buffer.from([0xff, 0xd9]),                        // EOI
  ])
}

async function uploadAvatar(client, bytes, filename, mime) {
  const form = new FormData()
  form.append('avatar', new Blob([bytes], { type: mime }), filename)
  return client.req('/api/profile/avatar', { method: 'POST', body: form })
}

/** ไฟล์ทุกไฟล์ที่อยู่ใต้ avatars/ ตอนนี้ */
async function avatarFiles() {
  const dir = path.join(STORAGE_ROOT, 'avatars')
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

// ═══ A. ชื่อโปรไฟล์แยกจาก username ═════════════════════════════════════════════

test('ชื่อโปรไฟล์: ผู้ใช้แก้เองได้ ไปปรากฏทั่วแอป แต่ username ไม่ขยับและใช้ล็อกอินไม่ได้', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const before = await c.req('/api/me')
  const originalAccountName = before.data.user.accountName

  const NEW_NAME = 'ก้อง (Data Team)'
  const patched = await c.req('/api/profile', { method: 'PATCH', body: { displayName: NEW_NAME } })
  assert.equal(patched.status, 200, `ต้องแก้ชื่อได้ — ได้ ${patched.status}: ${JSON.stringify(patched.data)}`)
  assert.equal(patched.data.user.displayName, NEW_NAME)

  // username ต้องไม่เปลี่ยน และ accountName (ชื่อที่ Admin ตั้ง) ต้องยังอยู่ให้เทียบได้
  assert.equal(patched.data.user.username, DEMO_USER.username, 'username ห้ามเปลี่ยนตามชื่อโปรไฟล์')
  assert.equal(patched.data.user.accountName, originalAccountName, 'ชื่อที่ Admin ตั้งต้องไม่ถูกเขียนทับ')

  // เซสชันเดิมต้องเห็นชื่อใหม่ทันที ไม่ต้อง re-login
  const me = await c.req('/api/me')
  assert.equal(me.data.user.displayName, NEW_NAME, 'session ต้องถือชื่อใหม่ทันที')

  // ป้ายผู้อัปโหลดของไฟล์ต้องใช้ชื่อใหม่ (ชื่อมาจาก JOIN ตอนอ่าน ไม่ได้ถูกก็อปไว้ในแถว)
  const form = new FormData()
  form.append('file', new Blob(['profile-name probe'], { type: 'application/octet-stream' }), 'probe.txt')
  const up = await c.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(up.status, 201)
  assert.equal(up.data.file.uploader, NEW_NAME, 'ป้ายผู้อัปโหลดต้องเป็นชื่อที่ผู้ใช้ตั้งเอง')
  await c.req(`/api/files/${encodeURIComponent(up.data.file.id)}`, { method: 'DELETE' })

  // ⚠️ หัวใจ: ชื่อโปรไฟล์ไม่ใช่ตัวระบุตัวตน — ล็อกอินด้วยมันไม่ได้เด็ดขาด
  const spoof = new Client(baseUrl)
  const tryLogin = await spoof.req('/api/login', { method: 'POST', body: { username: NEW_NAME, password: DEMO_USER.password } })
  assert.equal(tryLogin.status, 401, 'ชื่อโปรไฟล์ต้องใช้ล็อกอินไม่ได้')

  // ล้างค่ากลับ (ส่งค่าว่าง = กลับไปใช้ชื่อที่ Admin ตั้ง)
  const cleared = await c.req('/api/profile', { method: 'PATCH', body: { displayName: '   ' } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.data.user.displayName, originalAccountName, 'เว้นว่างต้องกลับไปใช้ชื่อที่ Admin ตั้ง')
})

test('ชื่อโปรไฟล์: ปฏิเสธค่าที่ยาวเกินและอักขระควบคุม (ไม่ตัดให้เงียบ ๆ)', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)

  const tooLong = await c.req('/api/profile', { method: 'PATCH', body: { displayName: 'x'.repeat(81) } })
  assert.equal(tooLong.status, 400, 'ชื่อยาวเกิน 80 ต้องถูกปฏิเสธ')

  // \n ในชื่อทำให้ log บรรทัดเดียวกลายเป็นสองบรรทัดที่อ่านเหมือนสองเหตุการณ์
  const controlChar = await c.req('/api/profile', { method: 'PATCH', body: { displayName: 'Kanya\nAdmin' } })
  assert.equal(controlChar.status, 400, 'อักขระควบคุมต้องถูกปฏิเสธ')

  const me = await c.req('/api/me')
  assert.ok(!me.data.user.displayName.includes('\n'), 'ชื่อที่ถูกปฏิเสธต้องไม่ถูกบันทึก')
})

// ═══ B. รูปโปรไฟล์ ══════════════════════════════════════════════════════════════

test('รูปโปรไฟล์ PNG: EXIF/GPS/คอมเมนต์ถูกถอดออกจาก "ไบต์บนดิสก์" จริง', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const original = makePngWithMetadata()

  // ยืนยันก่อนว่าไฟล์ต้นฉบับ "มี" ความลับอยู่จริง — ไม่งั้นการ grep ไม่พบทีหลังไม่ได้พิสูจน์อะไร
  assert.ok(original.includes(GPS_MARKER), 'ไฟล์ต้นฉบับต้องมีพิกัด GPS อยู่จริง')
  assert.ok(original.includes(CAMERA_MARKER), 'ไฟล์ต้นฉบับต้องมีข้อมูลกล้องอยู่จริง')

  const res = await uploadAvatar(c, original, 'holiday-photo.png', 'image/png')
  assert.equal(res.status, 201, `อัปโหลดต้องสำเร็จ — ได้ ${res.status}: ${JSON.stringify(res.data)}`)
  assert.equal(res.data.mime, 'image/png')

  const files = await avatarFiles()
  assert.equal(files.length, 1, `ต้องมีไฟล์รูปหนึ่งไฟล์บนดิสก์ — พบ ${files.length}`)

  // ⚠️ ชื่อไฟล์บนดิสก์ต้องไม่มีเศษของชื่อที่ผู้ใช้ตั้งเลย (ตัด path traversal ที่ต้นทาง)
  assert.ok(!files[0].includes('holiday'), `ชื่อไฟล์บนดิสก์ต้องเป็นค่าสุ่ม — ได้ ${files[0]}`)
  assert.match(files[0], /^[0-9a-f-]{36}\.png$/, 'ชื่อไฟล์ต้องเป็น UUID + นามสกุลที่เซิร์ฟเวอร์กำหนด')

  const onDisk = await fs.readFile(path.join(STORAGE_ROOT, 'avatars', files[0]))
  assert.ok(!onDisk.includes(GPS_MARKER), 'พิกัด GPS ต้องไม่เหลืออยู่ในไบต์บนดิสก์')
  assert.ok(!onDisk.includes(CAMERA_MARKER), 'ข้อมูลกล้องต้องไม่เหลืออยู่ในไบต์บนดิสก์')
  assert.ok(!onDisk.includes(Buffer.from('eXIf')), 'chunk eXIf ต้องถูกถอดออก')
  assert.ok(!onDisk.includes(Buffer.from('tEXt')), 'chunk tEXt ต้องถูกถอดออก')
  assert.ok(!onDisk.includes(Buffer.from('iTXt')), 'chunk iTXt ต้องถูกถอดออก')
  // แต่ยังต้องเป็น PNG ที่ถอดภาพได้ (ไม่ใช่ไฟล์ที่ถูกทำลาย)
  assert.equal(sniffImageType(onDisk)?.mime, 'image/png', 'ไฟล์ที่เหลือต้องยังเป็น PNG ที่ถูกต้อง')
  assert.ok(onDisk.includes(Buffer.from('IHDR')) && onDisk.includes(Buffer.from('IDAT')))

  // เสิร์ฟกลับได้ ด้วย Content-Type ที่เซิร์ฟเวอร์ sniff เอง + nosniff
  const me = await c.req('/api/me')
  const got = await c.raw(`/api/users/${me.data.user.id}/avatar`)
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-type'), 'image/png')
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(Buffer.compare(got.buffer, onDisk), 0, 'ไบต์ที่เสิร์ฟต้องเท่ากับไบต์บนดิสก์เป๊ะ')
})

test('รูปโปรไฟล์ JPEG: APP1/APP13/COM ถูกถอดออก และรูปเดิมถูกลบเมื่อมีรูปใหม่', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  await uploadAvatar(c, makePngWithMetadata(), 'first.png', 'image/png')
  const afterFirst = await avatarFiles()
  assert.equal(afterFirst.length, 1)

  const jpeg = makeJpegWithMetadata()
  assert.ok(jpeg.includes(GPS_MARKER), 'JPEG ต้นฉบับต้องมีพิกัด GPS อยู่จริง')

  const res = await uploadAvatar(c, jpeg, 'photo.jpg', 'image/jpeg')
  assert.equal(res.status, 201, `อัปโหลด JPEG ต้องสำเร็จ — ได้ ${JSON.stringify(res.data)}`)
  assert.equal(res.data.mime, 'image/jpeg')

  const files = await avatarFiles()
  // ⚠️ รูปเดิมต้องหายไปจากดิสก์ ไม่ใช่แค่ถูกเลิกอ้างอิงในฐานข้อมูล — ไม่งั้นรูปที่ผู้ใช้
  //    "เปลี่ยนแล้ว" ยังนอนอยู่บนดิสก์ต่อไปโดยไม่มีใครเห็นและไม่มีทางลบ
  assert.equal(files.length, 1, `รูปเดิมต้องถูกลบทิ้ง — เหลือ ${files.length} ไฟล์: ${files.join(', ')}`)
  assert.match(files[0], /\.jpg$/)

  const onDisk = await fs.readFile(path.join(STORAGE_ROOT, 'avatars', files[0]))
  assert.ok(!onDisk.includes(GPS_MARKER), 'พิกัด GPS ต้องไม่เหลืออยู่')
  assert.ok(!onDisk.includes(CAMERA_MARKER), 'IPTC/COM ต้องไม่เหลืออยู่')
  assert.ok(!onDisk.includes(Buffer.from('Exif\0\0', 'latin1')), 'หัว APP1 Exif ต้องถูกถอดออก')
  assert.equal(sniffImageType(onDisk)?.mime, 'image/jpeg', 'ไฟล์ที่เหลือต้องยังเป็น JPEG ที่ถูกต้อง')

  // ลบรูป → หายจากดิสก์ และ endpoint ตอบ 404
  const del = await c.req('/api/profile/avatar', { method: 'DELETE' })
  assert.equal(del.status, 204)
  assert.equal((await avatarFiles()).length, 0, 'ลบรูปแล้วต้องไม่เหลือไฟล์บนดิสก์')
  const me = await c.req('/api/me')
  assert.equal((await c.req(`/api/users/${me.data.user.id}/avatar`)).status, 404)
})

test('รูปโปรไฟล์: ชนิดไฟล์ตัดสินจากไบต์จริง — นามสกุล/MIME ที่ client แจ้งไม่มีผล', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)

  // ⚠️ เคสสำคัญที่สุด: SVG ที่มี <script> ปลอมตัวเป็น .png พร้อม Content-Type: image/png
  //    ถ้าเซิร์ฟเวอร์เชื่อค่าที่ client แจ้ง ไฟล์นี้จะถูกเสิร์ฟกลับให้เบราว์เซอร์ render
  //    ใน origin เดียวกับแอป = XSS ที่อ่าน CSRF token และยิง API แทนผู้ใช้ได้
  const svgXss = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/users")</script></svg>')
  const asPng = await uploadAvatar(c, svgXss, 'avatar.png', 'image/png')
  assert.equal(asPng.status, 415, `SVG ที่ปลอมเป็น PNG ต้องถูกปฏิเสธ — ได้ ${asPng.status}`)
  assert.equal((await avatarFiles()).length, 0, 'ไฟล์ที่ถูกปฏิเสธต้องไม่ถูกเขียนลงดิสก์เลย')

  // GIF จริง ๆ ก็ไม่รับ (allowlist คือ PNG/JPEG เท่านั้น ไม่ใช่ "ทุกอย่างที่เป็นภาพ")
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20)])
  assert.equal((await uploadAvatar(c, gif, 'x.gif', 'image/gif')).status, 415)

  // ไฟล์ข้อความล้วนที่อ้างว่าเป็น JPEG
  const text = Buffer.from('this is definitely not an image, promise')
  assert.equal((await uploadAvatar(c, text, 'x.jpg', 'image/jpeg')).status, 415)

  // PNG ที่หัวถูกแต่เนื้อพัง (ไม่มี IDAT) — ปฏิเสธ ไม่ใช่ "ซ่อมให้"
  const brokenPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24),
  ])
  assert.equal((await uploadAvatar(c, brokenPng, 'x.png', 'image/png')).status, 415)

  assert.equal((await avatarFiles()).length, 0, 'ไม่มีไฟล์ใดถูกเขียนจากคำขอที่ถูกปฏิเสธทั้งหมด')
})

test('sanitizeAvatar: เพดานขนาดถูกบังคับที่ระดับฟังก์ชัน ไม่ใช่แค่ใน multer', async () => {
  // เพดานต้องเป็นของ storage layer เอง ไม่ใช่พึ่ง middleware ที่อาจถูกเรียกข้าม
  const huge = Buffer.concat([makePngWithMetadata(), Buffer.alloc(2 * 1024 * 1024)])
  assert.equal(sanitizeAvatar(huge), null, 'ไฟล์เกิน 2 MiB ต้องถูกปฏิเสธที่ sanitizeAvatar')
  assert.equal(sanitizeAvatar(Buffer.alloc(0)), null, 'ไฟล์ว่างต้องถูกปฏิเสธ')
  assert.equal(sanitizeAvatar('not a buffer'), null, 'ค่าที่ไม่ใช่ Buffer ต้องถูกปฏิเสธ')
})

test('ไม่ล็อกอิน → แตะโปรไฟล์/รูปไม่ได้เลย และ CSRF บล็อกก่อนถึงชั้นตรวจตัวตน', async () => {
  const anon = new Client(baseUrl)

  // GET ผ่าน CSRF (safe method) แล้วไปตกที่ requireAuth → 401
  assert.equal((await anon.req('/api/users/1/avatar')).status, 401)

  // ⚠️ PATCH/POST/DELETE ถูก CSRF บล็อก "ก่อน" ถึง requireAuth จึงได้ 403 ไม่ใช่ 401
  //    และนั่นคือลำดับที่ถูกต้อง: คำขอข้ามต้นทางต้องตายก่อนที่ระบบจะเริ่มตรวจตัวตนใด ๆ
  //    รหัส CSRF_TOKEN_INVALID มีไว้ให้ client แยกออกจาก "ไม่มีสิทธิ์" ได้ (ดู middleware/csrf.js)
  const patched = await anon.req('/api/profile', { method: 'PATCH', body: { displayName: 'x' } })
  assert.equal(patched.status, 403, 'คำขอเปลี่ยนสถานะที่ไม่มี CSRF token ต้องถูกบล็อก')
  assert.equal(patched.data?.code, 'CSRF_TOKEN_INVALID', 'ต้องแยกได้ว่าถูกบล็อกเพราะ CSRF ไม่ใช่เพราะสิทธิ์')

  const posted = await anon.req('/api/profile/avatar', { method: 'POST' })
  assert.equal(posted.status, 403)
  assert.equal(posted.data?.code, 'CSRF_TOKEN_INVALID')
})

// ═══ C. เซสชันจริง ══════════════════════════════════════════════════════════════

test('เซสชัน: รายการมาจาก session store จริง (ไม่ใช่แถวที่แต่งขึ้น) และเห็นเฉพาะของตัวเอง', async () => {
  const a1 = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const a2 = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password) // อุปกรณ์ที่สองของคนเดียวกัน
  const other = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const res = await a1.req('/api/sessions')
  assert.equal(res.status, 200)
  const sessions = res.data.sessions
  assert.ok(sessions.length >= 2, `ต้องเห็นเซสชันทั้งสองของตัวเอง — เห็น ${sessions.length}`)

  // ⚠️ ต้องมีเซสชันที่ถูกทำเครื่องหมายว่า "เครื่องนี้" หนึ่งรายการพอดี
  assert.equal(sessions.filter((s) => s.current).length, 1, 'ต้องระบุเซสชันปัจจุบันได้หนึ่งรายการพอดี')

  // ค่าต้องเป็นของจริง ไม่ใช่ค่าคงที่: มี ip, มี user-agent ที่เราส่งไป, เวลาเพิ่งเกิด
  for (const s of sessions) {
    assert.ok(s.lastSeenAt && Math.abs(Date.now() - s.lastSeenAt) < 120_000, 'lastSeenAt ต้องเป็นเวลาจริงที่เพิ่งเกิด')
    assert.ok(s.ref && /^[0-9a-f]{16}$/.test(s.ref), 'ref ต้องเป็น hash ตัดสั้น ไม่ใช่ session id ดิบ')
  }

  // ⚠️ ห้ามหลุด session id ดิบออกไปเลย — ใครถือ id ก็ปลอมเป็นเจ้าของเซสชันได้
  const raw = JSON.stringify(sessions)
  assert.ok(!raw.includes('connect.sid') && !raw.includes('aegis.drive.sid'), 'ห้ามมีชื่อ/ค่า cookie ในผลลัพธ์')

  // เซสชันของ admin ต้องไม่โผล่ในรายการของ user
  const adminSessions = (await other.req('/api/sessions')).data.sessions
  const userRefs = new Set(sessions.map((s) => s.ref))
  for (const s of adminSessions) {
    assert.ok(!userRefs.has(s.ref), 'เซสชันของบัญชีอื่นต้องไม่ปรากฏในรายการของเรา')
  }
})

test('เซสชัน: เพิกถอนของตัวเองได้จริง (เซสชันนั้นใช้ต่อไม่ได้ทันที) แต่ของคนอื่นไม่ได้', async () => {
  const keeper = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const doomed = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)

  // ยืนยันว่า doomed ใช้งานได้ก่อน
  assert.equal((await doomed.req('/api/files')).status, 200)

  const list = await keeper.req('/api/sessions')
  const target = list.data.sessions.find((s) => !s.current)
  assert.ok(target, 'ต้องมีเซสชันอื่นให้เพิกถอน')

  const revoked = await keeper.req(`/api/sessions/${target.ref}`, { method: 'DELETE' })
  assert.equal(revoked.status, 204, `เพิกถอนต้องสำเร็จ — ได้ ${revoked.status}`)

  // ⚠️ สิ่งที่ต้องพิสูจน์คือ "ของจริงถูกทำลาย" ไม่ใช่แค่หายจากรายการ
  const afterRevoke = await doomed.req('/api/files')
  assert.equal(afterRevoke.status, 401, `เซสชันที่ถูกเพิกถอนต้องใช้ต่อไม่ได้ — ได้ ${afterRevoke.status}`)

  // เซสชันของเราเองยังใช้ได้ปกติ
  assert.equal((await keeper.req('/api/files')).status, 200)

  // เพิกถอนเซสชันของบัญชีอื่นไม่ได้ (จะเป็น DoS ต่อบัญชีอื่น)
  const victim = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const victimRef = (await victim.req('/api/sessions')).data.sessions.find((s) => s.current).ref
  const crossRevoke = await keeper.req(`/api/sessions/${victimRef}`, { method: 'DELETE' })
  assert.equal(crossRevoke.status, 404, 'เพิกถอนเซสชันของคนอื่นต้องไม่สำเร็จ')
  assert.equal((await victim.req('/api/files')).status, 200, 'เซสชันของเหยื่อต้องยังใช้งานได้')

  // เพิกถอนเซสชันที่กำลังใช้อยู่ผ่านเส้นนี้ไม่ได้ (ต้องใช้ /logout ที่ล้าง cookie ให้ด้วย)
  const selfRef = (await keeper.req('/api/sessions')).data.sessions.find((s) => s.current).ref
  assert.equal((await keeper.req(`/api/sessions/${selfRef}`, { method: 'DELETE' })).status, 400)
})

// ═══ ฟีเจอร์ที่ถูกถอดออกต้องไม่กลับมา ════════════════════════════════════════════

test('endpoint กุญแจเข้ารหัสที่ถูกถอดออกต้องไม่มีอยู่อีก (404 ไม่ใช่ 200)', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  // ⚠️ /api/keys รายงาน keyId/algorithm/rotatedAt ของกุญแจ master ที่ไม่มีอยู่จริง และ
  //    /api/keys/rotate แค่เขียนเวลาใหม่ทับตัวแปรในหน่วยความจำ — ถ้าวันหนึ่งกลับมาเป็น 200
  //    ให้ถือว่าเป็น regression เชิงความปลอดภัย ไม่ใช่ฟีเจอร์ที่ถูกเพิ่มคืน
  assert.equal((await admin.req('/api/keys')).status, 404, '/api/keys ต้องไม่มีอยู่')
  assert.equal((await admin.req('/api/keys/rotate', { method: 'POST' })).status, 404, '/api/keys/rotate ต้องไม่มีอยู่')
})

test('network zones: บันทึกลงที่เก็บจริง (อยู่รอดการอ่านซ้ำ) และตรวจ CIDR จริง', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const cidr = `10.${Math.floor(Math.random() * 250)}.7.0/24`

  const created = await admin.req('/api/zones', { method: 'POST', body: { name: 'QA probe zone', cidr } })
  assert.equal(created.status, 201, `ต้องเพิ่ม zone ได้ — ได้ ${JSON.stringify(created.data)}`)

  const list = await admin.req('/api/zones')
  const row = list.data.zones.find((z) => z.cidr === cidr)
  assert.ok(row, 'zone ที่เพิ่มต้องอ่านกลับมาได้จากที่เก็บ')
  assert.equal(row.name, 'QA probe zone')

  // CIDR ที่ผ่าน regex แต่ไม่มีความหมายต้องถูกปฏิเสธ (999.1.1.1/99)
  assert.equal((await admin.req('/api/zones', { method: 'POST', body: { name: 'bad', cidr: '999.1.1.1/99' } })).status, 400)
  assert.equal((await admin.req('/api/zones', { method: 'POST', body: { name: 'bad', cidr: '10.0.0.0/33' } })).status, 400)
  // CIDR ซ้ำต้องถูกปฏิเสธ ไม่ใช่สร้างแถวคู่ที่คุมช่วงเดียวกัน
  assert.equal((await admin.req('/api/zones', { method: 'POST', body: { name: 'dup', cidr } })).status, 400)

  assert.equal((await admin.req(`/api/zones/${row.id}`, { method: 'DELETE' })).status, 200)

  // ผู้ใช้ทั่วไปแตะ zone ไม่ได้เลย (governance = Admin เท่านั้น)
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  assert.equal((await user.req('/api/zones')).status, 403)
})
