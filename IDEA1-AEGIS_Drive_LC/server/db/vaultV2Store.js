// server/db/vaultV2Store.js — AEGIS Drive (IDEA1) · Metadata Layer ของ Private Vault V2
//
// ⚠️ กติกาที่ห้ามละเมิดในไฟล์นี้ทั้งไฟล์ (เหมือนหมวด Vault ใน db/store.js):
//    1. ไม่มีฟังก์ชันใดรับ passphrase / KEK / DEK ที่ยังไม่ถูกห่อ หรือ plaintext ใด ๆ
//    2. ไม่มีคอลัมน์ใดเก็บชื่อไฟล์หรือ MIME — ทั้งสองอยู่ใน meta_b64 ที่เข้ารหัสด้วย DEK
//    3. ทุกฟังก์ชันที่ค้น session/blob รับ userId เป็นพารามิเตอร์ "บังคับ" และกรองใน
//       ชั้น SQL เสมอ ของผู้ใช้อื่นต้องคืน null (ผู้เรียกแปลเป็น 404 ไม่ใช่ 403)
//    ถ้าวันหนึ่งมีคนเพิ่มสิ่งที่ขัดข้อใดข้อหนึ่ง นั่นคือ bug ระดับสถาปัตยกรรม ไม่ใช่ feature
//
// ⚠️ ทำไมแยกไฟล์จาก db/store.js: V2 มีวงจรชีวิตของตัวเองครบชุด (session → chunk →
//    claim → commit → recovery) การยัดลงไฟล์ 1,600 บรรทัดที่ปนกับ files/shares/audit
//    ทำให้ "อ่านแล้วเห็นว่าไม่มีทางรั่ว" ทำไม่ได้อีกต่อไป ซึ่งเป็นคุณสมบัติที่แพงที่สุด
//    ของโค้ดที่ถือ ciphertext ของผู้ใช้
//
// ⚠️ โหมด in-memory fallback มีอยู่เพื่อให้ชุดทดสอบเดียวกัน "รันได้ทั้งสองโหมด" —
//    รูปร่างของแถวและความหมายของทุกสถานะต้องเหมือนกันเป๊ะกับโหมด Postgres
import { query, usingPostgres, withTransaction, withAdvisoryLock } from './connection.js'

// ── การตรวจรูปแบบ (รูปแบบเท่านั้น — เซิร์ฟเวอร์ตรวจเนื้อในไม่ได้และไม่ควรได้) ──────
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const isB64 = (s, maxLen = 4096) =>
  typeof s === 'string' && s.length > 0 && s.length <= maxLen && B64_RE.test(s)

/** contentId = 16 ไบต์สุ่ม → base64 24 ตัวอักษรเสมอ (ลงท้าย '==') */
export const isValidContentIdB64 = (s) => typeof s === 'string' && s.length === 24 && B64_RE.test(s)

/** IV ของ AES-GCM = 12 ไบต์ → base64 16 ตัวอักษรเสมอ */
export const isValidIvB64 = (s) => typeof s === 'string' && s.length === 16 && B64_RE.test(s)

/**
 * envelope ของ V2 — เหมือน V1 ทุกช่องยกเว้น "ไม่มี ivB64 ระดับไฟล์"
 * ⚠️ การไม่มี ivB64 ไม่ใช่การละเว้น แต่เป็นสาระของรูปแบบ: V2 ไม่มี IV ของทั้งไฟล์
 *    เพราะไม่มีข้อความ GCM ของทั้งไฟล์ให้ผูก IV ด้วย — มี IV ต่อ chunk แทน
 */
export function validVaultV2Envelope(e) {
  return (
    isValidIvB64(e?.wrapIvB64) && isValidIvB64(e?.metaIvB64) &&
    isB64(e?.wrappedDekB64, 128) && isB64(e?.metaB64, 8192)
  )
}

