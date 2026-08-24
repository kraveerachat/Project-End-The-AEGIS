// server/db/store.js — AEGIS Drive (IDEA1) · แหล่งข้อมูลของ Application Layer
//
// ⚠️ Mock data ถูก "ถอนออกจาก client bundle ทั้งหมด" — จอทุกจอเรียก API จริง
//    สถานะของแต่ละหมวดในไฟล์นี้ (อัปเดตให้ตรงกับโค้ด ไม่ใช่ตรงกับแผน):
//    - files / shares / vault : อ่าน-เขียนตารางจริงเมื่อ usingPostgres, มี dev fallback
//      ในหน่วยความจำที่รูปร่างเหมือนแถวจริงทุกประการ (ไม่มี DATABASE_URL)
//    - users                  : ไม่อยู่ในไฟล์นี้แล้ว — ดู listUsers ใน connection.js
//    - audit                  : อยู่ใน connection.js (recordAudit / readAudit)
//
//    - file_versions          : ตารางจริง + ไบต์จริงใต้ versions/ (กู้คืนได้จริง)
//    - network_zones          : ช่วง CIDR จริงที่ snapshot ลง restricted shares ตอนสร้าง
//    - storage capacity       : statfs ของ mount จริง (ดู filesystemCapacity)
//    - dashboard activity     : นับจาก audit_log จริง
//
// ⚠️ สิ่งที่ deployment นี้ "วัดไม่ได้" ถูกประกาศผ่าน storageStatus().unavailable
//    (สุขภาพดิสก์/SMART, RAID, งานสำรองข้อมูล) — ตรวจแล้วว่าต้องมีสิทธิ์ระดับโฮสต์
//    ที่ไม่ได้ให้ไว้ ไม่ใช่งานที่เขียนโค้ดเพิ่มแล้วได้ ดูเหตุผลเต็มที่หัวหมวด Storage
//
// ⚠️ หมวดที่ถูก "ถอนออกทั้งฟีเจอร์" เพราะมันโฆษณาสิ่งที่ไม่มีอยู่: snapshots + rollback
//    (ดูหัวหมวด File versions) และ encryption keys + rotate (ดูหัวหมวด Network zones)
//    ส่วน sessions ย้ายไปอ่าน session store จริงที่ auth/session.js
//
// ⚠️ เดิมหัวไฟล์นี้เขียนว่า users "ต่อท่อครบ" ทั้งที่ listUsers() คืนอาเรย์ hard-code
//    โดยไม่เช็ค usingPostgres เลย — คอมเมนต์ที่โฆษณาเกินของจริงอันตรายกว่าไม่มีคอมเมนต์
//    เพราะคนอ่านครั้งต่อไปจะข้ามการตรวจจุดนั้นไปเลย
//    ⚠️ กติกาของไฟล์นี้: แก้โค้ดแล้วสถานะของหมวดใดเปลี่ยน ต้องแก้รายการด้านบนใน
//    คอมมิตเดียวกัน — รอบนี้พลาดข้อนี้เอง (รายการยังระบุ transfer7d/sessions/snapshots
//    ว่า "ยังไม่จริง" อยู่หลายคอมมิตหลังจากทั้งสามอย่างถูกเปลี่ยนไปแล้ว)
//
// ⚠️ ทุกฟังก์ชันในไฟล์นี้ถูกเรียก "หลัง" requireAuth/requireRole เสมอ — ห้าม route ใด
//    เรียกตรงโดยไม่ผ่าน middleware ตรวจสิทธิ์ (ดู routes/api.js)
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { sha256Hex, usingPostgres, query, readAudit } from './connection.js'
// ความจุจริงของ mount ที่ Data Lake อยู่ — statfs ของ OS ไม่ใช่ค่าคงที่ในโค้ด
import { filesystemCapacity } from '../storage/fileStore.js'

const BOOT = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

let idSeq = 100
const nextId = (p) => `${p}${idSeq++}`

// ── ext → display type (server-derived; `files` has no `type` column —
//    the metadata layer stores name/mime, the label is computed on read) ──
const EXT_TYPE = {
  xlsx: 'Spreadsheet', xls: 'Spreadsheet', csv: 'Spreadsheet',
  pdf: 'PDF',
  zip: 'Archive', 'tar.gz': 'Archive', gz: 'Archive', rar: 'Archive', '7z': 'Archive',
  mp4: 'Video', mov: 'Video', mkv: 'Video',
  pptx: 'Presentation', ppt: 'Presentation',
  docx: 'Document', doc: 'Document', txt: 'Document',
  log: 'Log',
  png: 'Image', jpg: 'Image', jpeg: 'Image', webp: 'Image',
}
function typeExtFromName(name) {
  const lower = String(name).toLowerCase()
  const ext = lower.endsWith('.tar.gz') ? 'tar.gz' : (lower.includes('.') ? lower.split('.').pop() : '')
  return { ext, type: ext ? (EXT_TYPE[ext] ?? 'File') : 'Folder' }
}

/** แถวจากตาราง files (+ JOIN users) → รูปทรงที่ Files.jsx คาดหวัง
 *
 * ⚠️ `ownerId` เป็น "ตัวตนเชิงสิทธิ์" ของไฟล์ ไม่ใช่แค่ป้ายชื่อ — ใช้โดยด่าน
 *    ownership ของ DELETE /api/files/:id (ดู routes/api.js) ห้ามเอา `uploader`
 *    (display name) ไปเทียบสิทธิ์แทน: ชื่อซ้ำกันได้ และเปลี่ยนได้ทีหลัง
 *    เป็น string เสมอเพื่อให้เทียบกับ req.user.id ได้แบบเดียวกันทั้งสองโหมด DB
 *    NULL ได้จริง (`uploaded_by … ON DELETE SET NULL` — เจ้าของถูกลบบัญชีไปแล้ว)
 */
function mapFileRow(r) {
  const { ext, type } = typeExtFromName(r.name)
  return {
    id: String(r.id), name: r.name, type, ext, size: Number(r.size_bytes),
    modified: new Date(r.modified_at).getTime(), uploader: r.uploader_name ?? 'system',
    ownerId: r.uploaded_by == null ? null : String(r.uploaded_by),
    vault: r.vault, verified: r.verified, sha256: r.sha256, path: r.path,
  }
}

// ── Postgres-backed Files (Metadata Layer) ──────────────────────────────
//
// ⚠️ Files คือ "namespace ต่อผู้ใช้" สำหรับการดำเนินการปกติ (list/upload/verify/
//    download/delete/version) — Admin ไม่ได้มีสิทธิ์เห็นไฟล์ของผู้อื่นเพิ่มเติมจาก
//    DataLake-User (ดู rbac/permissions.js: สอง role จัดการไฟล์ "เท่ากัน" ไม่ใช่
//    Admin เหนือกว่า) จึงกรองด้วย uploaded_by = $1 ในชั้น SQL โดยตรง ไม่ใช่กรองที่
//    route หรือฝั่ง client — พลาดจุดใดจุดหนึ่งในสองที่หลังคือ IDOR ทันที
async function pgListFiles(userId) {
  const { rows } = await query(
    `SELECT f.*, COALESCE(NULLIF(btrim(u.profile_name), ''), u.display_name) AS uploader_name
       FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.vault = false AND f.uploaded_by = $1
      ORDER BY f.modified_at DESC`,
    [userId],
  )
  return rows.map(mapFileRow)
}

async function pgFindFile(id) {
  if (!/^\d+$/.test(String(id))) return null // id ไม่ใช่ BIGSERIAL ที่ถูกต้อง — ไม่มีทางเจอ ไม่ใช่ error
  const { rows } = await query(
    `SELECT f.*, COALESCE(NULLIF(btrim(u.profile_name), ''), u.display_name) AS uploader_name
       FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.id = $1`,
    [id],
  )
  return rows.length ? mapFileRow(rows[0]) : null
}

async function pgDeleteFile(id) {
  if (!/^\d+$/.test(String(id))) return false
  const { rowCount } = await query(`DELETE FROM files WHERE id = $1`, [id])
  return rowCount > 0
}

async function pgCreateFolder(name, user) {
  const safe = String(name).slice(0, 120)
  const { rows } = await query(
    `INSERT INTO files (name, path, size_bytes, vault, verified, uploaded_by)
     VALUES ($1, $2, 0, false, true, $3) RETURNING *`,
    [safe, `/datalake/${safe}`, user.id],
  )
  return mapFileRow({ ...rows[0], uploader_name: user.displayName })
}

