// tests/chunkedUploadClient.test.js — AEGIS Drive (IDEA1) · ฝั่งเบราว์เซอร์ของ LFT-V2-A
//
// สิ่งที่ชุดนี้พิสูจน์ (ข้อ 15 และ 16 ของ LFT-V2-A) — และวิธีที่มันพิสูจน์:
//
//   15. **การแฮชในเบราว์เซอร์ไม่เรียก file.arrayBuffer() ของทั้งไฟล์**
//       ไม่ได้พิสูจน์ด้วยการ grep ข้อความในซอร์สอย่างเดียว แต่ด้วย File จำลองที่
//       `arrayBuffer()` ของ "ทั้งไฟล์" จะ throw ทันทีที่ถูกเรียก — ถ้าโค้ดยังอ่านทั้งไฟล์
//       เทสต์จะล้มด้วยพฤติกรรมจริง ไม่ใช่ด้วยการจับคู่ regex ที่หลบเลี่ยงได้
//
//   16. **สัญญาเรื่องหน่วยความจำถูกจำกัดด้วยโครงสร้าง**
//       บันทึกขนาดของทุก slice ที่ถูกอ่าน แล้วยืนยันว่าไม่มี slice ใดใหญ่เกินขอบเขต
//       ที่ประกาศไว้ และผลรวมของสิ่งที่ "ถือไว้พร้อมกัน" ไม่เคยเป็น O(ขนาดไฟล์)
//       ฝั่งเซิร์ฟเวอร์ตรวจคู่กันด้วยว่าเส้นทางรับ chunk ไม่มี body parser ที่สะสมทั้งก้อน
//
// นอกจากนั้นยังตรึงความถูกต้องของแฮชแบบ incremental (ต้องเท่ากับ SHA-256 ของทั้งไฟล์)
// และพฤติกรรม resume/หยุดชั่วคราวของ uploadFileResumable
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let vite
let incrementalSha256
let uploadFileResumable
let HASH_SLICE_BYTES

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  })
  ;({ incrementalSha256, uploadFileResumable, HASH_SLICE_BYTES } =
    await vite.ssrLoadModule('/src/lib/chunkedUpload.js'))
})

after(async () => {
  await vite?.close()
})

/**
 * File จำลองที่ "อ่านทั้งไฟล์ไม่ได้"
 *
 * ⚠️ นี่คือหัวใจของข้อ 15: arrayBuffer() ระดับไฟล์ throw เสมอ ดังนั้นโค้ดใดก็ตามที่ยัง
 *    ดึงทั้งไฟล์เข้าหน่วยความจำจะล้มทันที ส่วน slice() ทำงานได้ปกติและบันทึกไว้ว่าอ่าน
 *    ช่วงไหนไปบ้าง — เทสต์จึงวัด "พฤติกรรม" ไม่ใช่ "ข้อความในซอร์ส"
 */