// ── dev fallback ─────────────────────────────────────────────────────────────
const memSessions = new Map()      // uploadId → row
const memSessionChunks = new Map() // uploadId → Map<index, { state, writerToken, size, sha256, ivB64 }>
const memBlobs = []                // [{ id, userId, storageKey, ... }]
const memBlobChunks = new Map()    // blobId → Map<index, { size, sha256, ivB64 }>
const memChunkLocks = new Set()    // `${uploadId}:${index}` ที่กำลังถูกเขียนอยู่
const memRecoveryLocks = new Set()

const mapSessionRow = (r) => ({
  uploadId: r.upload_id,
  userId: String(r.user_id),
  formatVersion: Number(r.format_version),
  contentIdB64: r.content_id_b64,
  ciphertextSize: Number(r.ciphertext_size),
  chunkSize: Number(r.chunk_size),
  chunkCount: Number(r.chunk_count),
  wrappedDekB64: r.wrapped_dek_b64,
  wrapIvB64: r.wrap_iv_b64,
  metaIvB64: r.meta_iv_b64,
  metaB64: r.meta_b64,
  status: r.status,
  commitStartedAt: r.commit_started_at ? new Date(r.commit_started_at).getTime() : null,
  commitStorageKey: r.commit_storage_key ?? null,
  committedBlobId: r.committed_blob_id ?? null,
  createdAt: new Date(r.created_at).getTime(),
  updatedAt: new Date(r.updated_at).getTime(),
  expiresAt: new Date(r.expires_at).getTime(),
})

const mapBlobRow = (r) => ({
  id: r.id,
  formatVersion: Number(r.format_version),
  storageKey: r.storage_key,
  contentIdB64: r.content_id_b64,
  size: Number(r.ciphertext_size),
  chunkSize: Number(r.chunk_size),
  chunkCount: Number(r.chunk_count),
  wrappedDekB64: r.wrapped_dek_b64,
  wrapIvB64: r.wrap_iv_b64,
  metaIvB64: r.meta_iv_b64,
  metaB64: r.meta_b64,
  createdAt: new Date(r.created_at).getTime(),
})

const clone = (row) => ({ ...row })

// ── Upload sessions ──────────────────────────────────────────────────────────

/**
 * เปิด session ใหม่ — envelope ถูกบันทึกตั้งแต่ตรงนี้ ไม่ใช่ตอน commit
 * ⚠️ chunkSize/chunkCount/ciphertextSize เป็น "ค่าที่แช่แข็งแล้ว" หลังบรรทัดนี้ ไม่มี
 *    endpoint ใดแก้ได้อีก — ตำแหน่งเขียนของทุก chunk คำนวณจากค่าเหล่านี้ ถ้าแก้ได้
 *    ระหว่างทาง client จะเลือกตำแหน่งเขียนของตัวเองได้
 */
export async function createVaultV2Session({
  uploadId, userId, contentIdB64, ciphertextSize, chunkSize, chunkCount, envelope, expiresAt,
}) {
  if (userId == null) throw new Error('createVaultV2Session requires a userId')
  const { wrappedDekB64, wrapIvB64, metaIvB64, metaB64 } = envelope
  if (usingPostgres) {
    const { rows } = await query(
      `INSERT INTO vault_v2_upload_sessions
         (upload_id, user_id, content_id_b64, ciphertext_size, chunk_size, chunk_count,
          wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_timestamp($11 / 1000.0)) RETURNING *`,
      [uploadId, userId, contentIdB64, ciphertextSize, chunkSize, chunkCount,
        wrappedDekB64, wrapIvB64, metaIvB64, metaB64, expiresAt],
    )
    return mapSessionRow(rows[0])
  }
  const now = Date.now()
  const row = {
    uploadId, userId: String(userId), formatVersion: 2, contentIdB64,
    ciphertextSize: Number(ciphertextSize), chunkSize: Number(chunkSize), chunkCount: Number(chunkCount),
    wrappedDekB64, wrapIvB64, metaIvB64, metaB64,
    status: 'open', commitStartedAt: null, commitStorageKey: null, committedBlobId: null,
    createdAt: now, updatedAt: now, expiresAt: Number(expiresAt),
  }
  memSessions.set(uploadId, row)
  memSessionChunks.set(uploadId, new Map())
  return clone(row)
}

