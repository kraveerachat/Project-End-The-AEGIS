// server/db/store.js — AEGIS Drive (IDEA1) · แหล่งข้อมูลของ Application Layer
//
// ⚠️ Mock data ถูก "ถอนออกจาก client bundle ทั้งหมด" (Phase 2) — จอทุกจอเรียก API จริง
//    ข้อมูลเดโม่ย้ายมาอยู่ "ฝั่งเซิร์ฟเวอร์" ที่นี่แทน:
//    - โหมด PostgreSQL: files/shares/audit/users อ่าน-เขียนตารางจริง (Phase 3 ต่อท่อครบ)
//    - โหมด dev fallback (ไม่มี DATABASE_URL): ชุดข้อมูลด้านล่างทำหน้าที่เป็น "DB จำลอง
//      ในหน่วยความจำ" — โครงสร้าง/รูปร่างเหมือนแถวจากตารางจริงทุกประการ
//    - ข้อมูลระดับระบบ (RAID/disk/backup) มาจาก OS จริงใน production (smartctl/mdadm)
//      — จุดต่อถูก mark ไว้; ระหว่างนี้เสิร์ฟค่าอ้างอิงจากที่นี่
//
// ⚠️ ทุกฟังก์ชันในไฟล์นี้ถูกเรียก "หลัง" requireAuth/requireRole เสมอ — ห้าม route ใด
//    เรียกตรงโดยไม่ผ่าน middleware ตรวจสิทธิ์ (ดู routes/api.js)
import { sha256Hex, usingPostgres, query } from './connection.js'

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
async function pgListFiles() {
  const { rows } = await query(
    `SELECT f.*, u.display_name AS uploader_name
       FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.vault = false
      ORDER BY f.modified_at DESC`,
  )
  return rows.map(mapFileRow)
}

