// server/db/store.js — AEGIS Monitor (IDEA2) · แหล่งข้อมูลของ console
//
// ⚠️ Phase 2: ตัวจำลอง Edge-link + detection ที่เคยรัน "ในเบราว์เซอร์" (src/engine.js
//    + src/data.js เดิม) ถูกถอนออกจาก client ทั้งหมด — ย้ายมาอยู่ฝั่งเซิร์ฟเวอร์ที่นี่
//    ในฐานะ "ตัวแทนชั่วคราวของ Detection Engine" (Laptop, VLAN 20):
//    - production: Detection Engine เขียนตาราง detections/alerts/clips ผ่าน LAN
//      แล้ว endpoint อ่านจาก PostgreSQL — โครง JSON ตรงกันทุก field (Phase 3 ต่อท่อ)
//    - dev fallback: generator ด้านล่างเขียนลง store ในหน่วยความจำแทน engine จริง
//    เว็บแอป "อ่านอย่างเดียว" เหมือนเดิมทุกประการ — ไม่มีการเปิดกล้อง/inference ที่นี่
//
// ⚠️ ข้อมูลทุกคำขอถูกกรองตาม camera_assignment ฝั่งเซิร์ฟเวอร์ (ดู routes/api.js)
//    — ห้ามเชื่อ filter จาก client

import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { usingPostgres, query } from './connection.js'

const BOOT = Date.now()
const MIN = 60_000

let seq = 0
const nextId = (p) => `${p}-${++seq}`

// ── people helpers (PDPA scope: ชื่อ+ความมั่นใจเท่านั้น — ไม่มีตำแหน่ง/รหัสพนักงาน) ──
const A = (name, conf) => ({ k: 'auth', name, conf })
const U = (conf) => ({ k: 'unk', name: null, conf })

const AUTH_POOL = [
  ['Somchai T.', 98], ['J. Park', 97], ['A. Okafor', 95], ['L. Tan', 94],
  ['M. Reyes', 96], ['J. Smith', 98], ['K. Wong', 93], ['P. Anong', 95],
]
const EMIT_CAMS = ['CAM-01', 'CAM-05', 'CAM-06', 'CAM-04', 'CAM-02']
const rand = (n) => Math.floor(Math.random() * n)

// ── detections — หนึ่ง frame มี people[] (หลายคน = tailgating มองเห็นได้) ──
const detections = []
function pushDetection(offMs, cam, people) {
  detections.unshift({
    id: nextId('det'), at: Date.now() - offMs, cam, people,
    syncedToNas: true,
  })
  if (detections.length > 60) detections.pop()
}
// seed ชุดแรก — ซีน tailgating ที่ CAM-02 คือเฟรมล่าสุด
pushDetection(780_000, 'CAM-05', [A('A. Okafor', 99)])
pushDetection(570_000, 'CAM-01', [U(64)])
pushDetection(360_000, 'CAM-01', [A('L. Tan', 96), A('J. Park', 93)])
pushDetection(270_000, 'CAM-04', [U(71)])
pushDetection(98_000, 'CAM-05', [A('A. Okafor', 95)])
pushDetection(23_000, 'CAM-01', [A('Somchai T.', 98)])
pushDetection(8_000, 'CAM-02', [A('J. Smith', 98), U(82)])

const hasUnk = (d) => d.people.some((p) => p.k === 'unk')

// ── alerts ───────────────────────────────────────────────────────────
const alerts = [
  { id: nextId('al'), at: BOOT - 8_000, sev: 'red', type: 'Critical · intrusion', title: 'Repeated unknown-access attempts', cam: 'CAM-02', telegramSent: true, acked: false, ackedBy: null },
  { id: nextId('al'), at: BOOT - 270_000, sev: 'amber', type: 'Warning · unknown person', title: 'Unknown person detected', cam: 'CAM-04', telegramSent: true, acked: false, ackedBy: null },
  { id: nextId('al'), at: BOOT - 570_000, sev: 'amber', type: 'Warning · unknown person', title: 'Unknown person detected', cam: 'CAM-01', telegramSent: true, acked: false, ackedBy: null },
]