/** session ของ "ผู้ใช้คนนี้เท่านั้น" — ด่าน ownership อยู่ที่นี่จุดเดียว ไม่มีข้อยกเว้นให้ Admin */
export async function findVaultV2Session(uploadId, userId) {
  if (userId == null) throw new Error('findVaultV2Session requires a userId — do not call it unscoped')
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM vault_v2_upload_sessions WHERE upload_id = $1 AND user_id = $2`,
      [uploadId, userId],
    )
    return rows.length ? mapSessionRow(rows[0]) : null
  }
  const row = memSessions.get(uploadId)
  if (!row || row.userId !== String(userId)) return null
  return clone(row)
}

/** chunk ทุกก้อนของ session นี้พร้อมสถานะ — ผู้เรียกกรอง state === 'received' เอง */
export async function listVaultV2SessionChunks(uploadId) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT chunk_index, state, ciphertext_size, ciphertext_sha256, iv_b64
         FROM vault_v2_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index ASC`,
      [uploadId],
    )
    return rows.map((r) => ({
      index: Number(r.chunk_index),
      state: r.state,
      size: r.ciphertext_size == null ? null : Number(r.ciphertext_size),
      sha256: r.ciphertext_sha256 ?? null,
      ivB64: r.iv_b64 ?? null,
    }))
  }
  const chunks = memSessionChunks.get(uploadId)
  if (!chunks) return []
  return [...chunks.entries()]
    .map(([index, v]) => ({ index, state: v.state, size: v.size, sha256: v.sha256, ivB64: v.ivB64 }))
    .sort((a, b) => a.index - b.index)
}

/**
 * ล็อกช่องของ chunk นี้ตลอดการเขียน — ครึ่งแรกของกติกาความสอดคล้อง
 *
 * ⚠️ ล็อกนี้ทำงาน "ข้ามโปรเซส" (advisory lock ของ PostgreSQL) ไม่ใช่ Map ใน heap
 *    เพราะ production อาจรันมากกว่าหนึ่งโปรเซส และ Map จะไม่กันอะไรเลยในกรณีนั้น
 * ⚠️ ได้ล็อกไม่ทัน = 409 ให้ client ลองใหม่ ไม่ใช่รอคิว — คำขอที่รอ lock อยู่เฉย ๆ
 *    ถือ socket และ connection ไว้โดยไม่มีกำหนด
 * @returns {Promise<{ acquired: boolean, value?: any }>}
 */
