// tests/uploadRecovery.test.js — FILES-UPLOAD-RECOVERY-1
//
// ปัญหาที่ไฟล์นี้ตรึงไว้ (ยืนยันแล้วบน Production):
//   กด refresh หนัก ๆ ระหว่างอัปโหลด → SPA ถูกทำลาย → คิวหายทั้งชุด และ request
//   ฝั่ง client ถูก abort ทิ้ง ทั้งที่ **เซสชันฝั่งเซิร์ฟเวอร์ยังอยู่ครบ** พร้อม chunk
//   ที่รับไปแล้ว ผู้ใช้จึงต้องเริ่มไฟล์ 2 GB ใหม่ตั้งแต่ไบต์แรกโดยไม่จำเป็นเลย
//
// ⚠️ กติกาที่สำคัญที่สุดสามข้อ:
//    1. "หน้าเว็บถูกทำลาย" ไม่ใช่ "ผู้ใช้กดยกเลิก" — teardown หยุดได้แค่ request ในเครื่อง
//       ห้ามลบเซสชันฝั่งเซิร์ฟเวอร์ และห้ามลบบันทึกกู้คืน
//    2. บันทึกกู้คืนเก็บได้เฉพาะ metadata ที่มีขอบเขต — ห้ามเก็บไบต์ของไฟล์เด็ดขาด
//       ขนาดของสิ่งที่เก็บต้องเป็น O(metadata) ไม่ใช่ O(ขนาดไฟล์)
//    3. ไฟล์ที่ผู้ใช้เลือกกลับมาต้อง "พิสูจน์ตัวตน" ก่อนส่งต่อเข้าเซสชันเดิม ชื่อซ้ำแต่
//       เนื้อในคนละไฟล์ = ปฏิเสธ ไม่งั้นเราจะประกอบไฟล์ปนกันแล้ว commit ผ่านไม่ได้อยู่ดี
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let vite
let recovery
let chunked

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  recovery = await vite.ssrLoadModule('/src/lib/uploadRecovery.js')
  chunked = await vite.ssrLoadModule('/src/lib/chunkedUpload.js')
})

after(async () => {
  await vite?.close()
})

/* ── ตัวช่วย ──────────────────────────────────────────────────────────────── */

/** localStorage ปลอมที่พฤติกรรมเหมือนของจริง รวมถึงการเก็บเป็น "สตริงเท่านั้น" */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

const checkpointOf = (over = {}) => ({
  reason: 'created',
  uploadId: 'a'.repeat(48),
  sha256: 'b'.repeat(64),
  chunkSize: 16 * 1024 * 1024,
  chunkCount: 4,
  receivedBytes: 0,
  ...over,
})

const fileOf = (over = {}) => ({ name: 'clip.mp4', size: 64 * 1024 * 1024, lastModified: 1_700_000_000_000, ...over })

/* ══ 1–2 · ร้านเก็บบันทึกกู้คืน ════════════════════════════════════════════ */

test('RECOVERY 1 · creating a server upload session writes a durable recovery record', () => {
  const storage = fakeStorage()
  const store = recovery.createRecoveryStore({ storage, now: () => 1000 })

  store.save(recovery.recoveryRecordFrom(checkpointOf(), fileOf(), { stage: 'uploading' }))

  const rows = store.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uploadId, 'a'.repeat(48))
  assert.equal(rows[0].name, 'clip.mp4')
  assert.equal(rows[0].size, 64 * 1024 * 1024)
  assert.equal(rows[0].sha256, 'b'.repeat(64))
  assert.equal(rows[0].chunkCount, 4)
  assert.equal(rows[0].version, recovery.RECOVERY_VERSION)
  // ต้องอยู่รอดข้าม "การสร้างร้านใหม่" ซึ่งคือสิ่งที่เกิดขึ้นจริงตอน reload
  const reopened = recovery.createRecoveryStore({ storage, now: () => 2000 })
  assert.equal(reopened.list().length, 1)
})

test('RECOVERY 2 · the recovery record never carries file bytes, handles, or secrets', () => {
  const storage = fakeStorage()
  const store = recovery.createRecoveryStore({ storage, now: () => 1000 })

  // ของแถมที่ "ไม่ควรถูกเก็บ" ทุกชนิด รวมถึงไบต์ก้อนใหญ่ที่เผลอแนบมากับ checkpoint
  const poisoned = {
    ...checkpointOf(),
    file: { name: 'clip.mp4' },
    blob: 'x'.repeat(5000),
    bytes: new Uint8Array(4096),
    chunk: 'y'.repeat(5000),
    csrfToken: 'should-never-be-stored',
    cookie: 'session=should-never-be-stored',
    handle: { kind: 'file' },
  }
  store.save(recovery.recoveryRecordFrom(poisoned, fileOf(), { stage: 'uploading' }))

  const raw = storage.getItem(recovery.RECOVERY_STORAGE_KEY)
  assert.doesNotMatch(raw, /should-never-be-stored/)
  assert.doesNotMatch(raw, /xxxxxxxxxx/)
  assert.doesNotMatch(raw, /yyyyyyyyyy/)
  assert.doesNotMatch(raw, /"bytes"|"blob"|"chunk"|"cookie"|"csrfToken"|"handle"|"file"/)
  // และต้องเล็กแบบ O(metadata) ไม่ว่าไฟล์จะใหญ่แค่ไหน
  assert.ok(raw.length < 1024, `recovery record must stay bounded, got ${raw.length} bytes`)

  const [row] = store.list()
  for (const key of Object.keys(row)) {
    assert.ok(recovery.RECOVERY_FIELDS.includes(key), `unexpected persisted field: ${key}`)
  }
})