// ── generator — ตัวแทน Detection Engine (dev เท่านั้น; production = engine เขียน DB) ──
setInterval(() => {
  if (outageUntil > Date.now()) return // link ล่ม = ไม่มีเฟรมใหม่เข้ามา
  const cam = EMIT_CAMS[rand(EMIT_CAMS.length)]
  const pick = () => { const [n, c] = AUTH_POOL[rand(AUTH_POOL.length)]; return A(n, c - rand(6)) }
  const r = Math.random()
  let people
  if (r < 0.14) people = [U(55 + rand(35))]
  else if (r < 0.22) {
    const a = pick(); let b = pick()
    while (b.name === a.name) b = pick()
    people = [a, b]
  } else people = [pick()]
  pushDetection(0, cam, people)
  const d = detections[0]
  if (hasUnk(d) && !alerts.some((x) => !x.acked && x.cam === d.cam)) {
    alerts.unshift({
      id: nextId('al'), at: d.at, sev: 'amber',
      type: 'Warning · unknown person', title: 'Unknown person detected',
      cam: d.cam, telegramSent: true, acked: false, ackedBy: null,
    })
    if (alerts.length > 15) alerts.pop()
  }
}, 25_000).unref?.()

// ── Edge link — heartbeat state ที่เว็บแอปอ่าน (จริง: มาจาก engine heartbeat) ──
let outageUntil = 0
let outageStarted = 0

export function linkStatus() {
  const now = Date.now()
  if (outageUntil > now) {
    // ช่วงแรกของ outage = degraded แล้วค่อย lost — cascade เดียวกับ heartbeat จริง
    const status = now - outageStarted < 6_000 ? 'degraded' : 'lost'
    return { status, lastFrameAt: outageStarted }
  }
  return { status: 'online', lastFrameAt: now }
}

/** demo control: จำลอง link ล่ม 60 วิ (แทนการดึงสาย LAN ให้ผู้ตรวจดู cascade) */
export function toggleOutage() {
  const now = Date.now()
  if (outageUntil > now) {
    outageUntil = 0
    return { status: 'online' }
  }
  outageStarted = now
  outageUntil = now + 60_000
  return { status: 'degraded' }
}

// ── queries (ทุกตัวรับ visibleIds — เซ็ตกล้องที่ "ผู้เรียกคนนี้" เห็นได้) ──────
export function listDetections(visibleIds, limit = 40) {
  return detections.filter((d) => visibleIds.has(d.cam)).slice(0, limit)
}

export function listAlerts(visibleIds, limit = 15) {
  return alerts.filter((a) => visibleIds.has(a.cam)).slice(0, limit)
}

export function ackAlert(id, username) {
  const a = alerts.find((x) => x.id === id)
  if (!a) return null
  a.acked = true
  a.ackedBy = username
  a.ackedAt = Date.now()
  return a
}

// ── clips — interval-based ~10 นาที (ไม่ใช่ detection-triggered) ─────────
const TEN_MIN = 10 * 60 * 1000
const SEG = (k, w) => ({ k, w })
const CLIP_SPECS = [
  { cam: 'CAM-02', slot: 1, kind: 'unknown', segs: [SEG('ok', 44), SEG('warn', 14), SEG('ok', 42)] },
  { cam: 'CAM-01', slot: 2, kind: 'auth', segs: [SEG('ok', 100)] },
  { cam: 'CAM-04', slot: 2, kind: 'unknown', segs: [SEG('ok', 20), SEG('warn', 22), SEG('ok', 58)] },
  { cam: 'CAM-05', slot: 3, kind: 'auth', segs: [SEG('ok', 100)] },
  { cam: 'CAM-06', slot: 3, kind: 'auth', segs: [SEG('ok', 100)] },
  { cam: 'CAM-02', slot: 4, kind: 'unknown', segs: [SEG('ok', 66), SEG('warn', 10), SEG('ok', 24)] },
]