export async function withVaultV2ChunkWriteLock(uploadId, index, fn) {
  if (usingPostgres) {
    // key1 = แฮช 32 บิตของ uploadId, key2 = ดัชนี chunk
    let h = 0x811c9dc5
    for (let i = 0; i < uploadId.length; i += 1) {
      h ^= uploadId.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return withAdvisoryLock(h | 0, index | 0, fn)
  }
  const key = `${uploadId}:${index}`
  if (memChunkLocks.has(key)) return { acquired: false }
  memChunkLocks.add(key)
  try {
    return { acquired: true, value: await fn() }
  } finally {
    memChunkLocks.delete(key)
  }
}

/**
 * จองช่องของ chunk ก่อนเขียนไบต์ — ตั้ง state='writing' พร้อม token ของผู้เขียนคนนี้
 *
 * ⚠️ การจองทำให้ช่องนี้ "ไม่นับว่ารับแล้ว" ทันที ซึ่งถูกต้องแม้ในกรณีที่โปรเซสตายกลาง
 *    การเขียน: ไบต์บนดิสก์ครึ่ง ๆ กลาง ๆ จะไม่มีวันถูกนับเป็น chunk ที่สมบูรณ์ commit
 *    จึงถูกบล็อกจนกว่าจะมีใครส่งก้อนนี้ใหม่ทั้งก้อน
 * ⚠️ ค่าเดิม (size/sha/iv) ถูกล้างทิ้งด้วย ไม่ใช่ปล่อยค้าง — ค่าเก่าที่ยังอยู่คู่กับไบต์
 *    ที่กำลังจะถูกเขียนทับคือคำโกหกที่รอเวลา
 * @returns {Promise<string>} writerToken
 */
export async function beginVaultV2ChunkWrite(uploadId, index, writerToken) {
  if (usingPostgres) {
    await query(
      `INSERT INTO vault_v2_upload_chunks (upload_id, chunk_index, state, writer_token)
       VALUES ($1, $2, 'writing', $3)
       ON CONFLICT (upload_id, chunk_index) DO UPDATE
         SET state = 'writing', writer_token = EXCLUDED.writer_token,
             ciphertext_size = NULL, ciphertext_sha256 = NULL, iv_b64 = NULL, updated_at = now()`,
      [uploadId, index, writerToken],
    )
    return writerToken
  }
  const chunks = memSessionChunks.get(uploadId)
  if (!chunks) throw new Error('unknown vault upload session')
  chunks.set(Number(index), { state: 'writing', writerToken, size: null, sha256: null, ivB64: null })
  return writerToken
}

/**
 * ปิดงานเขียน chunk — บันทึกขนาด/แฮช/IV ก็ต่อเมื่อ "ผู้เขียนคนนี้ยังเป็นเจ้าของช่อง"
 *
 * ⚠️ เงื่อนไข writer_token = $ คือครึ่งหลังของกติกา: ผู้เขียนที่ถูกแซงไปแล้วจะได้
 *    rowCount = 0 และ metadata ของมันถูกทิ้ง ไม่ถูกนำไปแปะกับไบต์ของผู้เขียนคนหลัง
 *    (สถานการณ์ "ไบต์จากคำขอ A + metadata จากคำขอ B" จึงเป็นไปไม่ได้)
 * @returns {Promise<boolean>} false = ถูกแซงแล้ว ผู้เรียกต้องตอบ 409
 */
export async function finishVaultV2ChunkWrite(uploadId, index, { writerToken, size, sha256, ivB64 }) {
  if (usingPostgres) {
    const { rowCount } = await query(
      `UPDATE vault_v2_upload_chunks
          SET state = 'received', ciphertext_size = $4, ciphertext_sha256 = $5,
              iv_b64 = $6, updated_at = now()
        WHERE upload_id = $1 AND chunk_index = $2 AND writer_token = $3`,
      [uploadId, index, writerToken, size, sha256, ivB64],
    )
    if (rowCount > 0) {
      await query('UPDATE vault_v2_upload_sessions SET updated_at = now() WHERE upload_id = $1', [uploadId])
    }
    return rowCount > 0
  }
  const chunks = memSessionChunks.get(uploadId)
  const slot = chunks?.get(Number(index))
  if (!slot || slot.writerToken !== writerToken) return false
  slot.state = 'received'
  slot.size = Number(size)
  slot.sha256 = sha256
  slot.ivB64 = ivB64
  const row = memSessions.get(uploadId)
  if (row) row.updatedAt = Date.now()
  return true
}

/**
 * จอง session เพื่อ commit — open → committing แบบมีเงื่อนไขในคำสั่งเดียว
 * เหตุผลเต็มเหมือน claimUploadSessionForCommit() ของ Normal Files: การอ่านมาเช็คใน JS
 * แล้วค่อยเขียนมีช่องให้คำขออีกใบอ่านค่าเดียวกัน (read-modify-write race)
 * ⚠️ storageKey ถูกบันทึก "ในคำสั่งเดียวกับการจอง" คือก่อนไบต์จะถูก rename ไปไหนทั้งสิ้น
 */
export async function claimVaultV2SessionForCommit(uploadId, userId, storageKey) {
  if (userId == null) throw new Error('claimVaultV2SessionForCommit requires a userId')
  if (!storageKey) throw new Error('claimVaultV2SessionForCommit requires the final storage key')
  if (usingPostgres) {
    const { rows } = await query(
      `UPDATE vault_v2_upload_sessions
          SET status = 'committing', commit_started_at = now(), commit_storage_key = $3,
              committed_blob_id = NULL, updated_at = now()
        WHERE upload_id = $1 AND user_id = $2 AND status = 'open'
        RETURNING *`,
      [uploadId, userId, storageKey],
    )
    return rows.length ? mapSessionRow(rows[0]) : null
  }
  const row = memSessions.get(uploadId)
  if (!row || row.userId !== String(userId) || row.status !== 'open') return null
  row.status = 'committing'
  row.commitStartedAt = Date.now()
  row.commitStorageKey = storageKey
  row.committedBlobId = null
  row.updatedAt = Date.now()
  return clone(row)
}

/** ปลดการจอง committing กลับเป็น open พร้อมล้าง commit intent */
export async function releaseVaultV2SessionClaim(uploadId, userId) {
  if (userId == null) throw new Error('releaseVaultV2SessionClaim requires a userId')
  if (usingPostgres) {
    const { rowCount } = await query(
      `UPDATE vault_v2_upload_sessions
          SET status = 'open', commit_started_at = NULL, commit_storage_key = NULL,
              committed_blob_id = NULL, updated_at = now()
        WHERE upload_id = $1 AND user_id = $2 AND status = 'committing'`,
      [uploadId, userId],
    )
    return rowCount > 0
  }
  const row = memSessions.get(uploadId)
  if (!row || row.userId !== String(userId) || row.status !== 'committing') return false
  row.status = 'open'
  row.commitStartedAt = null
  row.commitStorageKey = null
  row.committedBlobId = null
  row.updatedAt = Date.now()
  return true
}

/** เปลี่ยนสถานะปลายทางของ session (committed/aborted) */
export async function setVaultV2SessionStatus(uploadId, userId, status) {
  if (userId == null) throw new Error('setVaultV2SessionStatus requires a userId')
  if (usingPostgres) {
    const { rowCount } = await query(
      `UPDATE vault_v2_upload_sessions SET status = $3, updated_at = now()
        WHERE upload_id = $1 AND user_id = $2`,
      [uploadId, userId, status],
    )
    return rowCount > 0
  }
  const row = memSessions.get(uploadId)
  if (!row || row.userId !== String(userId)) return false
  row.status = status
  row.updatedAt = Date.now()
  return true
}

/** ลบแถว session + chunk ของมัน (CASCADE ในโหมด Postgres) */
export async function deleteVaultV2Session(uploadId, userId) {
  if (userId == null) throw new Error('deleteVaultV2Session requires a userId')
  if (usingPostgres) {
    const { rowCount } = await query(
      `DELETE FROM vault_v2_upload_sessions WHERE upload_id = $1 AND user_id = $2`, [uploadId, userId],
    )
    return rowCount > 0
  }
  const row = memSessions.get(uploadId)
  if (!row || row.userId !== String(userId)) return false
  memSessions.delete(uploadId)
  memSessionChunks.delete(uploadId)
  return true
}

/**
 * จบ commit ใน **transaction เดียว**: แถว blob + แถว chunk ทุกก้อน + committed_blob_id
 * + status='committed' เขียนพร้อมกันทั้งหมด
 *
 * ⚠️ เหตุผลเดียวกับ finishUploadCommit() ของ Normal Files และสำคัญกว่าเดิมที่นี่:
 *    ถ้าแถว blob ถูกเขียนแยกจากแถว chunk จะมีช่วงเวลาที่ blob ปรากฏใน inventory โดย
 *    ยังไม่มี IV ของ chunk ใดเลย = ผู้ใช้เห็นไฟล์ที่ "มีอยู่" แต่ถอดไม่ได้เลยแม้แต่ก้อนเดียว
 * ⚠️ แถวที่ยัง committing จึงแปลว่า metadata ยังไม่ถูกเขียนแน่นอน — งานกู้คืนไม่ต้องเดา
 */
export async function finishVaultV2Commit({
  uploadId, userId, blobId, storageKey, ciphertextSize, chunkSize, chunkCount,
  contentIdB64, envelope, chunks,
}) {
  const { wrappedDekB64, wrapIvB64, metaIvB64, metaB64 } = envelope
  if (usingPostgres) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO vault_v2_blobs
           (id, user_id, storage_key, content_id_b64, ciphertext_size, chunk_size, chunk_count,
            wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [blobId, userId, storageKey, contentIdB64, ciphertextSize, chunkSize, chunkCount,
          wrappedDekB64, wrapIvB64, metaIvB64, metaB64],
      )
      for (const c of chunks) {
        await client.query(
          `INSERT INTO vault_v2_blob_chunks (blob_id, chunk_index, ciphertext_size, ciphertext_sha256, iv_b64)
           VALUES ($1,$2,$3,$4,$5)`,
          [blobId, c.index, c.size, c.sha256, c.ivB64],
        )
      }
      await client.query(
        `UPDATE vault_v2_upload_sessions
            SET status = 'committed', committed_blob_id = $2, updated_at = now()
          WHERE upload_id = $1`,
        [uploadId, blobId],
      )
      return mapBlobRow(rows[0])
    })
  }

  const now = Date.now()
  const row = {
    id: blobId, userId: String(userId), formatVersion: 2, storageKey, contentIdB64,
    size: Number(ciphertextSize), chunkSize: Number(chunkSize), chunkCount: Number(chunkCount),
    wrappedDekB64, wrapIvB64, metaIvB64, metaB64, createdAt: now,
  }
  memBlobs.push(row)
  memBlobChunks.set(blobId, new Map(chunks.map((c) => [c.index, { size: c.size, sha256: c.sha256, ivB64: c.ivB64 }])))
  const session = memSessions.get(uploadId)
  if (session) {
    session.status = 'committed'
    session.committedBlobId = blobId
    session.updatedAt = now
  }
  return clone(row)
}