// ⚠️ storageKey คือตำแหน่ง "ไฟล์จริง" ใน Storage Layer (relative ต่อ STORAGE_ROOT)
//    ที่ fileStore.js เพิ่งเขียน bytes ลงไปแล้ว — ไม่ใช่ path สมมุติที่ประกอบจากชื่อไฟล์
//    size/sha256 ก็มาจากไฟล์บนดิสก์จริง (server คำนวณเอง) ไม่ใช่ค่าที่ client แจ้งมา
async function pgRecordUpload({ name, storageKey, size, sha256, user }) {
  const safeName = String(name).slice(0, 200)
  const { rows } = await query(
    `INSERT INTO files (name, path, size_bytes, sha256, vault, verified, uploaded_by)
     VALUES ($1, $2, $3, $4, false, true, $5) RETURNING *`,
    [safeName, storageKey, Number(size) || 0, sha256 ?? null, user.id],
  )
  return mapFileRow({ ...rows[0], uploader_name: user.displayName })
}

// ── Files (Metadata Layer) ────────────────────────────────────────────
const files = [
  { id: 'f01', name: 'Q2-2026_Financial-Report_FINAL.xlsx', type: 'Spreadsheet', ext: 'xlsx', size: 4_812_339, modified: BOOT - 22 * MIN, uploader: 'Kanya Srisuwan', vault: false, verified: true,
    sha256: '7f3a9c41d28e5b06f19a84c7e352d0b8a6f47e91c03d5a28b74f6e19d8c235a0', path: '/datalake/finance/2026/Q2/Q2-2026_Financial-Report_FINAL.xlsx' },
  { id: 'f02', name: 'network-topology_edge-site-A.pdf', type: 'PDF', ext: 'pdf', size: 2_144_776, modified: BOOT - 3 * HOUR, uploader: 'Veerachat J.', vault: false, verified: true,
    sha256: 'b2e8d174c6a95f30e8b1d42a7c9f0e56d3a81b47f25c90ed61837a4b5d2c8f19', path: '/datalake/infra/diagrams/network-topology_edge-site-A.pdf' },
  { id: 'f03', name: 'customer-contracts_2026-H1.zip', type: 'Archive', ext: 'zip', size: 148_566_016, modified: BOOT - 5 * HOUR, uploader: 'Somchai P.', vault: false, verified: false,
    sha256: '3c91f5e2a8d04b76c1e9f3a25d80b47e6f19c8d2a35b70e4d61f28a9c5b3e708', path: '/datalake/legal/contracts/customer-contracts_2026-H1.zip' },
  { id: 'f05', name: 'factory-cam_incident_2026-07-08.mp4', type: 'Video', ext: 'mp4', size: 512_729_088, modified: BOOT - DAY, uploader: 'Veerachat J.', vault: false, verified: true,
    sha256: 'a8c47e19d2b5f036e8a1c94d7f2b50e3d6a97b18c42f5e09d3b8a61f7c2e94d0', path: '/datalake/security/incidents/factory-cam_incident_2026-07-08.mp4' },
  { id: 'f06', name: 'ERP-migration-plan_phase2.pptx', type: 'Presentation', ext: 'pptx', size: 18_743_921, modified: BOOT - DAY - 4 * HOUR, uploader: 'Nattaporn W.', vault: false, verified: true,
    sha256: 'f1b83d60e2a74c95d8f2b01e5a3c96d47e08b2a5f19d6c38e74a0b5d2c9f16e3', path: '/datalake/projects/erp-migration/ERP-migration-plan_phase2.pptx' },
  { id: 'f08', name: 'supplier-audit_checklist_th.xlsx', type: 'Spreadsheet', ext: 'xlsx', size: 674_201, modified: BOOT - 2 * DAY - 6 * HOUR, uploader: 'Kanya Srisuwan', vault: false, verified: true,
    sha256: 'd4a92c58e7f13b06d9e2a45c8b7f60e1d3c95a84b26f7e01d5c8a39b4e2f761c', path: '/datalake/procurement/audits/supplier-audit_checklist_th.xlsx' },
  { id: 'f09', name: 'product-photos_launch-set.tar.gz', type: 'Archive', ext: 'tar.gz', size: 891_289_600, modified: BOOT - 3 * DAY, uploader: 'Nattaporn W.', vault: false, verified: true,
    sha256: '68f2d4b91c3e07a5f8d6b20e4a9c157d3e86b04a2c5f91e7d38b6a04c9e2f518', path: '/datalake/marketing/assets/product-photos_launch-set.tar.gz' },
  { id: 'f11', name: 'hr-policy-handbook_2026_th-en.pdf', type: 'PDF', ext: 'pdf', size: 3_412_990, modified: BOOT - 5 * DAY, uploader: 'Somchai P.', vault: false, verified: true,
    sha256: '92b7e04d5c8a13f6e2d9b40a7c5f81e6d3a09c47b28f5e13d70a6b9c4e8f250d', path: '/datalake/hr/policies/hr-policy-handbook_2026_th-en.pdf' },
  { id: 'f12', name: 'backup-verify_2026-07-11.log', type: 'Log', ext: 'log', size: 148_211, modified: BOOT - 6 * DAY, uploader: 'system', vault: false, verified: true,
    sha256: '4e0d92a67c3b85f1e4d28a05c9b7f36e1d58a24c7b90f6e3d15c8a2b4f7e091d', path: '/datalake/system/logs/backup-verify_2026-07-11.log' },
]

// ⚠️ dev fallback เท่านั้น — ผูกแถวเดโม่เข้ากับ id ของ DEV_USERS ใน connection.js
//    ('Veerachat J.' = 1 admin, 'Kanya Srisuwan' = 2 user) เพื่อให้ด่าน ownership
//    ของ DELETE /api/files/:id ทำงาน "เหมือนกันทั้งสองโหมด DB" ไม่ใช่ผ่านเฉพาะ Postgres
//    ชื่ออื่น ('Somchai P.', 'Nattaporn W.', 'system') ไม่มีบัญชีจริงในโหมดนี้ → null
//    = ไม่มีเจ้าของที่ยืนยันได้ จึงลบไม่ได้ ซึ่งตรงกับกรณี `ON DELETE SET NULL` ของ
//    Postgres เป๊ะ ๆ (เจ้าของถูกลบบัญชี) — เป็นช่องว่างที่รู้อยู่ ไม่ใช่ความบังเอิญ
const DEV_OWNER_BY_NAME = { 'Veerachat J.': '1', 'Kanya Srisuwan': '2' }
for (const f of files) f.ownerId = DEV_OWNER_BY_NAME[f.uploader] ?? null

/**
 * ไฟล์ "ของผู้ใช้คนนี้เท่านั้น" ที่ไม่ใช่ vault — ด่าน ownership อยู่ที่นี่จุดเดียว
 * ⚠️ userId เป็นพารามิเตอร์บังคับโดยเจตนา (ไม่มีค่า default) — ผู้เรียกที่ลืมส่งมา
 *    ต้องเห็น error ทันทีตอน dev/test ไม่ใช่ได้ไฟล์ของทุกคนกลับไปเงียบ ๆ แบบเดิม
 *    (บั๊กที่ยืนยันแล้วใน production: GET /api/files คืนไฟล์ของผู้ใช้ทุกคนโดยไม่กรอง)
 */
export async function listFiles(userId) {
  if (userId == null) throw new Error('listFiles requires a userId — do not call it unscoped')
  if (usingPostgres) return pgListFiles(userId)
  return files.filter(
    (f) => !f.vault && f.ownerId != null && String(f.ownerId) === String(userId),
  )
}

export async function findFile(id) {
  if (usingPostgres) return pgFindFile(id)
  return files.find((f) => f.id === id) ?? null
}

export async function deleteFile(id) {
  if (usingPostgres) return pgDeleteFile(id) // file_versions หายตามผ่าน ON DELETE CASCADE
  const i = files.findIndex((f) => f.id === id)
  if (i === -1) return false
  files.splice(i, 1)
  // dev fallback ต้องเลียนแบบ CASCADE ด้วยมือ — ไม่งั้นสองโหมดจะมีพฤติกรรมต่างกัน
  // และชุดทดสอบชุดเดียวกันจะพิสูจน์ได้แค่โหมดหนึ่ง
  for (let k = memFileVersions.length - 1; k >= 0; k--) {
    if (String(memFileVersions[k].fileId) === String(id)) memFileVersions.splice(k, 1)
  }
  return true
}

export async function createFolder(name, user) {
  if (usingPostgres) return pgCreateFolder(name, user)
  const safe = String(name).slice(0, 120)
  const row = {
    id: nextId('f'), name: safe, type: 'Folder', ext: '', size: 0,
    modified: Date.now(), uploader: user.displayName, ownerId: String(user.id),
    vault: false, verified: true, sha256: null, path: `/datalake/${safe}`,
  }
  files.unshift(row)
  return row
}