test('RECOVERY 2b · a corrupt or unavailable store degrades to empty instead of throwing', () => {
  const corrupt = recovery.createRecoveryStore({ storage: fakeStorage({ [recovery.RECOVERY_STORAGE_KEY]: '{not json' }) })
  assert.deepEqual(corrupt.list(), [])

  const hostile = recovery.createRecoveryStore({
    storage: {
      getItem() { throw new Error('SecurityError') },
      setItem() { throw new Error('QuotaExceededError') },
      removeItem() { throw new Error('SecurityError') },
    },
  })
  assert.deepEqual(hostile.list(), [])
  assert.doesNotThrow(() => hostile.save(recovery.recoveryRecordFrom(checkpointOf(), fileOf(), { stage: 'uploading' })))
  assert.doesNotThrow(() => hostile.remove('a'.repeat(48)))
})

test('RECOVERY 2c · records are keyed by uploadId, updated in place, and bounded in count', () => {
  const storage = fakeStorage()
  const store = recovery.createRecoveryStore({ storage, now: () => 1000 })

  store.save(recovery.recoveryRecordFrom(checkpointOf(), fileOf(), { stage: 'uploading' }))
  store.save(recovery.recoveryRecordFrom(checkpointOf({ receivedBytes: 999 }), fileOf(), { stage: 'uploading' }))
  assert.equal(store.list().length, 1, 'uploadId เดิม = อัปเดตทับ ไม่ใช่เพิ่มแถวใหม่')
  assert.equal(store.list()[0].receivedBytes, 999)

  for (let i = 0; i < recovery.MAX_RECOVERY_RECORDS + 10; i += 1) {
    store.save(recovery.recoveryRecordFrom(checkpointOf({ uploadId: String(i).padStart(48, '0') }), fileOf(), { stage: 'uploading' }))
  }
  assert.ok(store.list().length <= recovery.MAX_RECOVERY_RECORDS, 'ร้านต้องไม่โตไม่จำกัด')
})

/* ══ 3 · checkpoint จาก transport ═════════════════════════════════════════ */

test('RECOVERY 3 · uploadFileResumable emits a checkpoint as soon as a durable server session exists', async () => {
  const checkpoints = []
  const upload = { uploadId: 'c'.repeat(48), chunkSize: 4, chunkCount: 2, received: [], missing: [0, 1], receivedBytes: 0 }

  const result = await chunked.uploadFileResumable({
    file: { name: 'clip.mp4', size: 8, slice: () => ({}) },
    hashFile: async () => 'd'.repeat(64),
    fetchJson: async (url, options = {}) => {
      if (options.method === 'POST' && url === '/api/files/uploads') return { ok: true, data: { upload } }
      if (url.endsWith('/commit')) return { ok: true, data: { sha256: 'd'.repeat(64), file: { id: 'f1' } } }
      return { ok: true, data: { upload } }
    },
    sendUpload: async (url) => ({
      ok: true,
      data: { upload: { ...upload, received: [0, 1], missing: [], receivedBytes: 8 } },
      url,
    }),
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  })

  assert.equal(result.ok, true)
  const created = checkpoints.find((c) => c.reason === 'created')
  assert.ok(created, 'ต้องมี checkpoint ทันทีที่เซสชันฝั่งเซิร์ฟเวอร์ถูกสร้าง')
  assert.equal(created.uploadId, 'c'.repeat(48))
  assert.equal(created.sha256, 'd'.repeat(64))
  assert.equal(created.chunkCount, 2)
  // checkpoint ต้องเป็นสแนปช็อตธรรมดา ไม่ใช่การยื่นวัตถุภายในที่เปลี่ยนค่าได้ออกไป
  assert.equal(Object.isFrozen(created), true)
  assert.equal(typeof created.file, 'undefined')

  assert.ok(checkpoints.some((c) => c.reason === 'chunk'), 'chunk ที่ถูกรับต้องอัปเดต checkpoint ด้วย')
  assert.ok(checkpoints.some((c) => c.reason === 'done'), 'commit สำเร็จต้องปิดบันทึก')
})