// ── Published blobs ──────────────────────────────────────────────────────────

/** blob V2 ทั้งหมดของผู้ใช้คนนี้ — ไม่คืน storageKey ออกนอกชั้นนี้โดยผู้เรียกที่เป็น route */
export async function listVaultV2Blobs(userId) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM vault_v2_blobs WHERE user_id = $1 ORDER BY created_at DESC`, [userId],
    )
    return rows.map(mapBlobRow)
  }
  return memBlobs
    .filter((b) => b.userId === String(userId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(clone)
}

/** blob ชิ้นเดียว — null ถ้าไม่ใช่ของ userId นี้ (ผู้เรียกแปลเป็น 404 ทั้งสองกรณี) */
export async function findVaultV2Blob(userId, id) {
  if (userId == null) throw new Error('findVaultV2Blob requires a userId')
  if (typeof id !== 'string' || !/^[0-9a-f]{48}$/.test(id)) return null
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM vault_v2_blobs WHERE id = $1 AND user_id = $2`, [id, userId],
    )
    return rows.length ? mapBlobRow(rows[0]) : null
  }
  const row = memBlobs.find((b) => b.id === id && b.userId === String(userId))
  return row ? clone(row) : null
}

/** blob ตาม storage key โดยไม่ผูก user — **เฉพาะงานกู้คืนของระบบ** ที่ไม่มี request ผูกอยู่ */
export async function findVaultV2BlobByStorageKey(storageKey) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM vault_v2_blobs WHERE storage_key = $1 LIMIT 1`, [storageKey])
    return rows.length ? mapBlobRow(rows[0]) : null
  }
  const row = memBlobs.find((b) => b.storageKey === storageKey)
  return row ? clone(row) : null
}

/** ข้อมูลของ chunk หนึ่งก้อนใน blob ที่เผยแพร่แล้ว — IV มาจากที่นี่ ไม่ใช่จาก client */
export async function findVaultV2BlobChunk(blobId, index) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT chunk_index, ciphertext_size, ciphertext_sha256, iv_b64
         FROM vault_v2_blob_chunks WHERE blob_id = $1 AND chunk_index = $2`,
      [blobId, index],
    )
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      index: Number(r.chunk_index), size: Number(r.ciphertext_size),
      sha256: r.ciphertext_sha256, ivB64: r.iv_b64,
    }
  }
  const slot = memBlobChunks.get(blobId)?.get(Number(index))
  return slot ? { index: Number(index), ...slot } : null
}