/**
 * ไฟล์ "ของผู้ใช้คนนี้" ที่ชื่อตรงกันและยังอยู่ — ใช้ตัดสินว่าการอัปโหลดครั้งนี้คือ
 * การอัปโหลดเวอร์ชันใหม่ของไฟล์เดิม หรือเป็นไฟล์ใหม่คนละไฟล์
 *
 * ⚠️ ผูกกับเจ้าของเสมอ (uploaded_by = ผู้อัปโหลด) — ถ้าเทียบด้วยชื่อไฟล์อย่างเดียว
 *    ผู้ใช้คนหนึ่งจะ "อัปโหลดทับ" ไฟล์ของคนอื่นได้แค่ตั้งชื่อให้ตรงกัน ซึ่งเท่ากับได้สิทธิ์
 *    เขียนไฟล์ของผู้อื่นโดยไม่ผ่านด่าน ownership ที่ DELETE มีอยู่ (ดู routes/api.js)
 */
export async function findOwnFileByName(name, userId) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT f.*, COALESCE(NULLIF(btrim(u.profile_name), ''), u.display_name) AS uploader_name
         FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE f.name = $1 AND f.uploaded_by = $2 AND f.vault = false
        ORDER BY f.modified_at DESC LIMIT 1`,
      [String(name), userId],
    )
    return rows.length ? mapFileRow(rows[0]) : null
  }
  return files.find(
    (f) => f.name === String(name) && !f.vault && String(f.ownerId) === String(userId),
  ) ?? null
}

/**
 * แทนไบต์ของไฟล์เดิมด้วยไบต์ใหม่ แล้วบันทึกไบต์ชุดเก่าเป็น "เวอร์ชัน"
 * ⚠️ ผู้เรียกต้องย้ายไบต์เก่าไปไว้ใต้ versions/ ให้เรียบร้อยก่อน (moveToVersions)
 *    แล้วส่ง key ที่ได้มาเป็น previousKey — ฟังก์ชันนี้ดูแลแค่ชั้น metadata
 */
export async function replaceFileContents({ file, storageKey, size, sha256, previous, user }) {
  if (usingPostgres) {
    if (previous?.key) {
      await query(
        `INSERT INTO file_versions (file_id, storage_key, size_bytes, sha256, superseded_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [file.id, previous.key, previous.size ?? 0, previous.sha256 ?? null, user.id],
      )
    }
    const { rows } = await query(
      `UPDATE files SET path = $1, size_bytes = $2, sha256 = $3, modified_at = now(), uploaded_by = $4
        WHERE id = $5 RETURNING *`,
      [storageKey, Number(size) || 0, sha256 ?? null, user.id, file.id],
    )
    if (!rows.length) return null
    return mapFileRow({ ...rows[0], uploader_name: user.displayName })
  }

  const row = files.find((f) => f.id === file.id)
  if (!row) return null
  if (previous?.key) {
    memFileVersions.push({
      id: nextId('fv'), fileId: row.id, storageKey: previous.key,
      size: previous.size ?? 0, sha256: previous.sha256 ?? null,
      supersededBy: String(user.id), createdAt: Date.now(),
    })
  }
  row.path = storageKey
  row.size = Number(size) || 0
  row.sha256 = sha256 ?? null
  row.modified = Date.now()
  row.uploader = user.displayName
  row.ownerId = String(user.id)
  return { ...row }
}

/** บันทึก metadata ของไฟล์ที่อัปโหลดเสร็จ — bytes ถูกเขียนลง Storage Layer ไปแล้ว
 *  ก่อนถึงฟังก์ชันนี้ (ดู POST /api/files/upload) และ storageKey คือตำแหน่งของมันจริง ๆ */
export async function recordUpload({ name, storageKey, size, sha256, user }) {
  if (usingPostgres) return pgRecordUpload({ name, storageKey, size, sha256, user })
  const row = {
    id: nextId('f'), name: String(name).slice(0, 200), type: 'File',
    ext: String(name).split('.').pop() ?? '', size: Number(size) || 0,
    modified: Date.now(), uploader: user.displayName, ownerId: String(user.id),
    vault: false, verified: true, sha256: sha256 ?? null, path: storageKey,
  }
  files.unshift(row)
  return row
}

// ── Shares — ลิงก์ที่ไถ่ไฟล์ได้จริง ────────────────────────────────────
//
// ⚠️ ก่อนหน้านี้หมวดนี้เป็น "ด้านหน้าอาคาร": POST สร้างแถวจริงลงตาราง แต่ไม่มีคอลัมน์
//    token ไม่มี endpoint ไถ่ลิงก์ ไม่มี URL ให้ผู้ใช้คัดลอกที่ไหนในจอเลย, password_hash
//    ไม่ถูกอ่านโดยโค้ดใดทั้งสิ้น, hits ไม่เคยเพิ่ม และ vlan_scope ถูกเก็บโดยไม่มีใครตรวจ
//    ทั้งหมดนี้ประกอบกันเป็นจอที่ดูเหมือนระบบแชร์ไฟล์ที่ล็อกขอบเขตได้ แต่แชร์อะไรไม่ได้เลย
//
// ⚠️ token: เก็บ sha256 ไม่ใช่ค่าดิบ (ดูเหตุผลเต็มใน schema.sql) ค่าดิบถูกคืน
//    "ครั้งเดียว" ตอนสร้าง — เซิร์ฟเวอร์แสดงลิงก์เดิมซ้ำไม่ได้เพราะไม่มีค่าดิบเก็บไว้
const shares = [] // dev fallback (ไม่มี DATABASE_URL) — เริ่มว่าง ไม่มีแถวเดโม่ที่ไถ่ไม่ได้

const EXPIRY_MS = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }

// ⚠️ 'otc' (one-time code) ถูกถอดออกจากตัวเลือก — มันหมายถึงรหัสที่ส่งให้ผู้รับผ่าน
//    ช่องทางอื่น (อีเมล/SMS) ซึ่งระบบนี้ไม่มีช่องทางส่งอะไรออกไปเลย เดิม UI ให้เลือกได้
//    และเซิร์ฟเวอร์ก็รับค่าไว้ แต่ไม่เคยมีรหัสถูกสร้างหรือถูกตรวจที่ไหน = ลิงก์ที่ผู้ใช้
//    เชื่อว่าต้องมีรหัสจึงเปิดได้ กลายเป็นลิงก์ที่ใครถือก็เปิดได้ทันที
//    ค่า 'otc' ยังผ่าน CHECK ของตารางเพื่อไม่ทำให้แถวเก่าผิด constraint แต่สร้างใหม่ไม่ได้
const AUTH_TYPES = new Set(['password', 'none'])
const SCOPES = new Set(['any', 'zones'])
const MIN_LINK_PASSWORD = 8

/** token ดิบ 256 บิต — URL-safe, เดาไม่ได้ (ไม่ใช่ id ที่ไล่เลขได้) */
const newShareToken = () => randomBytes(32).toString('base64url')

/** สิ่งที่เก็บลงตาราง — ห้ามเก็บ token ดิบ */
export const hashShareToken = (token) => sha256Hex(String(token))

function mapShareRow(r) {
  return {
    id: String(r.id), fileId: String(r.file_id), fileName: r.file_name,
    createdBy: r.created_by_name ?? 'system', authType: r.auth_type, scope: r.scope,
    scopeCidrs: r.vlan_scope ?? [], hits: r.hits, revoked: r.revoked,
    expiresAt: new Date(r.expires_at).getTime(),
    // ⚠️ ไม่คืน token_hash และ password_hash ออกไปไหนเลย — แม้แต่ให้ Admin
    //    hasPassword เป็น boolean พอสำหรับให้ UI บอกผู้ใช้ว่าลิงก์นี้ต้องใช้รหัส
    hasPassword: Boolean(r.password_hash),
    redeemable: Boolean(r.token_hash), // false = แถวเก่าก่อน migration (ไม่มีลิงก์ให้ไถ่)
  }
}

async function pgListShares() {
  const { rows } = await query(
    `SELECT s.*, f.name AS file_name, COALESCE(NULLIF(btrim(u.profile_name), ''), u.display_name) AS created_by_name
       FROM shares s
       JOIN files f ON f.id = s.file_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.revoked = false
        AND s.expires_at > now()
      ORDER BY s.created_at DESC`,
  )
  return rows.map(mapShareRow)
}

export async function listShares() {
  if (usingPostgres) return pgListShares()
  const now = Date.now()
  return shares
    .filter((s) => !s.revoked && s.expiresAt > now)
    .map((s) => ({ ...s, tokenHash: undefined, passwordHash: undefined }))
}