export function listClips(visibleIds) {
  const now = Date.now()
  const boundary = Math.floor(now / TEN_MIN) * TEN_MIN
  const elapsed = Math.max(1, Math.round((now - boundary) / 1000))
  const pct = Math.min(97, Math.max(3, (elapsed / 600) * 100))
  const live = {
    id: 'clip-live', cam: 'CAM-02', kind: 'unknown', live: true,
    start: boundary, durationSec: elapsed, storedOnNas: false,
    segs: pct > 8 ? [SEG('ok', pct - 5), SEG('warn', 3), SEG('rec', 2)] : [SEG('rec', pct)],
  }
  const done = CLIP_SPECS.map((s, i) => ({
    id: 'clip-' + i, cam: s.cam, kind: s.kind, live: false,
    start: boundary - s.slot * TEN_MIN, durationSec: 600, storedOnNas: true,
    segs: s.segs,
  }))
  return [live, ...done].filter((c) => visibleIds.has(c.cam))
}

// ── operators + camera_assignment (SOC จัดการผ่านวิว Operators) ─────────
const operators = [
  { id: 'op-reyes', name: 'M. Reyes', role: 'CCTV-Operator', active: true },
  { id: 'op-nakamura', name: 'T. Nakamura', role: 'CCTV-Operator', active: true },
  { id: 'op-lee', name: 'K. Lee', role: 'CCTV-Operator', active: true },
  { id: 'op-lim', name: 'S. Lim', role: 'CCTV-Operator', active: false },
  { id: 'op-okafor', name: 'A. Okafor', role: 'SOC-Responder', active: true },
]

// camera_id → operatorId | 'SOC' | null — mirror ของตาราง camera_assignment
// ⚠️ บัญชีล็อกอิน 'operator'  (user id 2 ใน connection.js) คือ op-reyes    → CAM-05
// ⚠️ บัญชีล็อกอิน 'operator2' (user id 3 ใน connection.js) คือ op-nakamura → CAM-06
//    สองแถวนี้ mirror seed.sql ตรง ๆ เพื่อให้ dev fallback พิสูจน์ Scoped View ได้
//    เหมือนโหมด Postgres เป๊ะ ๆ (operator A ต้องไม่เห็นกล้องของ operator B)
const assignments = new Map([
  ['CAM-01', 'op-lee'],
  ['CAM-02', 'SOC'],
  ['CAM-03', 'op-lim'],
  ['CAM-04', null],
  ['CAM-05', 'op-reyes'],
  ['CAM-06', 'op-nakamura'],
])

// ── Postgres-backed operators + camera_assignment ───────────────────────
// "operators" here means every AEGIS Monitor account (SOC-Responder AND
// CCTV-Operator) — the users table, not a role-filtered subset.
async function pgListOperators() {
  const { rows } = await query(
    `SELECT id, display_name AS name, role, active FROM users ORDER BY display_name`,
  )
  return rows.map((r) => ({ id: String(r.id), name: r.name, role: r.role, active: r.active }))
}

// camera_assignment row present with user_id = NULL → explicit SOC-Team route;
// no row at all → unassigned. Both read the same today (routeFor treats them
// alike) but the distinction is kept so the Access UI can tell them apart.
async function pgListAssignments() {
  const { rows: camRows } = await query(`SELECT id FROM cameras ORDER BY id`)
  const { rows: asgRows } = await query(`SELECT camera_id, user_id FROM camera_assignment`)
  const byCam = new Map(asgRows.map((r) => [r.camera_id, r.user_id]))
  const out = {}
  for (const c of camRows) {
    if (!byCam.has(c.id)) { out[c.id] = null; continue }
    const uid = byCam.get(c.id)
    out[c.id] = uid == null ? 'SOC' : String(uid)
  }
  return out
}