/** chunk ทั้งหมดของ blob — ใช้ตอนตรวจ DB↔disk parity และในชุดทดสอบ */
export async function listVaultV2BlobChunks(blobId) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT chunk_index, ciphertext_size, ciphertext_sha256, iv_b64
         FROM vault_v2_blob_chunks WHERE blob_id = $1 ORDER BY chunk_index ASC`,
      [blobId],
    )
    return rows.map((r) => ({
      index: Number(r.chunk_index), size: Number(r.ciphertext_size),
      sha256: r.ciphertext_sha256, ivB64: r.iv_b64,
    }))
  }
  const chunks = memBlobChunks.get(blobId)
  if (!chunks) return []
  return [...chunks.entries()].map(([index, v]) => ({ index, ...v })).sort((a, b) => a.index - b.index)
}

/**
 * ลบแถว blob (chunk ตามไปด้วยผ่าน CASCADE) — ผู้เรียกลบไบต์บนดิสก์เองต่อ
 * ⚠️ ผูกกับ userId เสมอ: การลบของคนอื่นต้องไม่เกิดขึ้นแม้ผู้เรียกจะส่ง id มาถูก
 */
export async function deleteVaultV2Blob(userId, id) {
  if (userId == null) throw new Error('deleteVaultV2Blob requires a userId')
  if (usingPostgres) {
    const { rowCount } = await query(
      `DELETE FROM vault_v2_blobs WHERE id = $1 AND user_id = $2`, [id, userId],
    )
    return rowCount > 0
  }
  const i = memBlobs.findIndex((b) => b.id === id && b.userId === String(userId))
  if (i === -1) return false
  memBlobs.splice(i, 1)
  memBlobChunks.delete(id)
  return true
}

// ── งานเก็บกวาด / งานกู้คืน ──────────────────────────────────────────────────

// allow-list เดียวกับ Normal Files — 'committing' ไม่อยู่ในนี้โดยเจตนา
const CLEANABLE_STATUSES = new Set(['open', 'aborted'])

export async function listExpiredVaultV2Sessions(now = Date.now()) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM vault_v2_upload_sessions
        WHERE status IN ('open', 'aborted') AND expires_at < to_timestamp($1 / 1000.0)`,
      [now],
    )
    return rows.map(mapSessionRow)
  }
  return [...memSessions.values()]
    .filter((r) => CLEANABLE_STATUSES.has(r.status) && r.expiresAt < now)
    .map(clone)
}