/**
 * สร้างลิงก์แชร์ + token ดิบที่คืนให้ "ครั้งเดียว"
 * @returns {Promise<{ share: object, token: string } | null>} null = input ไม่ผ่าน
 *
 * ⚠️ scope 'zones' snapshot CIDR จาก network_zones ณ เวลานี้ลง vlan_scope — ไม่อ่าน
 *    ตาราง zones ตอนไถ่ลิงก์ เพราะขอบเขตของลิงก์ต้องเป็นสิ่งที่ผู้สร้าง "เห็นและตกลง"
 *    ตอนสร้าง ถ้าอ่านสดตอนไถ่ การที่ Admin เพิ่ม zone ใหม่วันหลังจะขยายขอบเขตของ
 *    ลิงก์เก่าทุกลิงก์ย้อนหลังโดยไม่มีใครรู้ตัว
 * ⚠️ ถ้าเลือก 'zones' แต่ยังไม่มี zone ใดถูกกำหนดไว้ = ปฏิเสธ ไม่ใช่สร้างลิงก์ที่
 *    "จำกัดขอบเขต" ด้วยรายการว่าง (ซึ่งจะกลายเป็นไม่จำกัดจริง ๆ แต่ป้ายบอกว่าจำกัด)
 */
export async function createShare({ fileId, expiry, authType, scope, password }, user) {
  if (!EXPIRY_MS[expiry] || !AUTH_TYPES.has(authType) || !SCOPES.has(scope)) return null

  const pw = String(password ?? '')
  if (authType === 'password' && pw.length < MIN_LINK_PASSWORD) return null

  let cidrs = []
  if (scope === 'zones') {
    cidrs = (await listNetworkZones()).map((z) => z.cidr)
    if (cidrs.length === 0) return null
  }

  const token = newShareToken()
  const tokenHash = hashShareToken(token)
  // cost 12 เท่ากับบัญชีที่สร้างใหม่ — รหัสลิงก์ก็คือรหัสผ่านที่กันคนเข้าถึงไฟล์เหมือนกัน
  const passwordHash = authType === 'password' ? bcrypt.hashSync(pw, 12) : null

  if (usingPostgres) {
    if (!/^\d+$/.test(String(fileId))) return null
    const { rows: fileRows } = await query(`SELECT id, name, vault, uploaded_by FROM files WHERE id = $1`, [fileId])
    const file = fileRows[0]
    if (!file || file.vault) return null // แชร์ไฟล์ vault ไม่ได้ — server อ่าน ciphertext ไม่ออก
    // ⚠️ ต้องเป็นเจ้าของไฟล์ถึงจะสร้างลิงก์แชร์ได้ — ไม่งั้นผู้ใช้คนหนึ่งระบุ id ไฟล์ของ
    //    คนอื่นแล้วสร้างลิงก์สาธารณะที่ไถ่ได้โดยไม่ต้องล็อกอินเลย ซึ่งหนักกว่าการอ่าน
    //    metadata ข้ามเจ้าของ (Defect A/B) เพราะเปิดเนื้อไฟล์ให้ "ใครก็ได้" ที่ถือลิงก์
    if (file.uploaded_by == null || String(file.uploaded_by) !== String(user.id)) return null
    const { rows } = await query(
      `INSERT INTO shares (file_id, created_by, auth_type, password_hash, scope, vlan_scope, expires_at, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [fileId, user.id, authType, passwordHash, scope, cidrs, new Date(Date.now() + EXPIRY_MS[expiry]), tokenHash],
    )
    const share = mapShareRow({ ...rows[0], file_name: file.name, created_by_name: user.displayName })
    return { share, token }
  }

  const file = files.find((f) => f.id === fileId)
  if (!file || file.vault) return null
  if (file.ownerId == null || String(file.ownerId) !== String(user.id)) return null
  const row = {
    id: nextId('s'), fileId, fileName: file.name, createdBy: user.displayName,
    authType, scope, scopeCidrs: cidrs, hits: 0, revoked: false,
    expiresAt: Date.now() + EXPIRY_MS[expiry],
    hasPassword: Boolean(passwordHash), redeemable: true,
    tokenHash, passwordHash,
  }
  shares.unshift(row)
  return { share: { ...row, tokenHash: undefined, passwordHash: undefined }, token }
}

/**
 * หาลิงก์จาก token ดิบ — คืน "ทุกอย่างที่เส้นทางไถ่ลิงก์ต้องใช้" รวม hash ของรหัส
 * ⚠️ ผลลัพธ์ของฟังก์ชันนี้ห้ามหลุดออกไปที่ response ใด ๆ (มี passwordHash อยู่ข้างใน)
 * ⚠️ ไม่กรอง revoked/expired ที่นี่โดยเจตนา — ผู้เรียกต้องตัดสินเอง เพื่อให้ audit
 *    แยกได้ว่า "ไม่มีลิงก์นี้" กับ "มีแต่ถูกเพิกถอน/หมดอายุ" (คนละเหตุการณ์เชิง forensics)
 *    แต่ response ที่ส่งกลับผู้ใช้ต้องเหมือนกันทุกกรณี — ไม่ให้ probe ว่า token ไหนเคยมี
 */
export async function findShareByToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null
  const tokenHash = hashShareToken(token)

  if (usingPostgres) {
    const { rows } = await query(
      `SELECT s.*, f.name AS file_name, f.path AS file_path, f.size_bytes AS file_size, f.vault AS file_vault
         FROM shares s JOIN files f ON f.id = s.file_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    )
    if (!rows.length) return null
    const r = rows[0]
    return {
      id: String(r.id), fileId: String(r.file_id), fileName: r.file_name,
      filePath: r.file_path, fileSize: Number(r.file_size), fileVault: r.file_vault,
      authType: r.auth_type, passwordHash: r.password_hash,
      scopeCidrs: r.vlan_scope ?? [], revoked: r.revoked,
      expiresAt: new Date(r.expires_at).getTime(),
    }
  }

  const s = shares.find((x) => x.tokenHash === tokenHash)
  if (!s) return null
  const file = files.find((f) => f.id === s.fileId)
  return {
    id: s.id, fileId: s.fileId, fileName: s.fileName,
    filePath: file?.path ?? null, fileSize: file?.size ?? 0, fileVault: Boolean(file?.vault),
    authType: s.authType, passwordHash: s.passwordHash ?? null,
    scopeCidrs: s.scopeCidrs ?? [], revoked: s.revoked, expiresAt: s.expiresAt,
  }
}

/** เพิ่มตัวนับการเข้าถึง — เรียก "หลัง" ผ่านด่านทั้งหมดแล้วเท่านั้น (นับการไถ่สำเร็จ ไม่ใช่การลอง) */
export async function countShareHit(id) {
  if (usingPostgres) {
    if (!/^\d+$/.test(String(id))) return false
    // UPDATE แบบ read-modify-write ในคำสั่งเดียว — ผู้รับหลายคนกดพร้อมกันแล้วตัวนับไม่หาย
    const { rowCount } = await query(`UPDATE shares SET hits = hits + 1 WHERE id = $1`, [id])
    return rowCount > 0
  }
  const s = shares.find((x) => x.id === String(id))
  if (!s) return false
  s.hits += 1
  return true
}

export async function revokeShare(id) {
  if (usingPostgres) {
    if (!/^\d+$/.test(String(id))) return false
    const { rowCount } = await query(`UPDATE shares SET revoked = true WHERE id = $1`, [id])
    return rowCount > 0
  }
  const s = shares.find((x) => x.id === id)
  if (!s) return false
  s.revoked = true
  return true
}

/** ล้าง shares ในโหมด dev fallback — ใช้โดยชุดทดสอบเท่านั้น */
export async function __resetSharesForTests() {
  if (usingPostgres) {
    await query('DELETE FROM shares')
    return
  }
  shares.length = 0
}

// ── File versions — ประวัติของไฟล์จริง (แทนที่ "Snapshots" ที่เป็นของปลอมทั้งหมด) ──
//
// ⚠️ ของเดิมคืออาเรย์แปดแถว (snap-0086…snap-0093) ที่มี deltaGB/verified ตั้งไว้เอง และ
//    rollbackTo() แค่ตั้งธง destroyed = true ให้แถวที่ใหม่กว่าเป้าหมาย **ไม่มีไบต์ของใคร
//    ถูกกู้คืนเลยแม้แต่ไบต์เดียว** จอบอกว่า "restored" พร้อมตัวเลข GB ที่เสียไป ซึ่งเป็น
//    การหลอกในเรื่องที่อันตรายที่สุดเรื่องหนึ่ง: ผู้ใช้เชื่อว่ากู้ข้อมูลได้แล้ว
//
// ⚠️ ทำไมเป็น "เวอร์ชันต่อไฟล์" ไม่ใช่ snapshot ของทั้งชั้นเก็บไฟล์: deployment นี้เก็บไฟล์
//    บน Docker named volume ธรรมดา ไม่ใช่ LVM/ZFS/Btrfs และคอนเทนเนอร์รันด้วย user
//    'node' โดยไม่มี CAP_SYS_ADMIN — point-in-time image ทำไม่ได้จริงด้วยของที่มีอยู่
//    (ดูหมายเหตุเต็มที่ตาราง file_versions ใน schema.sql) สิ่งที่ทำได้และกู้ข้อมูลได้จริง
//    คือเก็บไบต์ชุดก่อนของไฟล์แต่ละไฟล์ไว้ — จอจึงถูกเปลี่ยนชื่อให้ตรงกับสิ่งที่มันทำ