async function pgFindFile(id) {
  if (!/^\d+$/.test(String(id))) return null // id ไม่ใช่ BIGSERIAL ที่ถูกต้อง — ไม่มีทางเจอ ไม่ใช่ error
  const { rows } = await query(
    `SELECT f.*, u.display_name AS uploader_name
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

export async function listFiles() {
  if (usingPostgres) return pgListFiles()
  return files.filter((f) => !f.vault)
}

export async function findFile(id) {
  if (usingPostgres) return pgFindFile(id)
  return files.find((f) => f.id === id) ?? null
}

export async function deleteFile(id) {
  if (usingPostgres) return pgDeleteFile(id)
  const i = files.findIndex((f) => f.id === id)
  if (i === -1) return false
  files.splice(i, 1)
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

// ── Shares — VLAN-aware secure links ─────────────────────────────────
const shares = [
  { id: 's1', fileId: 'f08', fileName: 'supplier-audit_checklist_th.xlsx', createdBy: 'Somchai P.', authType: 'password', scope: 'vlan', scopeCidrs: ['192.168.10.0/24'], hits: 4, revoked: false, expiresAt: BOOT + 5 * HOUR + 12 * MIN },
  { id: 's2', fileId: 'f09', fileName: 'product-photos_launch-set.tar.gz', createdBy: 'Nattaporn W.', authType: 'otc', scope: 'any', scopeCidrs: [], hits: 17, revoked: false, expiresAt: BOOT + 22 * HOUR },
  { id: 's3', fileId: 'f02', fileName: 'network-topology_edge-site-A.pdf', createdBy: 'Veerachat J.', authType: 'password', scope: 'subnet', scopeCidrs: ['192.168.30.0/24'], hits: 2, revoked: false, expiresAt: BOOT + 41 * MIN },
]

const EXPIRY_MS = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
const SCOPE_CIDRS = { vlan: ['192.168.10.0/24'], subnet: ['192.168.30.0/24'], any: [] }

function mapShareRow(r) {
  return {
    id: String(r.id), fileId: String(r.file_id), fileName: r.file_name,
    createdBy: r.created_by_name ?? 'system', authType: r.auth_type, scope: r.scope,
    scopeCidrs: r.vlan_scope, hits: r.hits, revoked: r.revoked,
    expiresAt: new Date(r.expires_at).getTime(),
  }
}

async function pgListShares() {
  const { rows } = await query(
    `SELECT s.*, f.name AS file_name, u.display_name AS created_by_name
       FROM shares s
       JOIN files f ON f.id = s.file_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.revoked = false
      ORDER BY s.created_at DESC`,
  )
  return rows.map(mapShareRow)
}

async function pgCreateShare({ fileId, expiry, authType, scope }, user) {
  if (!/^\d+$/.test(String(fileId))) return null
  const { rows: fileRows } = await query(`SELECT id, name, vault FROM files WHERE id = $1`, [fileId])
  const file = fileRows[0]
  if (!file || file.vault) return null
  if (!EXPIRY_MS[expiry] || !['password', 'otc', 'none'].includes(authType) || !SCOPE_CIDRS[scope]) return null
  const expiresAt = new Date(Date.now() + EXPIRY_MS[expiry])
  const { rows } = await query(
    `INSERT INTO shares (file_id, created_by, auth_type, scope, vlan_scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [fileId, user.id, authType, scope, SCOPE_CIDRS[scope], expiresAt],
  )
  return mapShareRow({ ...rows[0], file_name: file.name, created_by_name: user.displayName })
}

async function pgRevokeShare(id) {
  if (!/^\d+$/.test(String(id))) return false
  const { rowCount } = await query(`UPDATE shares SET revoked = true WHERE id = $1`, [id])
  return rowCount > 0
}

export async function listShares() {
  if (usingPostgres) return pgListShares()
  return shares.filter((s) => !s.revoked)
}

export async function createShare({ fileId, expiry, authType, scope }, user) {
  if (usingPostgres) return pgCreateShare({ fileId, expiry, authType, scope }, user)
  const file = files.find((f) => f.id === fileId)
  if (!file || file.vault) return null // แชร์ไฟล์ vault ไม่ได้ — server อ่าน ciphertext ไม่ออก
  if (!EXPIRY_MS[expiry] || !['password', 'otc', 'none'].includes(authType) || !SCOPE_CIDRS[scope]) return null
  const row = {
    id: nextId('s'), fileId, fileName: file.name, createdBy: user.displayName,
    authType, scope, scopeCidrs: SCOPE_CIDRS[scope], hits: 0, revoked: false,
    expiresAt: Date.now() + EXPIRY_MS[expiry],
  }
  shares.unshift(row)
  return row
}

export async function revokeShare(id) {
  if (usingPostgres) return pgRevokeShare(id)
  const s = shares.find((x) => x.id === id)
  if (!s) return false
  s.revoked = true
  return true
}

// ── Snapshots ────────────────────────────────────────────────────────
const snapshots = [
  { id: 'snap-0093', time: BOOT - 6 * HOUR, deltaGB: 2.4, verified: true, destroyed: false },
  { id: 'snap-0092', time: BOOT - 12 * HOUR, deltaGB: 0.8, verified: true, destroyed: false },
  { id: 'snap-0091', time: BOOT - 18 * HOUR, deltaGB: 1.1, verified: true, destroyed: false },
  { id: 'snap-0090', time: BOOT - 24 * HOUR, deltaGB: 3.8, verified: true, destroyed: false },
  { id: 'snap-0089', time: BOOT - 2 * DAY, deltaGB: 0.9, verified: true, destroyed: false },
  { id: 'snap-0088', time: BOOT - 3 * DAY, deltaGB: 5.2, verified: true, destroyed: false },
  { id: 'snap-0087', time: BOOT - 4 * DAY, deltaGB: 1.7, verified: false, destroyed: false },
  { id: 'snap-0086', time: BOOT - 5 * DAY, deltaGB: 2.9, verified: true, destroyed: false },
]

export function listSnapshots() {
  return snapshots
}

/** rollback: snapshot ใหม่กว่าเป้าหมายถูกทำลาย — คืน { lostGB } หรือ null */
export function rollbackTo(id) {
  const target = snapshots.find((s) => s.id === id && !s.destroyed)
  if (!target) return null
  let lostGB = 0
  for (const s of snapshots) {
    if (s.time > target.time && !s.destroyed) {
      s.destroyed = true
      lostGB += s.deltaGB
    }
  }
  return { lostGB: Math.round(lostGB * 10) / 10, restoredId: id }
}

// ── Storage & Backup (production: อ่านจาก smartctl / mdadm / cron จริง) ──
export function storageStatus() {
  return {
    capacity: [
      { key: 'docs', gb: 128 },
      { key: 'archives', gb: 74 },
      { key: 'media', gb: 96 },
      { key: 'vaultSeg', gb: 44 },
      { key: 'free', gb: 682 },
    ],
    disks: [
      { id: 'sda', model: 'WD Red Pro 4TB', serial: 'WD-WX32DA8L7K4N', capacityTB: 4, usedTB: 1.62, temp: 38, smart: 'PASSED', hours: 14_208 },
      { id: 'sdb', model: 'WD Red Pro 4TB', serial: 'WD-WX32DA8L2C9F', capacityTB: 4, usedTB: 1.62, temp: 41, smart: 'PASSED', hours: 14_205 },
    ],
    backups: [
      { id: 'b1', job: 'Nightly incremental', target: 'edge-site-B /backup', freq: 'daily', lastRun: BOOT - 9 * HOUR, status: 'ok', nextRun: BOOT + 15 * HOUR },
      { id: 'b2', job: 'Vault ciphertext replica', target: 'offsite-tape LTO-9', freq: 'weekly', lastRun: BOOT - 3 * DAY, status: 'ok', nextRun: BOOT + 4 * DAY },
      { id: 'b3', job: 'PostgreSQL WAL archive', target: 'edge-site-B /pgwal', freq: 'hourly', lastRun: BOOT - 32 * MIN, status: 'ok', nextRun: BOOT + 28 * MIN },
    ],
  }
}

// ── Encryption keys & network zones (Admin governance) ────────────────
// production: อ่านจาก KMS/HSM จริงและตาราง firewall_zone (Phase 3)
const encryptionKeys = {
  algorithm: 'AES-256-GCM',
  keyId: 'aegis-drive-master-2026-06',
  rotatedAt: BOOT - 31 * DAY,
  rotationDays: 90,
}

export function keysStatus() {
  return encryptionKeys
}

export function rotateKeys() {
  encryptionKeys.rotatedAt = Date.now()
  encryptionKeys.keyId = `aegis-drive-master-${new Date(encryptionKeys.rotatedAt).toISOString().slice(0, 7)}`
  return encryptionKeys
}

const networkZones = [
  { id: 'z1', name: 'zoneCompany', cidr: '192.168.20.0/23', tone: 'accent' },
  { id: 'z2', name: 'zoneGuest', cidr: '192.168.30.0/24', tone: 'neutral' },
  { id: 'z3', name: 'Management', cidr: '10.10.0.0/28', tone: 'violet' },
]

export function listNetworkZones() {
  return networkZones
}

const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/

export function addNetworkZone({ name, cidr }) {
  const safeName = String(name ?? '').trim().slice(0, 60)
  if (!safeName || !CIDR_RE.test(String(cidr ?? ''))) return null
  if (networkZones.some((z) => z.cidr === cidr)) return null
  const row = { id: nextId('z'), name: safeName, cidr, tone: 'neutral' }
  networkZones.push(row)
  return row
}

export function removeNetworkZone(id) {
  const i = networkZones.findIndex((z) => z.id === id)
  if (i === -1) return false
  networkZones.splice(i, 1)
  return true
}

// ── Dashboard ────────────────────────────────────────────────────────
// files/shares come from the real Metadata Layer now (Postgres when
// configured); transfer7d stays illustrative — real throughput is an OS/NIC
// metric this app doesn't have a source for yet (pre-hardware).
export async function dashboard() {
  const fileList = await listFiles()
  const shareList = await listShares()
  const totalBytes = fileList.reduce((s, f) => s + f.size, 0)
  return {
    metrics: {
      storageGB: Math.round((342 + totalBytes / 1e12) * 10) / 10,
      storageTotalGB: 1024,
      files: fileList.length,
      activeShares: shareList.length,
    },
    transfer7d: [
      { day: 'Tue', up: 42, down: 118, projected: false },
      { day: 'Wed', up: 61, down: 95, projected: false },
      { day: 'Thu', up: 38, down: 134, projected: false },
      { day: 'Fri', up: 74, down: 156, projected: false },
      { day: 'Sat', up: 12, down: 31, projected: false },
      { day: 'Sun', up: 45, down: 88, projected: true },
      { day: 'Mon', up: 68, down: 142, projected: true },
    ],
    recentFiles: fileList.slice(0, 5).map((f) => ({ id: f.id, name: f.name, modified: f.modified })),
  }
}

// ── Users & sessions (Admin governance) ──────────────────────────────
// production: อ่านจากตาราง users + session store จริง (Phase 3)
const demoUsers = [
  { id: 'u1', name: 'Veerachat J.', username: 'admin', role: 'Admin', status: 'active', lastLogin: BOOT - 10 * MIN, sessions: 1 },
  { id: 'u2', name: 'Kanya Srisuwan', username: 'user', role: 'DataLake-User', status: 'active', lastLogin: BOOT - 25 * MIN, sessions: 1 },
  { id: 'u3', name: 'Somchai P.', username: 'somchai.p', role: 'DataLake-User', status: 'active', lastLogin: BOOT - 2 * HOUR, sessions: 0 },
  { id: 'u4', name: 'Nattaporn W.', username: 'nattaporn.w', role: 'DataLake-User', status: 'suspended', lastLogin: BOOT - 3 * DAY, sessions: 0 },
]

export function listUsers() {
  return demoUsers
}

export function createUser({ name, username, role }) {
  if (!name || !username || !['Admin', 'DataLake-User'].includes(role)) return null
  const row = {
    id: nextId('u'), name: String(name).slice(0, 80), username: String(username).slice(0, 40).toLowerCase(),
    role, status: 'active', lastLogin: null, sessions: 0,
  }
  demoUsers.push(row)
  return row
}

export function listSessions(username) {
  // เซสชันของ "ผู้ใช้ปัจจุบัน" เท่านั้น — ไม่มีทางเห็นของคนอื่นจาก endpoint นี้
  return [
    { id: 'se1', device: 'This browser', ip: '—', lastActive: Date.now(), current: true, username },
  ]
}

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
