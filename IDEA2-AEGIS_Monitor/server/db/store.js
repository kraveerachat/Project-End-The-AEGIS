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
import { randomBytes, randomUUID } from 'node:crypto'
import { usingPostgres, query, withTransaction } from './connection.js'

// ⚠️ Phase 3: ตัวจำลอง detection/alert/clip แบบ in-memory (generator + seed arrays)
//    ถูก "ถอดออกทั้งหมด" แล้ว — ข้อมูลจริงมาจาก Detection Engine (Laptop, VLAN 20)
//    ที่ยิงเข้ามาทาง POST /internal/{detections,clips,alerts} แล้วเขียนลง Postgres
//    (ดู insertDetection/insertClip/insertAlert + routes/internal.js) ส่วน endpoint
//    ฝั่งเว็บ "อ่านอย่างเดียว" จากตารางจริง (listDetections/listAlerts/listClips ด้านล่าง)
//    — ไม่มีแถวสังเคราะห์ปนกับข้อมูลจริงอีกต่อไป

// ── Edge link — สถานะจริง คำนวณจาก "อายุของ heartbeat ล่าสุด" ─────────────────
// ⚠️ เดิมฟังก์ชันนี้คือตัวแปรจำนวนเต็มสองตัวในหน่วยความจำ + ปุ่มสาธิต: มันคืน
//    'online' ตลอดกาลไม่ว่า Detection Engine จะตายอยู่หรือไม่ (ไม่มีแหล่งข้อมูลเลย)
//    ตอนนี้ engine POST /internal/heartbeat เข้ามาเป็นระยะ แล้วเราตัดสินจากตาราง
//    camera_heartbeat จริง ๆ — engine เงียบเกิน LOST_AFTER_MS = lost ของจริง
const ONLINE_WITHIN_MS = 15_000   // heartbeat ใหม่กว่านี้ = online (interval ปกติ 5s)
const DEGRADED_WITHIN_MS = 45_000 // เกิน 15s แต่ยังไม่เกิน 45s = degraded (ขาดไป ~3-9 ครั้ง)

/** แปลงอายุ heartbeat (ms) → สถานะ; null/ไม่เคยมี = lost */
function statusFromAge(ageMs) {
  if (ageMs == null) return 'lost'
  if (ageMs <= ONLINE_WITHIN_MS) return 'online'
  if (ageMs <= DEGRADED_WITHIN_MS) return 'degraded'
  return 'lost'
}

// ── simulated outage — ยังมีอยู่ แต่ "ประกาศตัวว่าเป็นการซ้อม" ────────────────
// SOC-Responder เท่านั้น (requireRole ใน routes/api.js) ใช้แทนการเดินไปดึงสาย LAN
// ⚠️ ต่างจากของเดิมตรงที่ payload ติดธง simulated: true กลับไปด้วยเสมอ — จอที่แสดง
//    "lost" ระหว่างซ้อมจึงแยกออกได้จาก outage จริง ไม่ใช่การกุสถานะแล้วเงียบ
let simulatedOutageUntil = 0

export function toggleOutage() {
  const now = Date.now()
  if (simulatedOutageUntil > now) {
    simulatedOutageUntil = 0
    return { simulated: false }
  }
  simulatedOutageUntil = now + 60_000
  return { simulated: true, untilMs: simulatedOutageUntil }
}

export function simulatedOutageActive() {
  return simulatedOutageUntil > Date.now()
}