const memFileVersions = [] // dev fallback

const mapVersionRow = (r) => ({
  id: String(r.id),
  fileId: String(r.file_id),
  storageKey: r.storage_key,
  size: Number(r.size_bytes),
  sha256: r.sha256,
  supersededBy: r.superseded_by == null ? null : String(r.superseded_by),
  supersededByName: r.superseded_by_name ?? null,
  createdAt: new Date(r.created_at).getTime(),
})

/**
 * ประวัติเวอร์ชันของไฟล์หนึ่ง (ใหม่ → เก่า)
 * ⚠️ ไม่คืน storageKey ออกไปทาง API — เป็นรายละเอียดภายในของ Storage Layer
 *    (ผู้เรียกใน routes/api.js เป็นคนกรองก่อนส่งออก)
 */
export async function listFileVersions(fileId) {
  if (usingPostgres) {
    if (!/^\d+$/.test(String(fileId))) return []
    const { rows } = await query(
      `SELECT v.*, COALESCE(NULLIF(btrim(u.profile_name), ''), u.display_name) AS superseded_by_name
         FROM file_versions v LEFT JOIN users u ON u.id = v.superseded_by
        WHERE v.file_id = $1
        ORDER BY v.created_at DESC, v.id DESC`,
      [fileId],
    )
    return rows.map(mapVersionRow)
  }
  return memFileVersions
    .filter((v) => String(v.fileId) === String(fileId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((v) => ({ ...v }))
}

/** เวอร์ชันชิ้นเดียว (พร้อม storageKey สำหรับใช้งานภายใน) — null ถ้าไม่ใช่ของไฟล์นี้ */
export async function findFileVersion(fileId, versionId) {
  if (usingPostgres) {
    if (!/^\d+$/.test(String(fileId)) || !/^\d+$/.test(String(versionId))) return null
    const { rows } = await query(
      `SELECT * FROM file_versions WHERE id = $1 AND file_id = $2`,
      [versionId, fileId],
    )
    return rows.length ? mapVersionRow(rows[0]) : null
  }
  const v = memFileVersions.find(
    (x) => String(x.id) === String(versionId) && String(x.fileId) === String(fileId),
  )
  return v ? { ...v } : null
}

/** ลบแถวเวอร์ชัน — ใช้ตอนกู้คืน (ไบต์ของมันถูกย้ายไปเป็นไฟล์ปัจจุบันแล้ว) */
export async function deleteFileVersion(fileId, versionId) {
  if (usingPostgres) {
    const { rowCount } = await query(
      `DELETE FROM file_versions WHERE id = $1 AND file_id = $2`, [versionId, fileId],
    )
    return rowCount > 0
  }
  const i = memFileVersions.findIndex(
    (x) => String(x.id) === String(versionId) && String(x.fileId) === String(fileId),
  )
  if (i === -1) return false
  memFileVersions.splice(i, 1)
  return true
}

/** จำนวนไฟล์ที่มีประวัติ + จำนวนเวอร์ชันรวม — ใช้โดยจอ File history เพื่อบอกสถานะรวม */
export async function fileVersionStats() {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT count(*)::int AS versions,
              count(DISTINCT file_id)::int AS files,
              COALESCE(sum(size_bytes), 0)::bigint AS bytes
         FROM file_versions`,
    )
    const r = rows[0]
    return { versions: r.versions, files: r.files, bytes: Number(r.bytes) }
  }
  const ids = new Set(memFileVersions.map((v) => String(v.fileId)))
  return {
    versions: memFileVersions.length,
    files: ids.size,
    bytes: memFileVersions.reduce((n, v) => n + (v.size || 0), 0),
  }
}

/** ล้างประวัติเวอร์ชัน — ใช้โดยชุดทดสอบเท่านั้น */
export async function __resetFileVersionsForTests() {
  if (usingPostgres) {
    await query('DELETE FROM file_versions')
    return
  }
  memFileVersions.length = 0
}

// ── Storage & Backup ─────────────────────────────────────────────────
//
// ⚠️ ของเดิมในหมวดนี้เป็นการแต่งข้อมูลระดับที่อันตราย: ดิสก์สองลูก 'WD Red Pro 4TB'
//    พร้อม serial (WD-WX32DA8L7K4N), อุณหภูมิ 38/41°C, 'smart: PASSED', ชั่วโมงทำงาน
//    14,208 และ backup job สามงานที่มี lastRun/nextRun เดินอยู่ **ไม่มีอะไรในนั้นถูกอ่าน
//    มาจากที่ไหนเลย** ฮาร์ดแวร์ชุดนั้นไม่มีอยู่ใน deployment นี้ และไม่มี backup job ใด
//    ถูกตั้งค่าไว้ที่ไหน ผู้ดูแลที่เห็น "SMART: PASSED" จะเลิกตรวจดิสก์ และเห็น
//    "Nightly incremental · ok" จะเชื่อว่ามีสำเนาข้อมูลอยู่ — ทั้งสองข้อผิด
//
// ⚠️ ทำไมอ่านค่าจริงจาก smartctl/mdadm ไม่ได้ (ตรวจแล้ว ไม่ใช่สันนิษฐาน):
//    - ทั้งสองโปรแกรมไม่ได้ติดตั้งใน image (node:20-alpine + npm ci เท่านั้น)
//    - smartctl ต้องเข้าถึง raw device (--device=/dev/sda) ซึ่งต้อง CAP_SYS_RAWIO
//      หรือ privileged; compose ไม่ได้ให้ทั้งคู่ และคอนเทนเนอร์รันด้วย user 'node'
//    - mdadm ต้องอ่าน /proc/mdstat ของโฮสต์ และ deployment นี้ไม่มี RAID array
//    การจะได้ค่าจริงต้องเพิ่มสิทธิ์ระดับโฮสต์ = เปลี่ยน infrastructure ไม่ใช่เขียนโค้ดเพิ่ม
//
// สิ่งที่เป็นของจริงและทำได้โดยไม่ต้องมีสิทธิ์พิเศษ: ความจุของ mount (statfs) และ
// การแบ่งตามหมวดจากผลรวมใน Postgres — สองอย่างนี้จึงเป็นเนื้อหาทั้งหมดของหมวดนี้

/** ผลรวมขนาดตามหมวด (จากตารางจริง) — key ตรงกับที่จอ Dashboard/Storage ใช้แปลภาษา */
async function usageByCategory() {
  if (usingPostgres) {
    // จัดหมวดจากนามสกุลของชื่อไฟล์ด้วย SQL — ใช้ตารางเดียวกับที่จอ Files แสดง
    const { rows } = await query(
      `SELECT
         COALESCE(sum(size_bytes) FILTER (WHERE lower(name) ~ '\\.(pdf|docx?|txt|pptx?|xlsx?|csv)$'), 0)::bigint AS docs,
         COALESCE(sum(size_bytes) FILTER (WHERE lower(name) ~ '\\.(zip|gz|rar|7z|tar)$'), 0)::bigint AS archives,
         COALESCE(sum(size_bytes) FILTER (WHERE lower(name) ~ '\\.(mp4|mov|mkv|png|jpe?g|webp)$'), 0)::bigint AS media,
         COALESCE(sum(size_bytes) FILTER (WHERE lower(name) !~ '\\.(pdf|docx?|txt|pptx?|xlsx?|csv|zip|gz|rar|7z|tar|mp4|mov|mkv|png|jpe?g|webp)$'), 0)::bigint AS other
       FROM files WHERE vault = false`,
    )
    const { rows: vaultRows } = await query(
      `SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM vault_blobs`,
    )
    const { rows: versionRows } = await query(
      `SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM file_versions`,
    )
    const r = rows[0]
    return {
      docs: Number(r.docs), archives: Number(r.archives), media: Number(r.media),
      other: Number(r.other), vaultSeg: Number(vaultRows[0].bytes), versions: Number(versionRows[0].bytes),
    }
  }

  const CAT = {
    docs: /\.(pdf|docx?|txt|pptx?|xlsx?|csv)$/i,
    archives: /\.(zip|gz|rar|7z|tar)$/i,
    media: /\.(mp4|mov|mkv|png|jpe?g|webp)$/i,
  }
  const totals = { docs: 0, archives: 0, media: 0, other: 0, vaultSeg: 0, versions: 0 }
  for (const f of files) {
    if (f.vault) continue
    const key = Object.keys(CAT).find((k) => CAT[k].test(f.name)) ?? 'other'
    totals[key] += f.size || 0
  }
  totals.versions = memFileVersions.reduce((n, v) => n + (v.size || 0), 0)
  return totals
}

/**
 * สถานะชั้นเก็บข้อมูล — คืนเฉพาะสิ่งที่วัดได้จริง และประกาศสิ่งที่วัดไม่ได้อย่างชัดเจน
 * ⚠️ `unavailable` ไม่ใช่ของประดับ: จอใช้มันแสดงสถานะ "ยังไม่มีข้อมูล" แทนการเว้นว่าง
 *    หรือ (แย่กว่านั้น) เติมค่าที่ดูสมเหตุสมผลเข้าไปเอง
 */
export async function storageStatus() {
  const [fsCapacity, usage] = await Promise.all([filesystemCapacity(), usageByCategory()])
  const accounted = Object.values(usage).reduce((a, b) => a + b, 0)

  return {
    // null = อ่านค่าไม่ได้ (ไม่ใช่ 0 และไม่ใช่ค่าที่เดาให้)
    capacityBytes: fsCapacity,
    usage,
    // ไบต์ที่ statfs นับว่าใช้ไปแต่แอปไม่รู้จัก (ไฟล์ของระบบ, ข้อมูลของ container อื่น
    // บน volume เดียวกัน, ไฟล์กำพร้า) — แสดงแยกแทนที่จะยัดรวมกับหมวดใดหมวดหนึ่ง
    unaccountedBytes: fsCapacity ? Math.max(0, fsCapacity.usedBytes - accounted) : null,
    unavailable: {
      // ทุกคีย์ในนี้คือ "ต้องมีสิทธิ์/ฮาร์ดแวร์ที่ deployment นี้ไม่ได้ให้" — ดูเหตุผลด้านบน
      diskHealth: 'needs-host-access',   // smartctl: raw device + CAP_SYS_RAWIO
      raid: 'not-configured',            // ไม่มี array ใน deployment นี้
      backups: 'not-configured',         // ไม่มี job หรือปลายทางใดถูกตั้งค่าไว้
    },
  }
}

// ── Network zones (Admin governance) ──────────────────────────────────
//
// ⚠️ ถอด "Encryption keys / rotate master key" ออกทั้งฟีเจอร์ — ห้ามเอากลับมาในรูปนี้
//
// ของเดิมคือ object ในหน่วยความจำที่บอกว่า algorithm 'AES-256-GCM', keyId
// 'aegis-drive-master-2026-06' และ rotatedAt เมื่อ 31 วันก่อน แล้ว rotateKeys()
// แค่เขียนเวลาใหม่ทับตัวแปรนั้น **ไม่มีกุญแจ master อยู่จริงที่ไหนในระบบนี้เลย**:
//   - ไฟล์ใน Data Lake ถูกเก็บเป็น plaintext บนดิสก์ (ดู storage/fileStore.js)
//     ยังไม่มี encryption-at-rest ในชั้นแอปพลิเคชัน
//   - ไฟล์ใน Vault ถูกเข้ารหัสฝั่งเบราว์เซอร์ด้วย KEK ที่ derive จาก passphrase ของ
//     ผู้ใช้ (Argon2id) — เซิร์ฟเวอร์ไม่มีชิ้นส่วนของกุญแจนั้นเลยโดยการออกแบบ
//     จึงไม่มีอะไรให้ "rotate" และถ้ามีจริงก็แปลว่า zero-knowledge พังไปแล้ว
// ผลคือปุ่มที่บอก Admin ว่า "ข้อมูลของคุณถูกเข้ารหัสใหม่ด้วยกุญแจใหม่แล้ว" ทั้งที่
// ไม่มีอะไรเกิดขึ้น — เป็นความเท็จประเภทเดียวกับ "คีย์กู้คืน 12 คำ" ที่ถูกถอดออกไป
// ก่อนหน้านี้ (ดูหมายเหตุหัวไฟล์ src/screens/Settings.jsx) และอันตรายแบบเดียวกัน:
// ผู้ดูแลระบบเชื่อว่าได้ทำ key rotation ตามรอบแล้วจึงเลิกกังวลกับมัน
//
// ถ้าวันหนึ่งจะทำ encryption-at-rest ของจริง: จุดต่อคือ storage/fileStore.js
// (เข้ารหัสตอนเขียน/ถอดตอนอ่าน) + ที่เก็บกุญแจที่ไม่ใช่ในโค้ดและไม่ใช่ env var ธรรมดา
// + เส้นทาง re-encrypt ไฟล์เดิมทั้งคลังตอน rotate — เป็นงานคนละขนาดกับปุ่มหนึ่งปุ่ม

const mapZoneRow = (r) => ({ id: String(r.id), name: r.name, cidr: r.cidr })

// Network zones เป็นช่วง CIDR ที่ restricted shares snapshot ณ เวลาสร้าง แล้ว route
// redemption เทียบกับ source address ที่ Express มองเห็นจริง การตรวจนี้เป็น defense in
// depth ไม่ใช่ตัวแทน UFW/VLAN/Twingate device policy และใช้ยืนยัน endpoint ไม่ได้เมื่อ
// ingress ทำ source identity หายก่อนถึง trusted nginx edge
async function pgListZones() {
  const { rows } = await query(`SELECT id, name, cidr FROM network_zones ORDER BY id`)
  return rows.map(mapZoneRow)
}

const memZones = []

export async function listNetworkZones() {
  if (usingPostgres) return pgListZones()
  return memZones.map((z) => ({ ...z }))
}

const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/

/** CIDR ต้องถูกทั้งรูปแบบและ "ช่วงค่า" — 999.1.1.1/99 ผ่าน regex ได้แต่ไม่มีความหมาย */
function validCidr(cidr) {
  const s = String(cidr ?? '').trim()
  if (!CIDR_RE.test(s)) return null
  const [addr, bitsRaw] = s.split('/')
  const bits = Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const octets = addr.split('.').map(Number)
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
  return s
}

export async function addNetworkZone({ name, cidr }) {
  const safeName = String(name ?? '').trim().slice(0, 60)
  const safeCidr = validCidr(cidr)
  if (!safeName || !safeCidr) return null

  if (usingPostgres) {
    try {
      const { rows } = await query(
        `INSERT INTO network_zones (name, cidr) VALUES ($1, $2) RETURNING id, name, cidr`,
        [safeName, safeCidr],
      )
      return mapZoneRow(rows[0])
    } catch (err) {
      if (err.code === '23505') return null // CIDR ซ้ำ (unique) — ไม่ใช่ 500
      throw err
    }
  }
  if (memZones.some((z) => z.cidr === safeCidr)) return null
  const row = { id: nextId('z'), name: safeName, cidr: safeCidr }
  memZones.push(row)
  return { ...row }
}

export async function removeNetworkZone(id) {
  if (usingPostgres) {
    if (!/^\d+$/.test(String(id))) return false
    const { rowCount } = await query(`DELETE FROM network_zones WHERE id = $1`, [id])
    return rowCount > 0
  }
  const i = memZones.findIndex((z) => z.id === String(id))
  if (i === -1) return false
  memZones.splice(i, 1)
  return true
}

// ── Dashboard ────────────────────────────────────────────────────────
// ── กิจกรรมย้อนหลัง 7 วัน — นับจาก audit_log จริง ────────────────────────────
//
// ⚠️ เดิมชื่อ transfer7d และเป็นอาเรย์เจ็ดแถวที่ตั้งค่าไว้เอง (Tue up:42 down:118 …)
//    พร้อมธง `projected: true` สองแถวท้ายที่จอวาดเป็นลายขวางว่า "คาดการณ์" — ไม่มี
//    การคาดการณ์ใดเกิดขึ้น และไม่มีตัวเลขใดถูกวัด กราฟที่เด่นที่สุดบนจอแรกที่ผู้ใช้เห็น
//    จึงเป็นภาพวาดล้วน ๆ ที่นิ่งเท่ากันทุกวันไม่ว่าระบบจะถูกใช้งานจริงแค่ไหน
//
// ⚠️ หน่วยเปลี่ยนจาก "GB ที่ถ่ายโอน" เป็น "จำนวนครั้ง" โดยเจตนา — และนี่คือข้อจำกัดจริง
//    ที่ต้องพูดตรง: audit_log ไม่เก็บขนาดไบต์ของแต่ละเหตุการณ์ (ตั้งใจให้เก็บน้อยที่สุด
//    เพื่อความเป็นส่วนตัว) เราจึงนับ "เหตุการณ์" ได้จริง แต่คำนวณปริมาณข้อมูลไม่ได้
//    การเดาปริมาณจากขนาดไฟล์ปัจจุบันจะผิดทันทีที่ไฟล์ถูกอัปโหลดทับหรือถูกลบ
//    ถ้าวันหนึ่งต้องการกราฟปริมาณจริง ต้องเพิ่มคอลัมน์ขนาดใน audit_log ก่อน
//    (เป็นการตัดสินใจเรื่อง privacy ไม่ใช่แค่เรื่องเทคนิค)
const UPLOAD_ACTIONS = ['FILE_UPLOAD', 'FILE_VERSION_ADD']
const DOWNLOAD_ACTIONS = ['FILE_DOWNLOAD', 'FILE_VERSION_DOWNLOAD', 'SHARE_REDEEM']

const isoDay = (d) => new Date(d).toISOString().slice(0, 10)

async function activity7d() {
  if (usingPostgres) {
    // generate_series เติมวันที่ไม่มีเหตุการณ์ให้เป็น 0 — ไม่ใช่ข้ามวันนั้นไป
    // (กราฟที่ข้ามวันว่างทำให้ช่วงเวลาบิดเบี้ยวและอ่านผิด)
    const { rows } = await query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              count(a.id) FILTER (WHERE a.action = ANY($1)) AS uploads,
              count(a.id) FILTER (WHERE a.action = ANY($2)) AS downloads
         FROM generate_series(
                (now() AT TIME ZONE 'UTC')::date - INTERVAL '6 days',
                (now() AT TIME ZONE 'UTC')::date,
                INTERVAL '1 day'
              ) AS d(day)
         LEFT JOIN audit_log a
                ON a.at >= d.day AND a.at < d.day + INTERVAL '1 day' AND a.result = 'OK'
        GROUP BY d.day
        ORDER BY d.day`,
      [UPLOAD_ACTIONS, DOWNLOAD_ACTIONS],
    )
    return rows.map((r) => ({ date: r.date, uploads: Number(r.uploads), downloads: Number(r.downloads) }))
  }

  // dev fallback — นับจาก audit ในหน่วยความจำ (ชุดเดียวกับที่จอ Audit แสดง)
  const events = await readAudit(500)
  const days = []
  const today = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - i)
    days.push({ date: isoDay(d), uploads: 0, downloads: 0 })
  }
  const byDate = new Map(days.map((d) => [d.date, d]))
  for (const e of events) {
    if ((e.result ?? '') !== 'OK') continue
    const bucket = byDate.get(isoDay(e.at))
    if (!bucket) continue
    const action = e.action ?? ''
    if (UPLOAD_ACTIONS.includes(action)) bucket.uploads += 1
    else if (DOWNLOAD_ACTIONS.includes(action)) bucket.downloads += 1
  }
  return days
}