test('RECOVERY 3b · a resumed upload checkpoints the authoritative server status, not remembered state', async () => {
  const checkpoints = []
  const remembered = { uploadId: 'e'.repeat(48), chunkSize: 4, chunkCount: 2, received: [], missing: [0, 1], receivedBytes: 0 }
  const authoritative = { ...remembered, received: [0], missing: [1], receivedBytes: 4 }

  await chunked.uploadFileResumable({
    file: { name: 'clip.mp4', size: 8, slice: () => ({}) },
    upload: remembered,
    sha256: 'f'.repeat(64),
    fetchJson: async (url) => {
      if (url.endsWith('/commit')) return { ok: true, data: { sha256: 'f'.repeat(64), file: { id: 'f1' } } }
      return { ok: true, data: { upload: authoritative } }
    },
    sendUpload: async () => ({ ok: true, data: { upload: { ...authoritative, received: [0, 1], missing: [], receivedBytes: 8 } } }),
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  })

  const resumed = checkpoints.find((c) => c.reason === 'resumed')
  assert.ok(resumed, 'การ resume ต้องบันทึกสถานะที่เซิร์ฟเวอร์ยืนยัน')
  assert.equal(resumed.receivedBytes, 4, 'ต้องเป็นตัวเลขของเซิร์ฟเวอร์ ไม่ใช่ของที่จำไว้ในแท็บ')
})

/* ══ 4 · อ่านสถานะเซสชันเพื่อคืนสภาพ ═════════════════════════════════════ */

test('RECOVERY 4 · fetchUploadSession classifies live, expired, and missing sessions truthfully', async () => {
  const live = await chunked.fetchUploadSession('a'.repeat(48), {
    fetchJson: async () => ({ ok: true, data: { upload: { uploadId: 'a'.repeat(48), missing: [2, 3], receivedBytes: 32, status: 'open' } } }),
  })
  assert.equal(live.ok, true)
  assert.deepEqual(live.upload.missing, [2, 3])

  const gone = await chunked.fetchUploadSession('a'.repeat(48), {
    fetchJson: async () => ({ ok: false, status: 404, data: { error: 'Not found' } }),
  })
  assert.equal(gone.ok, false)
  assert.equal(gone.reason, 'expired', 'เซสชันที่หายไปแล้วต้องบอกตรง ๆ ว่าหมดอายุ ไม่ใช่เงียบ')

  const offline = await chunked.fetchUploadSession('a'.repeat(48), {
    fetchJson: async () => ({ ok: false, errorKind: 'network' }),
  })
  assert.equal(offline.ok, false)
  assert.equal(offline.reason, 'network', 'เน็ตล่ม ≠ เซสชันหมดอายุ — ห้ามทิ้งบันทึกกู้คืน')
})

/* ══ 5 · พิสูจน์ตัวตนของไฟล์ต้นทางที่ผู้ใช้เลือกกลับมา ═══════════════════ */

test('RECOVERY 5 · a file of the wrong size is refused before a single chunk is sent', async () => {
  let hashed = 0
  const verdict = await recovery.verifyRecoveryIdentity(
    { size: 1024, sha256: 'a'.repeat(64), lastModified: 10 },
    { name: 'clip.mp4', size: 2048, lastModified: 10 },
    { hashFile: async () => { hashed += 1; return 'a'.repeat(64) } },
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'size')
  assert.equal(hashed, 0, 'ขนาดไม่ตรงก็รู้แล้ว ไม่ต้องเสียเวลาแฮชไฟล์ทั้งก้อน')
})

test('RECOVERY 5b · same name and same size but different bytes is refused by the checksum', async () => {
  const verdict = await recovery.verifyRecoveryIdentity(
    { size: 1024, sha256: 'a'.repeat(64) },
    { name: 'clip.mp4', size: 1024 },
    { hashFile: async () => 'b'.repeat(64) },
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'content', 'ชื่อเดียวกันแต่คนละไฟล์ต้องไม่ถูกต่อเข้าเซสชันเดิม')
})

test('RECOVERY 5c · the correct file passes identity and carries the recorded checksum forward', async () => {
  const verdict = await recovery.verifyRecoveryIdentity(
    { size: 1024, sha256: 'a'.repeat(64) },
    { name: 'clip.mp4', size: 1024 },
    { hashFile: async () => 'a'.repeat(64) },
  )
  assert.equal(verdict.ok, true)
  assert.equal(verdict.sha256, 'a'.repeat(64), 'ต้องส่ง sha เดิมต่อ เพื่อไม่ให้ transport แฮชซ้ำทั้งไฟล์')
})

test('RECOVERY 5d · identity verification can be cancelled and reports no false match', async () => {
  const verdict = await recovery.verifyRecoveryIdentity(
    { size: 1024, sha256: 'a'.repeat(64) },
    { name: 'clip.mp4', size: 1024 },
    { hashFile: async () => { throw new DOMException('Aborted', 'AbortError') } },
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cancelled')
})