function makeCountingFile(bytes, { name = 'big.bin' } = {}) {
  const reads = []
  let wholeFileReads = 0
  const file = {
    name,
    size: bytes.length,
    get wholeFileReads() { return wholeFileReads },
    get reads() { return reads },
    async arrayBuffer() {
      wholeFileReads += 1
      throw new Error('whole-file arrayBuffer() must never be called on the V2 upload path')
    },
    slice(start, end) {
      const from = start ?? 0
      const to = end ?? bytes.length
      reads.push({ start: from, end: to, length: to - from })
      const part = bytes.subarray(from, to)
      return {
        size: part.length,
        async arrayBuffer() {
          const copy = new ArrayBuffer(part.length)
          new Uint8Array(copy).set(part)
          return copy
        },
      }
    },
  }
  return file
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ─────────────────────────────────────────────────────────────────────────────
// 15 · การแฮชไม่แตะ arrayBuffer() ของทั้งไฟล์ และให้ค่าที่ถูกต้อง
// ─────────────────────────────────────────────────────────────────────────────
test('15 · incrementalSha256 อ่านทีละ slice เท่านั้น และให้ค่าเท่ากับ SHA-256 ของทั้งไฟล์', async () => {
  // ขนาดที่ "ไม่ลงตัว" กับ slice โดยเจตนา — จับบั๊กของก้อนสุดท้ายที่เป็นเศษ
  const bytes = randomBytes(HASH_SLICE_BYTES * 2 + 12_345)
  const file = makeCountingFile(bytes)

  const digest = await incrementalSha256(file)

  assert.equal(digest, sha256(bytes), 'แฮชแบบ incremental ต้องเท่ากับแฮชของทั้งไฟล์เป๊ะ ๆ')
  assert.equal(file.wholeFileReads, 0, 'ต้องไม่มีการเรียก file.arrayBuffer() ของทั้งไฟล์เลย')
  assert.equal(file.reads.length, 3, 'ไฟล์นี้ต้องถูกอ่านเป็นสามช่วง ไม่ใช่ครั้งเดียว')
})

test('15 · ไฟล์ว่างยังได้แฮชที่ถูกต้อง และไม่มีการอ่านไบต์ใดเลย', async () => {
  const file = makeCountingFile(Buffer.alloc(0))
  assert.equal(await incrementalSha256(file), sha256(Buffer.alloc(0)))
  assert.equal(file.wholeFileReads, 0)
  assert.equal(file.reads.length, 0)
})

test('15 · ซอร์สของเส้นทางอัปโหลด V2 ไม่มีการอ่านทั้งไฟล์เหลืออยู่เลย', async () => {
  const [uploader, screen, drawer] = await Promise.all([
    fs.readFile(new URL('../src/lib/chunkedUpload.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/screens/Uploads.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/UploadDrawer.jsx', import.meta.url), 'utf8'),
  ])
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')

  for (const [label, source] of [['chunkedUpload.js', uploader], ['Uploads.jsx', screen], ['UploadDrawer.jsx', drawer]]) {
    const code = stripComments(source)
    assert.doesNotMatch(code, /\bfile\.arrayBuffer\(\)/, `${label} ต้องไม่อ่านทั้งไฟล์เข้าหน่วยความจำ`)
    assert.doesNotMatch(code, /crypto\.subtle\.digest\(/, `${label} ต้องไม่ใช้ subtle.digest ซึ่งรับได้แต่ buffer ทั้งก้อน`)
  }
  // และการอ่านที่เหลืออยู่ต้องเป็นการอ่านแบบมีขอบเขตจริง ๆ
  assert.match(stripComments(uploader), /file\.slice\(/)
})

// ─────────────────────────────────────────────────────────────────────────────
// 16 · สัญญาเรื่องหน่วยความจำถูกจำกัดด้วยโครงสร้าง (ทั้งสองฝั่ง)
// ─────────────────────────────────────────────────────────────────────────────
test('16 · ทุก slice ที่ถูกอ่านมีขนาดไม่เกินขอบเขตที่ประกาศไว้ ไม่ว่าไฟล์จะใหญ่แค่ไหน', async () => {
  const sliceBytes = 64 * 1024
  // ไฟล์ที่ใหญ่กว่าขอบเขตหลายสิบเท่า — ถ้าโค้ดอ่านทั้งไฟล์ ขนาด slice จะโผล่มาเกินทันที
  const bytes = randomBytes(sliceBytes * 40 + 777)
  const file = makeCountingFile(bytes)

  await incrementalSha256(file, { sliceBytes })

  const largest = Math.max(...file.reads.map((r) => r.length))
  assert.ok(largest <= sliceBytes, `slice ที่ใหญ่ที่สุดต้องไม่เกิน ${sliceBytes} ไบต์ — วัดได้ ${largest}`)
  assert.equal(file.reads.length, 41, 'จำนวนการอ่านต้องเป็น O(ขนาดไฟล์ / sliceBytes) ตามที่ออกแบบไว้')
  // ช่วงที่อ่านต้องต่อกันพอดี ไม่ทับซ้อนและไม่ข้าม — พิสูจน์ว่าครอบคลุมทั้งไฟล์จริง
  let cursor = 0
  for (const read of file.reads) {
    assert.equal(read.start, cursor)
    cursor = read.end
  }
  assert.equal(cursor, bytes.length)
})

test('16 · แต่ละ chunk ที่ถูกส่งมีขนาดไม่เกิน chunkSize และครอบคลุมไฟล์พอดีหนึ่งรอบ', async () => {
  const chunkSize = 32 * 1024
  const bytes = randomBytes(chunkSize * 3 + 100)
  const file = makeCountingFile(bytes)
  const chunkCount = Math.ceil(bytes.length / chunkSize)

  const sentSizes = []
  const upload = {
    uploadId: 'a'.repeat(48), name: file.name, size: bytes.length,
    chunkSize, chunkCount, status: 'open', expiresAt: Date.now() + 60_000,
    received: [], missing: [...Array(chunkCount).keys()], receivedBytes: 0,
  }

  const result = await uploadFileResumable({
    file,
    hashFile: async () => sha256(bytes),
    fetchJson: async (pathname, options = {}) => {
      if (options.method === 'POST' && pathname === '/api/files/uploads') {
        return { ok: true, status: 201, data: { upload }, errorKind: null }
      }
      if (pathname.endsWith('/commit')) {
        return { ok: true, status: 201, data: { file: { id: 'f1' }, sha256: sha256(bytes), newVersion: false }, errorKind: null }
      }
      return { ok: true, status: 200, data: { upload }, errorKind: null }
    },
    sendUpload: async (pathname, options) => {
      sentSizes.push(options.body.size)
      const index = Number(pathname.split('/').pop())
      const next = {
        ...upload,
        received: [...upload.received, index],
        missing: upload.missing.filter((i) => i !== index),
        receivedBytes: upload.receivedBytes + options.body.size,
      }
      return { ok: true, status: 200, data: { index, upload: next }, errorKind: null }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(file.wholeFileReads, 0)
  assert.equal(sentSizes.length, chunkCount)
  assert.ok(Math.max(...sentSizes) <= chunkSize, 'ไม่มี chunk ใดใหญ่เกิน chunkSize')
  assert.equal(sentSizes.reduce((a, b) => a + b, 0), bytes.length, 'chunk ทั้งหมดรวมกันต้องเท่ากับขนาดไฟล์พอดี')
  assert.deepEqual(sentSizes.slice(0, -1), Array(chunkCount - 1).fill(chunkSize))
  assert.equal(sentSizes.at(-1), 100, 'chunk สุดท้ายคือเศษที่เหลือ ไม่ใช่ก้อนเต็ม')
})

test('16 · เส้นทางรับ chunk ฝั่งเซิร์ฟเวอร์ไม่มี body parser ที่สะสมทั้งก้อนไว้ในหน่วยความจำ', async () => {
  const [routes, staging, app] = await Promise.all([
    fs.readFile(new URL('../server/routes/uploads.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/storage/uploadStaging.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/app.js', import.meta.url), 'utf8'),
  ])
  const stripComments = (source) => source
    .split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')

  const routeCode = stripComments(routes)
  // ไบต์ของ chunk ต้องไม่ผ่าน multer/express.raw/express.json — ทั้งสามสะสมทั้งก้อนใน RAM
  assert.doesNotMatch(routeCode, /express\.raw|express\.json|multer|\.buffer\b/)
  // และต้องส่ง request stream เข้าไปเขียนลงดิสก์โดยตรง
  assert.match(routeCode, /source: req/)
  assert.match(stripComments(staging), /pipeline\(source, meter, sink\)/)
  assert.match(stripComments(staging), /createWriteStream\(/)
  // express.json ทั่วทั้งแอปยังต้องมีเพดานเล็ก ๆ เหมือนเดิม (chunk ไม่ได้เดินผ่านมัน)
  assert.match(stripComments(app), /express\.json\(\{ limit: '16kb' \}\)/)
})

// ─────────────────────────────────────────────────────────────────────────────
// resume / paused — สัญญาที่จอ Uploads พึ่งพาเพื่อเสนอปุ่ม "ทำต่อ"
// ─────────────────────────────────────────────────────────────────────────────
test('การส่ง chunk ที่ล้มเหลวจากเครือข่ายทำให้หยุดชั่วคราวโดยยังคืน session ให้ทำต่อได้', async () => {
  const chunkSize = 16 * 1024
  const bytes = randomBytes(chunkSize * 3)
  const file = makeCountingFile(bytes)
  const upload = {
    uploadId: 'b'.repeat(48), name: file.name, size: bytes.length,
    chunkSize, chunkCount: 3, status: 'open', expiresAt: Date.now() + 60_000,
    received: [], missing: [0, 1, 2], receivedBytes: 0,
  }
  const stages = []

  const attempts = []
  const paused = await uploadFileResumable({
    file,
    hashFile: async () => sha256(bytes),
    onStage: (stage) => stages.push(stage),
    fetchJson: async (pathname, options = {}) => (
      options.method === 'POST' && pathname === '/api/files/uploads'
        ? { ok: true, status: 201, data: { upload }, errorKind: null }
        : { ok: true, status: 200, data: { upload }, errorKind: null }
    ),
    sendUpload: async (pathname) => {
      const index = Number(pathname.split('/').pop())
      attempts.push(index)
      if (index === 0) {
        upload.received = [0]
        upload.missing = [1, 2]
        upload.receivedBytes = chunkSize
        return { ok: true, status: 200, data: { index, upload: { ...upload } }, errorKind: null }
      }
      return { ok: false, status: 0, data: null, errorKind: 'network' }
    },
  })

  assert.equal(paused.ok, false)
  assert.equal(paused.stage, 'paused', 'เน็ตหลุด = หยุดชั่วคราว ไม่ใช่ล้มเหลวถาวร')
  assert.equal(paused.reason, 'network')
  assert.equal(paused.upload.uploadId, upload.uploadId, 'ต้องคืน session กลับไปเพื่อให้ทำต่อได้')
  assert.deepEqual(paused.upload.missing, [1, 2], 'ก้อนที่สำเร็จแล้วต้องไม่ถูกนับว่าขาด')
  assert.deepEqual(stages, ['preparing', 'hashing', 'uploading'])
  // ก้อนที่ล้มเหลวถูกลองซ้ำจริง (3 ครั้ง) แต่ก้อนที่สำเร็จแล้วไม่ถูกส่งซ้ำเลย
  assert.equal(attempts.filter((i) => i === 0).length, 1)
  assert.equal(attempts.filter((i) => i === 1).length, 3)

  // ── กด "ทำต่อ" — ต้องข้ามการแฮชใหม่ และส่งเฉพาะก้อนที่ยังขาด ─────────────
  const sentOnResume = []
  const resumed = await uploadFileResumable({
    file,
    upload: paused.upload,
    sha256: paused.sha256,
    hashFile: async () => { throw new Error('resume ต้องไม่แฮชไฟล์ใหม่ทั้งก้อน') },
    fetchJson: async (pathname) => (
      pathname.endsWith('/commit')
        ? { ok: true, status: 201, data: { file: { id: 'f2' }, sha256: sha256(bytes), newVersion: false }, errorKind: null }
        : { ok: true, status: 200, data: { upload: { ...upload, received: [0], missing: [1, 2], receivedBytes: chunkSize } }, errorKind: null }
    ),
    sendUpload: async (pathname, options) => {
      const index = Number(pathname.split('/').pop())
      sentOnResume.push(index)
      return {
        ok: true,
        status: 200,
        data: { index, upload: { ...upload, received: [0, index], missing: [], receivedBytes: chunkSize + options.body.size } },
        errorKind: null,
      }
    },
  })

  assert.equal(resumed.ok, true)
  assert.deepEqual(sentOnResume, [1, 2], 'ทำต่อต้องส่งเฉพาะก้อนที่ขาด ไม่ใช่ทั้งไฟล์ใหม่')
})

test('คำขอที่ถูกปฏิเสธด้วยเพดานหรือพื้นที่ไม่พอ ถูกแปลเป็นเหตุผลที่จอแสดงได้ตรง', async () => {
  const bytes = randomBytes(1024)
  const file = makeCountingFile(bytes)
  const deny = (code, status) => uploadFileResumable({
    file,
    hashFile: async () => sha256(bytes),
    fetchJson: async () => ({ ok: false, status, data: { code }, errorKind: 'server' }),
    sendUpload: async () => { throw new Error('ต้องไม่ส่ง chunk เมื่อเปิด session ไม่สำเร็จ') },
  })

  const tooLarge = await deny('LOGICAL_LIMIT_EXCEEDED', 413)
  assert.equal(tooLarge.stage, 'failed')
  assert.equal(tooLarge.reason, 'tooLarge')

  const noSpace = await deny('INSUFFICIENT_STORAGE', 507)
  assert.equal(noSpace.stage, 'failed')
  assert.equal(noSpace.reason, 'noSpace')
})