// ⚠️ fileList ต้องเป็นไฟล์ "ของผู้ใช้ที่เรียก Dashboard คนนี้เท่านั้น" — เหตุผลเดียวกับ
//    listFiles(): metrics.files/dataLakeBytes/recentFiles มาจากอาเรย์นี้ตรง ๆ ถ้าไม่กรอง
//    ผู้ใช้ทุกคนจะเห็นชื่อไฟล์ล่าสุดของคนอื่นใน recentFiles (การรั่วแบบเดียวกับ
//    GET /api/files ที่ไม่กรอง เพียงแต่โผล่ที่จอ Dashboard แทน) capacity/activity7d
//    ยังคงเป็นภาพรวมทั้งระบบโดยเจตนา (สถิติของเครื่อง/audit ไม่ใช่เนื้อไฟล์รายตัว)
export async function dashboard(userId) {
  const [fileList, shareList, capacity, versionStats, activity] = await Promise.all([
    listFiles(userId), listShares(), filesystemCapacity(), fileVersionStats(), activity7d(),
  ])
  // ขนาดที่ "แอปนี้เป็นเจ้าของ" — แยกจากพื้นที่ที่ใช้ไปทั้ง volume ซึ่งรวมของอื่นด้วย
  const dataLakeBytes = fileList.reduce((s, f) => s + f.size, 0)

  return {
    metrics: {
      // ⚠️ ค่าคงที่ 342 GB (baseline ที่แต่งขึ้น) และ 1024 GB (ความจุที่ hard-code)
      //    ถูกถอดออกแล้ว ทั้งคู่มาจาก statfs จริงตอนนี้ — null = อ่านไม่ได้ ไม่ใช่ศูนย์
      storageBytes: capacity?.usedBytes ?? null,
      storageTotalBytes: capacity?.totalBytes ?? null,
      dataLakeBytes,
      versionBytes: versionStats.bytes,
      files: fileList.length,
      activeShares: shareList.length,
    },
    activity7d: activity,
    recentFiles: fileList.slice(0, 5).map((f) => ({ id: f.id, name: f.name, modified: f.modified })),
  }
}