/** heartbeat ต่อกล้อง (เฉพาะกล้องที่ผู้เรียกเห็นได้) — ใช้โดย /api/link และ Diagnostics */
export async function listHeartbeats(visibleIds) {
  if (!usingPostgres) return []
  const ids = [...visibleIds]
  if (ids.length === 0) return []
  const { rows } = await query(
    `SELECT h.camera_id, c.name AS camera_name,
            EXTRACT(EPOCH FROM h.last_seen_at) * 1000 AS last_seen_ms,
            h.node_id, h.camera_connected, h.camera_reconnects,
            h.capture_fps, h.detect_fps, h.latency_ms, h.latency_ms_avg,
            h.uptime_s, h.frames_captured, h.segments_written,
            h.nas_last_status, h.nas_pending
       FROM camera_heartbeat h
       JOIN cameras c ON c.id = h.camera_id
      WHERE h.camera_id = ANY($1)`,
    [ids],
  )
  const now = Date.now()
  const num = (v) => (v == null ? null : Number(v))
  return rows.map((r) => {
    const lastSeenAt = Math.round(Number(r.last_seen_ms))
    const ageMs = now - lastSeenAt
    return {
      cam: r.camera_id,
      camName: r.camera_name,
      // กล้องที่ engine รายงานว่าเปิดไม่ได้ = offline ถึงแม้ heartbeat จะสด
      status: r.camera_connected ? statusFromAge(ageMs) : 'lost',
      lastSeenAt,
      ageMs,
      nodeId: r.node_id,
      cameraConnected: r.camera_connected,
      cameraReconnects: r.camera_reconnects,
      captureFps: num(r.capture_fps),
      detectFps: num(r.detect_fps),
      latencyMs: num(r.latency_ms),
      latencyMsAvg: num(r.latency_ms_avg),
      uptimeS: num(r.uptime_s),
      framesCaptured: num(r.frames_captured),
      segmentsWritten: r.segments_written,
      nasLastStatus: r.nas_last_status,
      nasPending: r.nas_pending,
    }
  })
}

/**
 * สถานะ Edge link รวมของ "ขอบเขตกล้องที่ผู้เรียกเห็น"
 * - ไม่มี heartbeat เลย (engine ไม่เคยยิงมา / ยังไม่ได้รัน) → lost + lastFrameAt = null
 * - มี → ใช้ heartbeat ที่ "สดที่สุด" เป็นตัวแทนว่าชั้น sensor ยังมีชีวิตไหม
 * คืน cameras[] ไปด้วยเพื่อให้ Diagnostics แสดงรายกล้องได้โดยไม่ต้องยิงซ้ำ
 */
export async function linkStatus(visibleIds) {
  const cameras = await listHeartbeats(visibleIds ?? [])
  const freshest = cameras.reduce(
    (best, c) => (best == null || c.lastSeenAt > best.lastSeenAt ? c : best),
    null,
  )
  const real = freshest ? statusFromAge(Date.now() - freshest.lastSeenAt) : 'lost'
  const simulated = simulatedOutageActive()
  return {
    status: simulated ? 'lost' : real,
    // lastFrameAt = heartbeat ล่าสุดจริง ๆ (null = ไม่เคยมี engine ยิงเข้ามาเลย)
    lastFrameAt: freshest ? freshest.lastSeenAt : null,
    simulated,
    // สถานะจริงใต้การซ้อม — จอไม่ต้องเดาว่าของจริงเป็นอย่างไรระหว่างซ้อม
    realStatus: real,
    cameras,
  }
}

/** เขียน heartbeat หนึ่งครั้งจาก Detection Engine (UPSERT — เก็บค่าล่าสุดเท่านั้น) */
export async function recordHeartbeat(input) {
  if (!usingPostgres) return { error: 'database unavailable', status: 503 }
  const cameraId = String(input?.cameraId ?? '').trim()
  if (!CAM_RE.test(cameraId)) return { error: 'invalid camera_id', status: 400 }
  if (!(await cameraExists(cameraId))) return { error: `unknown camera ${cameraId}`, status: 400 }

  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const intOrZero = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0)

  const { rows } = await query(
    `INSERT INTO camera_heartbeat (
        camera_id, last_seen_at, node_id, camera_connected, camera_reconnects,
        capture_fps, detect_fps, latency_ms, latency_ms_avg, uptime_s,
        frames_captured, segments_written, nas_last_status, nas_pending)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (camera_id) DO UPDATE SET
        last_seen_at = now(),
        node_id = EXCLUDED.node_id,
        camera_connected = EXCLUDED.camera_connected,
        camera_reconnects = EXCLUDED.camera_reconnects,
        capture_fps = EXCLUDED.capture_fps,
        detect_fps = EXCLUDED.detect_fps,
        latency_ms = EXCLUDED.latency_ms,
        latency_ms_avg = EXCLUDED.latency_ms_avg,
        uptime_s = EXCLUDED.uptime_s,
        frames_captured = EXCLUDED.frames_captured,
        segments_written = EXCLUDED.segments_written,
        nas_last_status = EXCLUDED.nas_last_status,
        nas_pending = EXCLUDED.nas_pending
     RETURNING EXTRACT(EPOCH FROM last_seen_at) * 1000 AS last_seen_ms`,
    [
      cameraId,
      input?.nodeId != null ? String(input.nodeId).slice(0, 120) : null,
      Boolean(input?.cameraConnected),
      intOrZero(input?.cameraReconnects),
      numOrNull(input?.captureFps),
      numOrNull(input?.detectFps),
      numOrNull(input?.latencyMs),
      numOrNull(input?.latencyMsAvg),
      numOrNull(input?.uptimeS),
      numOrNull(input?.framesCaptured),
      intOrZero(input?.segmentsWritten),
      input?.nasLastStatus != null ? String(input.nasLastStatus).slice(0, 32) : null,
      intOrZero(input?.nasPending),
    ],
  )
  return { cameraId, lastSeenAt: Math.round(Number(rows[0].last_seen_ms)) }
}