async function pgAddOperator({ name, role }) {
  if (!name || !['CCTV-Operator', 'SOC-Responder'].includes(role)) return null
  const safeName = String(name).slice(0, 80)
  const base = safeName.toLowerCase().replace(/[^a-z0-9.]+/g, '.').replace(/(^\.+|\.+$)/g, '') || 'operator'
  let username = base
  for (let n = 2; ; n += 1) {
    const { rows } = await query(`SELECT 1 FROM users WHERE lower(username) = $1`, [username])
    if (rows.length === 0) break
    username = `${base}${n}`
  }
  // demo add-operator flow has no invite/reset-password step yet — issue a random
  // temp password (never returned to the client) so the account isn't unusable
  const tempPasswordHash = bcrypt.hashSync(randomBytes(18).toString('base64url'), 10)
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role, display_name, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id, display_name AS name, role, active`,
    [username, tempPasswordHash, role, safeName],
  )
  const r = rows[0]
  return { id: String(r.id), name: r.name, role: r.role, active: r.active }
}

/** มอบหมายกล้องชุดใหม่ให้ operator (แทนที่ของเดิมของคน ๆ นั้น) — 6 กล้องเดโม่ ไม่ต้อง batch/transaction */
async function pgAssignCameras(opId, camIds) {
  if (!Array.isArray(camIds)) return false
  const isSoc = opId === 'SOC'
  if (!isSoc) {
    if (!/^\d+$/.test(String(opId))) return false
    const { rows } = await query(`SELECT 1 FROM users WHERE id = $1`, [opId])
    if (rows.length === 0) return false
  }
  const { rows: camRows } = await query(`SELECT id FROM cameras`)
  const userIdValue = isSoc ? null : opId
  for (const { id: camId } of camRows) {
    if (camIds.includes(camId)) {
      await query(
        `INSERT INTO camera_assignment (camera_id, user_id) VALUES ($1, $2)
         ON CONFLICT (camera_id) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_at = now()`,
        [camId, userIdValue],
      )
      continue
    }
    const { rows: curRows } = await query(`SELECT user_id FROM camera_assignment WHERE camera_id = $1`, [camId])
    if (curRows.length === 0) continue
    const current = curRows[0].user_id
    const currentMatchesOp = isSoc ? current === null : current !== null && String(current) === String(opId)
    if (currentMatchesOp) await query(`DELETE FROM camera_assignment WHERE camera_id = $1`, [camId])
  }
  return true
}

export async function listOperators() {
  if (usingPostgres) return pgListOperators()
  return operators
}

export async function listAssignments() {
  if (usingPostgres) return pgListAssignments()
  return Object.fromEntries(assignments)
}

export async function addOperator({ name, role }) {
  if (usingPostgres) return pgAddOperator({ name, role })
  if (!name || !['CCTV-Operator', 'SOC-Responder'].includes(role)) return null
  const base = 'op-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const id = operators.some((o) => o.id === base) ? base + '-' + Date.now() : base
  const row = { id, name: String(name).slice(0, 80), role, active: true }
  operators.push(row)
  return row
}

export async function assignCameras(opId, camIds) {
  if (usingPostgres) return pgAssignCameras(opId, camIds)
  if (!operators.some((o) => o.id === opId) && opId !== 'SOC') return false
  if (!Array.isArray(camIds)) return false
  for (const camId of assignments.keys()) {
    if (camIds.includes(camId)) assignments.set(camId, opId)
    else if (assignments.get(camId) === opId) assignments.set(camId, null)
  }
  return true
}

/** เส้นทาง alert ของกล้อง — default-deny: ไม่มีคนรับ/ถูกระงับ → SOC-Team.
 *  Pure/sync on purpose: callers that resolve routes for many cameras at once
 *  (alerts, nodes) fetch `assignments` + `operators` ONCE and reuse them here,
 *  instead of one query per camera. */
export function resolveRoute(camId, assignmentsMap, operatorsById) {
  const v = assignmentsMap[camId]
  if (!v || v === 'SOC') return 'SOC-Team'
  const op = operatorsById.get(String(v))
  return op && op.active ? op.name : 'SOC-Team'
}

/** ใช้โดย connection.js (dev fallback): user id → เซ็ตกล้องที่มองเห็น */
export function camerasForUserId(userId) {
  // mapping ระหว่างบัญชีล็อกอิน dev ↔ operator record (production: JOIN ตาราง users)
  // ยังอ่านจาก `assignments` (ไม่ hardcode รายชื่อกล้อง) — แก้ assignment ในวิว Operators
  // แล้วมีผลกับ Scoped View ทันที เหมือน DB จริง
  const DEV_USER_TO_OPERATOR = { 2: 'op-reyes', 3: 'op-nakamura' }
  const opId = DEV_USER_TO_OPERATOR[userId] ?? null
  const out = new Set()
  for (const [cam, v] of assignments) {
    if (v === opId && opId) out.add(cam)
  }
  return out
}