// ── Users (Admin governance) ─────────────────────────────────────────
// ⚠️ ไม่มีชุดข้อมูลผู้ใช้ในไฟล์นี้อีกแล้ว — บัญชีเป็น "สถานะการเข้าถึงระบบ" ไม่ใช่
//    เนื้อหาที่พอจะเดโม่ด้วยของปลอมได้ แหล่งเดียวคือตาราง users (ดู listUsers ใน
//    connection.js ซึ่งมี dev fallback อ่านจาก DEV_SEED ชุดเดียวกับที่ login ใช้จริง)
//    เดิมที่นี่มีอาเรย์ demoUsers สี่แถวที่ GET /api/users คืนออกไปตรง ๆ โดยไม่เช็ค
//    usingPostgres — จอ Access จึงเคยแสดง 'Somchai P.'/'Nattaporn W.' ที่ไม่มีบัญชีจริง
//    และซ่อนบัญชีจริงที่ Admin provision เอาไว้เอง (มีแค่ตอนที่ POST ซิงก์เข้าอาเรย์
//    ให้ ซึ่งหายทุกครั้งที่รีสตาร์ท ขณะที่บัญชีจริงยังล็อกอินได้อยู่)

// ⚠️ listSessions() เดิมอยู่ที่นี่และคืนแถวที่แต่งขึ้นหนึ่งแถวเสมอ
//    ({ device: 'This browser', ip: '—', lastActive: now, current: true}) — ดูเหมือน
//    ฟีเจอร์ security ที่บอกได้ว่ามีอุปกรณ์ใดล็อกอินอยู่ แต่ไม่ได้อ่านอะไรเลย
//    ตอนนี้ย้ายไปอ่าน session store จริงที่ auth/session.js (listSessionsForUser)
//    ซึ่งคืน ip/user-agent/เวลาจริง และมีเส้นทางเพิกถอนเซสชันอื่นที่ทำงานจริง

// ── Zero-Knowledge Vault — server เก็บ "ciphertext เท่านั้น" ──────────────
//
// เข้ารหัสฝั่ง client เท่านั้น (Argon2id → KEK, envelope AES-256-GCM ต่อไฟล์)
// server เก็บได้แค่ ciphertext ที่อ่านไม่ออก — แม้แต่ Admin ก็เปิดไม่ได้
//
// ⚠️ ฟังก์ชันทุกตัวในหมวดนี้ผูกกับ userId จาก session เสมอ — vault เป็นของ "รายคน"
//    ไม่มี endpoint ใดยอมให้ระบุ userId มาจาก client (ดู routes/api.js)
// ⚠️ ห้ามฟังก์ชันใดในหมวดนี้รับ passphrase/กุญแจเป็นพารามิเตอร์ หรือคืน plaintext
//    ใด ๆ — ถ้าวันหนึ่งมีคนเพิ่มเข้ามา นั่นคือ bug ระดับสถาปัตยกรรม ไม่ใช่ feature

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const isB64 = (s, maxLen = 4096) =>
  typeof s === 'string' && s.length > 0 && s.length <= maxLen && B64_RE.test(s)

/** ตรวจ envelope ที่ client ส่งมา — รูปแบบเท่านั้น เซิร์ฟเวอร์ไม่ (และไม่อาจ) ตรวจเนื้อใน */
export function validVaultEnvelope(e) {
  return (
    isB64(e?.ivB64, 32) && isB64(e?.wrapIvB64, 32) && isB64(e?.metaIvB64, 32) &&
    isB64(e?.wrappedDekB64, 128) && isB64(e?.metaB64, 8192)
  )
}

// ── dev fallback (ไม่มี DATABASE_URL): เก็บในหน่วยความจำ รูปร่างเหมือนแถวจริงทุกประการ
const memVaultMeta = new Map()  // userId → { saltB64, params, verifier, createdAt }
const memVaultBlobs = []        // [{ id, userId, storageKey, ...envelope, size, createdAt }]

const mapVaultMetaRow = (r) => ({
  saltB64: r.salt_b64,
  params: {
    kdf: r.kdf,
    memorySizeKiB: r.memory_kib,
    iterations: r.iterations,
    parallelism: r.parallelism,
  },
  verifier: { ivB64: r.verifier_iv, dataB64: r.verifier_data },
  createdAt: new Date(r.created_at).getTime(),
})

const mapVaultBlobRow = (r) => ({
  id: String(r.id),
  storageKey: r.storage_key,
  ivB64: r.iv_b64,
  wrappedDekB64: r.wrapped_dek_b64,
  wrapIvB64: r.wrap_iv_b64,
  metaIvB64: r.meta_iv_b64,
  metaB64: r.meta_b64,
  size: Number(r.size_bytes),
  createdAt: new Date(r.created_at).getTime(),
})