// ════ Detection Engine ingest — เขียนตารางจริง (ผ่าน POST /internal/*) ═══════
// ⚠️ Detection Engine ไม่ถือ credential ต่อ Postgres โดยตรง — โค้ดฝั่งนี้ (Node
//    backend ของ Monitor) เท่านั้นที่แตะฐาน aegis_monitor ตามหลัก trust boundary
//    เดียวกับทั้งโปรเจกต์ (ดู middleware/requireDetectionEngineKey.js)
const CAM_RE = /^CAM-\d+$/

async function cameraExists(id) {
  const { rows } = await query(`SELECT 1 FROM cameras WHERE id = $1`, [id])
  return rows.length > 0
}

/** เขียน detection หนึ่งเฟรม — หนึ่งแถวต่อ "คนหนึ่งคนในเฟรม" (แชร์ frame_id เดียวกัน)
 *  เฟรมที่มีหลายคน → หลายแถว = มองเห็น tailgating ได้ (ตรงกับ schema.sql)
 *  รับ entities จาก engine (status/name/confidence) — เก็บเฉพาะ Authorized/Unknown
 *  (NoFace ไม่ลงตาราง; result CHECK อนุญาตแค่สองค่านี้) */
export async function insertDetection(input) {
  if (!usingPostgres) return { error: 'database unavailable', status: 503 }
  const cameraId = String(input?.cameraId ?? '').trim()
  if (!CAM_RE.test(cameraId)) return { error: 'invalid camera_id', status: 400 }
  if (!(await cameraExists(cameraId))) return { error: `unknown camera ${cameraId}`, status: 400 }

  const frameId = String(input?.frameId || randomUUID()).slice(0, 128)
  let atIso = null
  if (input?.at != null) {
    const d = new Date(input.at)
    if (Number.isNaN(d.getTime())) return { error: 'invalid at timestamp', status: 400 }
    atIso = d.toISOString()
  }

  const entities = Array.isArray(input?.entities) ? input.entities : []
  const valid = entities
    .map((e) => ({
      result: e?.status === 'Unknown' ? 'Unknown' : e?.status === 'Authorized' ? 'Authorized' : null,
      name: e?.name != null ? String(e.name).slice(0, 120) : null,
      confidence: Number.isFinite(Number(e?.confidence)) ? Number(e.confidence) : null,
    }))
    .filter((e) => e.result !== null)
  if (valid.length === 0) return { error: 'no recognizable faces in payload', status: 400 }

  const faces = valid.length
  await withTransaction(async (client) => {
    for (const e of valid) {
      await client.query(
        `INSERT INTO detections (frame_id, at, camera_id, faces_in_frame, result, matched_name, confidence)
         VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7)`,
        // matched_name เป็น NULL เสมอเมื่อ Unknown (ไม่มีตัวตนให้จับคู่)
        [frameId, atIso, cameraId, faces, e.result, e.result === 'Unknown' ? null : e.name, e.confidence],
      )
    }
  })
  return { frameId, rows: faces }
}

