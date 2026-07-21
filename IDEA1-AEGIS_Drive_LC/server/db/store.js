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

/** แถวจากตาราง files (+ JOIN users) → รูปทรงที่ Files.jsx คาดหวัง */
function mapFileRow(r) {
  const { ext, type } = typeExtFromName(r.name)
  return {
    id: String(r.id), name: r.name, type, ext, size: Number(r.size_bytes),
    modified: new Date(r.modified_at).getTime(), uploader: r.uploader_name ?? 'system',
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

async function pgRecordUpload({ name, size, sha256, user }) {
  const safeName = String(name).slice(0, 200)
  const { rows } = await query(
    `INSERT INTO files (name, path, size_bytes, sha256, vault, verified, uploaded_by)
     VALUES ($1, $2, $3, $4, false, true, $5) RETURNING *`,
    [safeName, `/datalake/uploads/${safeName}`, Number(size) || 0, sha256 ?? null, user.id],
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
    modified: Date.now(), uploader: user.displayName, vault: false, verified: true,
    sha256: null, path: `/datalake/${safe}`,
  }
  files.unshift(row)
  return row
}

/** บันทึก metadata ของไฟล์ที่อัปโหลดเสร็จ (ตัวไฟล์จริงอยู่ Storage Layer) */
export async function recordUpload({ name, size, sha256, user }) {
  if (usingPostgres) return pgRecordUpload({ name, size, sha256, user })
  const row = {
    id: nextId('f'), name: String(name).slice(0, 200), type: 'File',
    ext: String(name).split('.').pop() ?? '', size: Number(size) || 0,
    modified: Date.now(), uploader: user.displayName, vault: false, verified: true,
    sha256: sha256 ?? null, path: `/datalake/uploads/${name}`,
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
// เข้ารหัสฝั่ง client เท่านั้น — server เก็บได้แค่ ciphertext ที่อ่านไม่ออก แม้แต่ Admin ก็เปิดไม่ได้
// seed ด้านล่างถูกสร้าง "ออฟไลน์" ด้วย passphrase เดโม่ (aegis-vault-demo) ผ่าน
// PBKDF2-600k + AES-256-GCM — เซิร์ฟเวอร์ไม่เคยเห็น passphrase/plaintext
// (สคริปต์สร้าง seed ไม่อยู่ใน repo ของเซิร์ฟเวอร์โดยเจตนา)
const vault = {
  saltB64: 'e3IhOTXjiVnXA3P//I88kQ==',
  iterations: 600_000,
  // verifier: blob เล็ก ๆ ที่ client ใช้พิสูจน์ว่า passphrase ถูก (GCM auth ล้มเหลว = ผิด)
  verifier: {
    ivB64: 'n9Fmc5irBNEx6RpL',
    dataB64: 'pIm+SSrUFslXsPZjkhoIoHgTxTyPnUgjWzekgz8tsH2dP9SSElRL2u6jwgbkCM8=',
  },
  blobs: [
    { id: 'vb1', ivB64: 'emPBdBz++ixZtOQN', dataB64: '8+T9tKcVmxrYU49LLeZUODBGwcsacpWQNvHYyMUW+DTHiS2z1F5ZKLTkB6UBHd5XuTsvnwnMT8atny+QNYFjvhLCkj+iVa2/2w==', size: 812454, createdAt: BOOT - 8 * HOUR },
    { id: 'vb2', ivB64: 'uZNbUEDoQcQHLPn3', dataB64: 'Naysutw0pKyCp3lkuv9Y0nv5LQGcIaa1AwNXTg+jWZ7pVhak/SfWAxQ2Bks6ZDrVX7Uos8VYD+z8OLzpbvMJDKAAa5OkDQ==', size: 1204337, createdAt: BOOT - 2 * DAY },
    { id: 'vb3', ivB64: 'gmgJfyG9Ey4Rtd5/', dataB64: 'fFgxqFz7wqf9+OTfp2Z/xoRGRQVRWmn5CnYihCFT0heBZxDVvAjhMOpT5ERf3lDCbOYk0AaaA5pmETYF7V5F4HfqYdqVly9197lhrB0=', size: 6231882, createdAt: BOOT - 4 * DAY },
  ],
}

export function vaultMeta() {
  // ส่งทุกอย่างที่ client ต้องใช้ปลดล็อก — ไม่มีชิ้นไหนเป็นความลับ (salt/iv เปิดเผยได้,
  // ciphertext ไร้กุญแจคือ noise) และไม่มีทางที่ server จะช่วยถอดได้
  return vault
}

const B64_RE = /^[A-Za-z0-9+/]+=*$/

export function addVaultBlob({ ivB64, dataB64, size }) {
  // validate รูปแบบ + เพดานขนาด (เดโม่ 2MB ciphertext) — server ไม่แตะเนื้อหา
  if (typeof ivB64 !== 'string' || typeof dataB64 !== 'string') return null
  if (!B64_RE.test(ivB64) || !B64_RE.test(dataB64)) return null
  if (dataB64.length > 3_000_000) return null
  const row = { id: nextId('vb'), ivB64, dataB64, size: Number(size) || 0, createdAt: Date.now() }
  vault.blobs.push(row)
  return row
}

// ── Uploads — สถานะเข้ารหัส-at-rest ระหว่างนำเข้า NAS ─────────────────
export { sha256Hex }