/**
 * สถานะ vault ของผู้ใช้คนนี้ — null = ยังไม่เคยตั้งค่า (client ต้องเข้า setup flow)
 * ⚠️ ทุกชิ้นที่คืนไปเปิดเผยได้: salt/params/iv ไม่ใช่ความลับ และ verifier ที่ไร้ KEK
 *    คือ noise ผู้โจมตีที่ได้ก้อนนี้ไปยังต้องจ่ายค่า Argon2id เต็มราคาต่อการเดาหนึ่งครั้ง
 */
export async function getVaultMeta(userId) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM vault_meta WHERE user_id = $1`, [userId])
    return rows.length ? mapVaultMetaRow(rows[0]) : null
  }
  return memVaultMeta.get(userId) ?? null
}

/**
 * ตั้งค่า vault ครั้งแรก — เก็บ salt + พารามิเตอร์ KDF + verifier ciphertext
 * ⚠️ ตั้งซ้ำไม่ได้ (คืน null): การเขียนทับ salt/verifier = ทำให้ ciphertext เดิม
 *    ทั้งคลังกำพร้าถาวร เพราะ KEK เดิม derive กลับมาไม่ได้อีก
 */
export async function createVaultMeta(userId, { saltB64, params, verifier }) {
  if (!isB64(saltB64, 64) || !isB64(verifier?.ivB64, 32) || !isB64(verifier?.dataB64, 512)) return null

  // พารามิเตอร์ KDF ต้องถึงพื้นขั้นต่ำ (OWASP: Argon2id m≥19MiB, t≥2) — client ที่ถูกแก้
  // ให้ส่ง m=1,t=1 มาจะทำให้ vault ของตัวเอง brute-force ง่ายขึ้นมาก
  //
  // ⚠️ "ปฏิเสธ" ไม่ใช่ "clamp": verifier ถูกสร้างฝั่ง client ด้วยพารามิเตอร์ที่ส่งมา
  //    ถ้าเซิร์ฟเวอร์แอบยกค่าขึ้นแล้วเก็บค่าใหม่ ตอนปลดล็อก client จะ derive ด้วย
  //    พารามิเตอร์ที่ไม่ตรงกับตอนสร้าง → ได้ KEK คนละดอก → เปิด vault ของตัวเอง
  //    ไม่ได้ตลอดกาล ตั้งแต่วินาทีแรกที่สร้าง การเงียบ ๆ แก้ค่าที่กุญแจผูกอยู่ด้วย
  //    คือการทำลายข้อมูลแบบไม่มีใครรู้ตัว
  const memoryKiB = Number(params?.memorySizeKiB)
  const iterations = Number(params?.iterations)
  const parallelism = Number(params?.parallelism)
  const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
  if (params?.kdf !== undefined && params.kdf !== 'argon2id') return null
  if (!inRange(memoryKiB, 19_456, 1_048_576)) return null
  if (!inRange(iterations, 2, 16)) return null
  if (!inRange(parallelism, 1, 4)) return null

  if (usingPostgres) {
    try {
      const { rows } = await query(
        `INSERT INTO vault_meta (user_id, salt_b64, kdf, memory_kib, iterations, parallelism, verifier_iv, verifier_data)
         VALUES ($1, $2, 'argon2id', $3, $4, $5, $6, $7) RETURNING *`,
        [userId, saltB64, memoryKiB, iterations, parallelism, verifier.ivB64, verifier.dataB64],
      )
      return mapVaultMetaRow(rows[0])
    } catch (err) {
      if (err.code === '23505') return null // ตั้งค่าไปแล้ว — ไม่ใช่ 500
      throw err
    }
  }

  if (memVaultMeta.has(userId)) return null
  const row = {
    saltB64,
    params: { kdf: 'argon2id', memorySizeKiB: memoryKiB, iterations, parallelism },
    verifier: { ivB64: verifier.ivB64, dataB64: verifier.dataB64 },
    createdAt: Date.now(),
  }
  memVaultMeta.set(userId, row)
  return row
}

/**
 * รายการ blob ของผู้ใช้ — คืน metadata ciphertext ครบเพื่อให้ client แกะชื่อไฟล์เองได้
 * แต่ "ไม่" คืนเนื้อไฟล์ (อยู่บนดิสก์ ต้องขอทีละชิ้นผ่าน endpoint ดาวน์โหลด)
 */
export async function listVaultBlobs(userId) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM vault_blobs WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    )
    return rows.map(mapVaultBlobRow)
  }
  return memVaultBlobs
    .filter((b) => b.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((b) => ({ ...b }))
}

/** blob ชิ้นเดียว — คืน null ถ้าไม่ใช่ของ userId นี้ (ไม่แยก 403/404 ให้เดาว่ามีอยู่จริงไหม) */
export async function findVaultBlob(userId, id) {
  if (usingPostgres) {
    if (!/^\d+$/.test(String(id))) return null
    const { rows } = await query(
      `SELECT * FROM vault_blobs WHERE id = $1 AND user_id = $2`,
      [id, userId],
    )
    return rows.length ? mapVaultBlobRow(rows[0]) : null
  }
  const row = memVaultBlobs.find((b) => b.id === String(id) && b.userId === userId)
  return row ? { ...row } : null
}

/**
 * บันทึก metadata ของ blob ที่ ciphertext ถูกเขียนลง Storage Layer เรียบร้อยแล้ว
 * ⚠️ size มาจาก "ไฟล์บนดิสก์จริง" ที่เซิร์ฟเวอร์วัดเอง ไม่ใช่ค่าที่ client แจ้ง
 * ⚠️ ขนาด plaintext จริงอยู่ใน meta_b64 (เข้ารหัส) — เซิร์ฟเวอร์รู้แค่ขนาด ciphertext
 */
export async function addVaultBlob(userId, { storageKey, size, envelope }) {
  if (!validVaultEnvelope(envelope)) return null
  const { ivB64, wrappedDekB64, wrapIvB64, metaIvB64, metaB64 } = envelope

  if (usingPostgres) {
    const { rows } = await query(
      `INSERT INTO vault_blobs (user_id, storage_key, iv_b64, wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [userId, storageKey, ivB64, wrappedDekB64, wrapIvB64, metaIvB64, metaB64, Number(size) || 0],
    )
    return mapVaultBlobRow(rows[0])
  }

  const row = {
    id: nextId('vb'), userId, storageKey,
    ivB64, wrappedDekB64, wrapIvB64, metaIvB64, metaB64,
    size: Number(size) || 0, createdAt: Date.now(),
  }
  memVaultBlobs.push(row)
  return { ...row }
}

/** ลบแถว metadata — ผู้เรียกต้องลบ ciphertext บนดิสก์เองด้วย (ดู routes/api.js) */
export async function deleteVaultBlob(userId, id) {
  if (usingPostgres) {
    if (!/^\d+$/.test(String(id))) return false
    const { rowCount } = await query(
      `DELETE FROM vault_blobs WHERE id = $1 AND user_id = $2`, [id, userId],
    )
    return rowCount > 0
  }
  const i = memVaultBlobs.findIndex((b) => b.id === String(id) && b.userId === userId)
  if (i === -1) return false
  memVaultBlobs.splice(i, 1)
  return true
}

/**
 * ล้าง state ของ vault ทั้งหมด — ใช้โดยชุดทดสอบเท่านั้น
 * รองรับทั้งสองโหมดเพื่อให้เทสต์ชุดเดียวกันรันได้ทั้งกับ in-memory fallback และ
 * Postgres จริง (ชุดทดสอบต้องพิสูจน์โค้ด production path ไม่ใช่แค่ path เดโม่)
 */
export async function __resetVaultForTests() {
  if (usingPostgres) {
    // ⚠️ DELETE ไม่ใช่ TRUNCATE โดยเจตนา: role `drive_app` ถูกให้สิทธิ์แค่
    //    SELECT/INSERT/UPDATE/DELETE (ดู postgres/init/02-app-roles.sh) — TRUNCATE
    //    ต้องเป็นเจ้าของตารางหรือมีสิทธิ์ TRUNCATE ซึ่งแอปไม่มีและไม่ควรมี
    //    การใช้ DELETE ทำให้ชุดทดสอบทำงานภายใต้สิทธิ์ "เท่ากับแอปจริง" เป๊ะ
    //    ถ้าวันหนึ่งบรรทัดนี้ต้องการสิทธิ์มากกว่านั้น แปลว่าเทสต์กำลังโกง
    await query('DELETE FROM vault_blobs')
    await query('DELETE FROM vault_meta')
    return
  }
  memVaultMeta.clear()
  memVaultBlobs.length = 0
}

// ── Uploads — สถานะเข้ารหัส-at-rest ระหว่างนำเข้า NAS ─────────────────
export { sha256Hex }