export async function listAllVaultV2SessionIds() {
  if (usingPostgres) {
    const { rows } = await query(`SELECT upload_id FROM vault_v2_upload_sessions`)
    return rows.map((r) => r.upload_id)
  }
  return [...memSessions.keys()]
}

/** ลบแถว session โดยไม่ผูก user — เฉพาะงานเก็บกวาด; allow-list อยู่ใน SQL เอง */
export async function deleteVaultV2SessionUnscoped(uploadId) {
  if (usingPostgres) {
    const { rowCount } = await query(
      `DELETE FROM vault_v2_upload_sessions WHERE upload_id = $1 AND status IN ('open', 'aborted')`,
      [uploadId],
    )
    return rowCount > 0
  }
  const row = memSessions.get(uploadId)
  if (!row || !CLEANABLE_STATUSES.has(row.status)) return false
  memSessions.delete(uploadId)
  memSessionChunks.delete(uploadId)
  return true
}

/**
 * จอง session ที่ค้าง committing เกินสัญญาเช่า เพื่อกู้คืน — ครั้งละหนึ่งแถว
 * ⚠️ FOR UPDATE SKIP LOCKED ไม่ใช่สถานะ 'recovering': ถ้าตัวงานกู้คืนตายกลางคัน
 *    ล็อกหลุดไปกับ connection แล้วรอบถัดไปหยิบต่อได้เอง ส่วนสถานะกลางอันใหม่จะสร้าง
 *    ปัญหา "แถวค้างที่ไม่มีใครกู้" ซ้ำอีกชั้น ซึ่งเป็นบั๊กที่ LFT-V2-A เพิ่งแก้ไป
 */