/** เขียน clip หนึ่งช่วง — เรียกโดย nas_sync "หลัง" ยืนยัน sha256 บน NAS สำเร็จเท่านั้น
 *  ⚠️ stored_on_nas ต้องเป็น TRUE ก็ต่อเมื่อ verify ผ่านแล้ว — ห้ามตั้งแบบ optimistic
 *  (ผู้เรียกเดียวคือ nas_sync._finish_ok ซึ่งอยู่หลังด่าน verify) */
export async function insertClip(input) {
  if (!usingPostgres) return { error: 'database unavailable', status: 503 }
  const cameraId = String(input?.cameraId ?? '').trim()
  if (!CAM_RE.test(cameraId)) return { error: 'invalid camera_id', status: 400 }
  if (!(await cameraExists(cameraId))) return { error: `unknown camera ${cameraId}`, status: 400 }

  const filePath = String(input?.filePath ?? '').trim()
  if (!filePath) return { error: 'file_path required', status: 400 }
  const started = input?.startedAt ? new Date(input.startedAt) : null
  if (!started || Number.isNaN(started.getTime())) return { error: 'invalid started_at', status: 400 }
  const durationSec = Number.isFinite(Number(input?.durationSec)) ? Math.max(0, Math.round(Number(input.durationSec))) : 600
  const storedOnNas = Boolean(input?.storedOnNas)

  const { rows } = await query(
    `INSERT INTO clips (camera_id, started_at, duration_sec, file_path, stored_on_nas)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [cameraId, started.toISOString(), durationSec, filePath.slice(0, 1024), storedOnNas],
  )
  return { id: String(rows[0].id) }
}

/** เขียน alert หนึ่งรายการ — เรียกโดย alert_manager "หลัง" พยายามส่ง Telegram
 *  (สำเร็จหรือไม่ก็ persist เสมอ — บันทึกไม่หายแม้ Telegram ล่ม) */
export async function insertAlert(input) {
  if (!usingPostgres) return { error: 'database unavailable', status: 503 }
  const cameraId = String(input?.cameraId ?? '').trim()
  if (!CAM_RE.test(cameraId)) return { error: 'invalid camera_id', status: 400 }
  if (!(await cameraExists(cameraId))) return { error: `unknown camera ${cameraId}`, status: 400 }

  // severity ต้องเป็น 'amber' | 'red' เท่านั้น (schema CHECK) — engine map 'warning'→'amber' มาก่อนแล้ว
  const severity = input?.severity === 'red' ? 'red' : input?.severity === 'amber' ? 'amber' : null
  if (!severity) return { error: "severity must be 'amber' or 'red'", status: 400 }
  const type = String(input?.alertType ?? input?.type ?? 'unknown_face').slice(0, 64)
  const title = String(input?.title ?? 'Unknown person detected').slice(0, 200)
  const snapshotPath = input?.snapshotPath ? String(input.snapshotPath).slice(0, 1024) : null
  const telegramSent = Boolean(input?.telegramSent)

  const { rows } = await query(
    `INSERT INTO alerts (severity, type, title, camera_id, snapshot_path, telegram_sent, acked)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE) RETURNING id`,
    [severity, type, title, cameraId, snapshotPath, telegramSent],
  )
  return { id: String(rows[0].id) }
}

// ── queries (ทุกตัวรับ visibleIds — เซ็ตกล้องที่ "ผู้เรียกคนนี้" เห็นได้; กรองที่ SQL) ──
// ⚠️ อ่านจากตารางจริงใน Postgres เท่านั้น — dev fallback (ไม่มี DB) คืนลิสต์ว่าง
//    เพราะแหล่งข้อมูลเดียวคือ Detection Engine ที่เขียนผ่าน /internal/*

/** detections — จัดกลุ่มแถว (หนึ่งคน/แถว) กลับเป็นเฟรมที่มี people[] ตาม frame_id */
export async function listDetections(visibleIds, limit = 40) {
  if (!usingPostgres) return []
  const ids = [...visibleIds]
  if (ids.length === 0) return []
  const { rows } = await query(
    `SELECT frame_id, camera_id,
            EXTRACT(EPOCH FROM at) * 1000 AS at_ms,
            result, matched_name, confidence, synced_to_nas
       FROM detections
      WHERE camera_id = ANY($1)
      ORDER BY at DESC, id DESC
      LIMIT $2`,
    [ids, limit * 8], // over-fetch: หลายแถว = หนึ่งเฟรม แล้วค่อยตัดเป็น limit เฟรม
  )
  const byFrame = new Map()
  for (const r of rows) {
    let f = byFrame.get(r.frame_id)
    if (!f) {
      if (byFrame.size >= limit) continue
      f = { id: r.frame_id, at: Math.round(Number(r.at_ms)), cam: r.camera_id, people: [], syncedToNas: r.synced_to_nas }
      byFrame.set(r.frame_id, f)
    }
    f.people.push({
      k: r.result === 'Unknown' ? 'unk' : 'auth',
      name: r.matched_name,
      conf: r.confidence == null ? null : Math.round(Number(r.confidence)),
    })
    f.syncedToNas = f.syncedToNas && r.synced_to_nas
  }
  return [...byFrame.values()]
}

/** alerts — คืน display_name ของผู้ ack (JOIN users) ให้ ackedBy เป็นชื่อ ไม่ใช่ id */
export async function listAlerts(visibleIds, limit = 15) {
  if (!usingPostgres) return []
  const ids = [...visibleIds]
  if (ids.length === 0) return []
  const { rows } = await query(
    `SELECT a.id, EXTRACT(EPOCH FROM a.at) * 1000 AS at_ms,
            a.severity, a.type, a.title, a.camera_id,
            a.snapshot_path, a.telegram_sent, a.acked, u.display_name AS acked_by
       FROM alerts a
       LEFT JOIN users u ON u.id = a.acked_by
      WHERE a.camera_id = ANY($1)
      ORDER BY a.at DESC
      LIMIT $2`,
    [ids, limit],
  )
  return rows.map((r) => ({
    id: String(r.id),
    at: Math.round(Number(r.at_ms)),
    sev: r.severity,
    type: r.type,
    title: r.title,
    cam: r.camera_id,
    snapshotPath: r.snapshot_path,
    telegramSent: r.telegram_sent,
    acked: r.acked,
    ackedBy: r.acked_by ?? null,
  }))
}

/** ack — การเขียนเดียวที่ console มี; เก็บ acked_by เป็น user id (FK) */
export async function ackAlert(id, user) {
  if (!usingPostgres) return null
  if (!/^\d+$/.test(String(id))) return null
  const { rows } = await query(
    `UPDATE alerts SET acked = TRUE, acked_by = $1, acked_at = now()
      WHERE id = $2 AND acked = FALSE
      RETURNING id`,
    [user.id, id],
  )
  if (rows.length > 0) return { id: String(rows[0].id) }
  // ไม่มีแถวที่อัปเดต — อาจ ack ไปแล้ว (idempotent) หรือ id ไม่มีจริง
  const { rows: exist } = await query(`SELECT 1 FROM alerts WHERE id = $1`, [id])
  return exist.length ? { id: String(id) } : null
}

// ── clips — option A: ไม่มี segs (engine ไม่ผลิต segment-level heat) และไม่มี live clip
//    คลิปโผล่เฉพาะที่ finalize + verified บน NAS แล้ว (nas_sync เขียนหลัง verify)
//    kind ('auth'|'unknown') ได้จากการเช็คว่ามี detection ผล 'Unknown' ในช่วงเวลาคลิปไหม
export async function listClips(visibleIds) {
  if (!usingPostgres) return []
  const ids = [...visibleIds]
  if (ids.length === 0) return []
  const { rows } = await query(
    `SELECT c.id, c.camera_id,
            EXTRACT(EPOCH FROM c.started_at) * 1000 AS start_ms,
            c.duration_sec, c.stored_on_nas,
            EXISTS (
              SELECT 1 FROM detections d
               WHERE d.camera_id = c.camera_id
                 AND d.result = 'Unknown'
                 AND d.at >= c.started_at
                 AND d.at < c.started_at + make_interval(secs => c.duration_sec)
            ) AS has_unknown
       FROM clips c
      WHERE c.camera_id = ANY($1)
      ORDER BY c.started_at DESC
      LIMIT 60`,
    [ids],
  )
  return rows.map((r) => ({
    id: String(r.id),
    cam: r.camera_id,
    kind: r.has_unknown ? 'unknown' : 'auth',
    live: false,
    start: Math.round(Number(r.start_ms)),
    durationSec: r.duration_sec,
    storedOnNas: r.stored_on_nas,
    segs: [], // option A: ไม่มี segment-level heat จาก engine
  }))
}

// ── operators + camera_assignment (SOC จัดการผ่านวิว Operators) ─────────
// ผู้เรียกฝั่งเว็บ: วิว Operators (src/views/Operators.jsx) — ตาราง operator +
// ตัวแก้ assignment ซึ่งเป็นผู้เรียกเดียวของ PUT /api/assignments → assignCameras()
// และวิว Nodes ที่แสดง route ต่อกล้อง (GET /api/nodes)
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

// ── Operator provisioning — SINGLE canonical implementation (web path) ──────
// ⚠️ นี่คือ "แหล่งความจริงเดียว" ของการสร้าง operator ฝั่งเว็บ ทั้ง POST /api/operators
//    เรียกฟังก์ชันนี้ตัวเดียว ไม่มีตรรกะ provisioning ซ้ำที่อื่นในโค้ด Node
//
//    CLI (server/cli/manage_users.py, Python) เป็นเส้นทาง SSH แยกต่างหากโดยเจตนา
//    — คนละภาษา แชร์ object ฟังก์ชันเดียวกันไม่ได้ จึงบังคับให้ "ผลลัพธ์เท่ากัน"
//    (row shape + constraint เดียวกัน) ด้วยค่าคงที่ชุดเดียวกันด้านล่าง แล้วพิสูจน์
//    ความเท่ากันด้วย docs/auth-test.md §13.5 (เทียบแถวจากทั้งสองเส้นทางตรง ๆ)
//    — ค่าคงที่พวกนี้ต้องตรงกับ manage_users.py: USERNAME_RE / BCRYPT_COST / min-len
export const USERNAME_RE = /^[a-z][a-z0-9._-]{2,39}$/ // = CLI USERNAME_RE เป๊ะ
export const BCRYPT_COST = 12                          // = CLI BCRYPT_COST เป๊ะ
const TEMP_PASSWORD_BYTES = 18 // base64url ~24 อักขระ: > ขั้นต่ำ 12, < 72 ไบต์ (เพดาน bcrypt)

/** รหัสผ่านชั่วคราวสุ่มฝั่งเซิร์ฟเวอร์ — URL-safe, ไม่มีอักขระ shell-meta */
function generateTempPassword() {
  return randomBytes(TEMP_PASSWORD_BYTES).toString('base64url')
}

/** ตรวจ input ให้ตรงกฎเดียวกับ CLI — คืน { error, detail } หรือค่าที่ normalize แล้ว */
function validateOperatorInput({ username, displayName, role, cameraIds }) {
  const uname = String(username ?? '').trim().toLowerCase()
  if (!USERNAME_RE.test(uname)) {
    return { error: 'invalid', detail: 'username must be lowercase, start with a letter, and use only a-z 0-9 . _ - (3-40 chars)' }
  }
  const dname = (String(displayName ?? '').trim()) || uname // ฟอร์มเว็บเก็บแค่ username → ใช้เป็น display_name
  if (dname.length > 80) return { error: 'invalid', detail: 'display name must be at most 80 characters' }
  const r = role ?? 'CCTV-Operator'
  if (!['CCTV-Operator', 'SOC-Responder'].includes(r)) return { error: 'invalid', detail: 'invalid role' }
  const cams = Array.isArray(cameraIds) ? [...new Set(cameraIds.map((c) => String(c)))] : []
  return { uname, dname, role: r, cams }
}

// Postgres path — atomic: ตรวจ username ซ้ำ + กล้องมีจริง + กล้องว่าง แล้วค่อย
// insert user + camera_assignment ใน transaction เดียว (พังกลางทาง = ไม่เหลือ user กำพร้า)
async function pgProvisionOperator(input) {
  const v = validateOperatorInput(input)
  if (v.error) return v
  const { uname, dname, role, cams } = v
  const tempPassword = generateTempPassword()
  const passwordHash = bcrypt.hashSync(tempPassword, BCRYPT_COST)

  return withTransaction(async (client) => {
    const dup = await client.query('SELECT 1 FROM users WHERE lower(username) = $1', [uname])
    if (dup.rows.length) return { error: 'username_taken' }

    if (cams.length) {
      const found = await client.query('SELECT id FROM cameras WHERE id = ANY($1)', [cams])
      const foundIds = new Set(found.rows.map((r) => r.id))
      const missing = cams.filter((c) => !foundIds.has(c))
      if (missing.length) return { error: 'unknown_camera', cameraId: missing[0] }

      // "taken" = แถวที่ถูกผูกกับ user แล้ว (user_id NOT NULL) — เหมือนกฎ CLI เป๊ะ
      // (WHERE user_id IS NOT NULL) กล้องที่เป็น SOC-Team route (user_id NULL) หรือ
      // ยังไม่มีแถวเลย ถือว่า "ว่าง" มอบหมายทับได้
      const taken = await client.query(
        'SELECT camera_id FROM camera_assignment WHERE camera_id = ANY($1) AND user_id IS NOT NULL',
        [cams],
      )
      if (taken.rows.length) return { error: 'camera_taken', cameraId: taken.rows[0].camera_id }
    }

    const ins = await client.query(
      `INSERT INTO users (username, password_hash, role, display_name, active, must_reset_password)
       VALUES ($1, $2, $3, $4, TRUE, TRUE)
       RETURNING id, display_name AS name, role, active`,
      [uname, passwordHash, role, dname],
    )
    const user = ins.rows[0]

    for (const camId of cams) {
      await client.query(
        `INSERT INTO camera_assignment (camera_id, user_id, assigned_at)
         VALUES ($1, $2, now())
         ON CONFLICT (camera_id) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_at = now()`,
        [camId, user.id],
      )
    }

    return {
      operator: { id: String(user.id), name: user.name, role: user.role, active: user.active },
      tempPassword,
      mustResetPassword: true,
    }
  })
}

// dev fallback (ไม่มี DATABASE_URL) — mirror ตรรกะเดียวกันบน store ในหน่วยความจำ
// (บัญชีที่สร้างในโหมดนี้ยังล็อกอินไม่ได้ เพราะ DEV_USERS ใน connection.js นิ่ง —
//  เป็นข้อจำกัดของ dev mode เท่านั้น การทดสอบ login จริงรันบน Postgres, ดู §13.4)
function memProvisionOperator(input) {
  const v = validateOperatorInput(input)
  if (v.error) return v
  const { uname, dname, role, cams } = v

  const id = 'op-' + uname.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  if (operators.some((o) => o.id === id)) return { error: 'username_taken' }
  for (const cam of cams) {
    if (!assignments.has(cam)) return { error: 'unknown_camera', cameraId: cam }
    const cur = assignments.get(cam)
    if (cur && cur !== 'SOC') return { error: 'camera_taken', cameraId: cam }
  }

  const tempPassword = generateTempPassword()
  operators.push({ id, name: dname, role, active: true })
  for (const cam of cams) assignments.set(cam, id)
  return { operator: { id, name: dname, role, active: true }, tempPassword, mustResetPassword: true }
}

/**
 * สร้าง operator หนึ่งบัญชี + ผูกกล้อง (0..N) แบบ atomic แล้วคืนรหัสผ่านชั่วคราว
 * "ครั้งเดียว" ให้ผู้เรียก — ไม่ log, ไม่เก็บ plaintext ที่ใด (ผู้เรียกต้องส่งต่อ out-of-band)
 * คืน { operator, tempPassword, mustResetPassword } เมื่อสำเร็จ, หรือ
 *     { error: 'invalid'|'username_taken'|'unknown_camera'|'camera_taken', ... } เมื่อไม่สำเร็จ
 */
export async function provisionOperator(input) {
  if (usingPostgres) return pgProvisionOperator(input)
  return memProvisionOperator(input)
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