export async function withStaleVaultV2CommitLease(leaseMs, fn) {
  if (usingPostgres) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM vault_v2_upload_sessions
           WHERE status = 'committing'
             AND commit_started_at IS NOT NULL
             AND commit_started_at < now() - ($1::bigint * interval '1 millisecond')
           ORDER BY commit_started_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
        [Math.trunc(leaseMs)],
      )
      if (rows.length === 0) return null
      const session = mapSessionRow(rows[0])
      return fn(session, {
        markCommitted: (blobId) => client.query(
          `UPDATE vault_v2_upload_sessions
              SET status = 'committed', committed_blob_id = $2, updated_at = now()
            WHERE upload_id = $1`,
          [session.uploadId, blobId],
        ),
        reopen: () => client.query(
          `UPDATE vault_v2_upload_sessions
              SET status = 'open', commit_started_at = NULL, commit_storage_key = NULL,
                  committed_blob_id = NULL, updated_at = now()
            WHERE upload_id = $1`,
          [session.uploadId],
        ),
        abort: () => client.query(
          `UPDATE vault_v2_upload_sessions
              SET status = 'aborted', commit_started_at = NULL, updated_at = now()
            WHERE upload_id = $1`,
          [session.uploadId],
        ),
        findBlobByStorageKey: async (key) => {
          const res = await client.query('SELECT * FROM vault_v2_blobs WHERE storage_key = $1 LIMIT 1', [key])
          return res.rows[0] ? mapBlobRow(res.rows[0]) : null
        },
      })
    })
  }

  const now = Date.now()
  const session = [...memSessions.values()].find(
    (r) => r.status === 'committing' && r.commitStartedAt != null && r.commitStartedAt < now - leaseMs,
  )
  if (!session) return null
  if (memRecoveryLocks.has(session.uploadId)) return null
  memRecoveryLocks.add(session.uploadId)
  try {
    return await fn(clone(session), {
      markCommitted: async (blobId) => {
        session.status = 'committed'
        session.committedBlobId = blobId == null ? null : String(blobId)
        session.updatedAt = Date.now()
      },
      reopen: async () => {
        session.status = 'open'
        session.commitStartedAt = null
        session.commitStorageKey = null
        session.committedBlobId = null
        session.updatedAt = Date.now()
      },
      abort: async () => {
        session.status = 'aborted'
        session.commitStartedAt = null
        session.updatedAt = Date.now()
      },
      findBlobByStorageKey: async (key) => {
        const row = memBlobs.find((b) => b.storageKey === key)
        return row ? clone(row) : null
      },
    })
  } finally {
    memRecoveryLocks.delete(session.uploadId)
  }
}

/**
 * ล้าง state ของ Vault V2 ทั้งหมด — ชุดทดสอบเท่านั้น
 * ⚠️ DELETE ไม่ใช่ TRUNCATE โดยเจตนา: drive_app มีแค่ DML การใช้ DELETE ทำให้ชุดทดสอบ
 *    ทำงานภายใต้สิทธิ์ "เท่ากับแอปจริง" เป๊ะ ถ้าวันหนึ่งบรรทัดนี้ต้องการมากกว่านั้น
 *    แปลว่าเทสต์กำลังโกง
 */
export async function __resetVaultV2ForTests() {
  if (usingPostgres) {
    await query('DELETE FROM vault_v2_upload_chunks')
    await query('DELETE FROM vault_v2_upload_sessions')
    await query('DELETE FROM vault_v2_blob_chunks')
    await query('DELETE FROM vault_v2_blobs')
    return
  }
  memSessions.clear()
  memSessionChunks.clear()
  memBlobs.length = 0
  memBlobChunks.clear()
  memChunkLocks.clear()
  memRecoveryLocks.clear()
}
