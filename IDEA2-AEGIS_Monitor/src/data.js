// src/data.js — AEGIS Monitor (IDEA2) · display helpers เท่านั้น
//
// ⚠️ Phase 2: ข้อมูลจำลองทั้งหมด (กล้อง/operator/detection/alert/clip seeds และ
// ตัว generator) ถูก "ถอนออกจาก client" แล้ว — ทุกแถวบนจอมาจาก /api/* ของ
// เซิร์ฟเวอร์ Monitor (ซึ่ง production อ่านจากตารางที่ Detection Engine เขียน)
// ไฟล์นี้เหลือเฉพาะ formatter + ตัวช่วยแสดงผลที่ไม่ใช่ข้อมูล

export const camShort = (id) => 'C' + String(id).slice(4)

export function ini(n) {
  return String(n ?? '').split(/[ .-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase()
}

export const hasUnk = (d) => d.people.some((p) => p.k === 'unk')
export const isTail = (d) => hasUnk(d) && d.people.some((p) => p.k === 'auth')

export function eventText(d) {
  if (isTail(d)) return 'Unknown person — AI focus elevated'
  if (hasUnk(d)) return 'Unknown person — clip saved'
  const names = d.people.map((p) => p.name).join(', ')
  return `Authorized — ${names}`
}

// ── Hero-feed overlay geometry ───────────────────────────────────────
// พิกัด bounding-box บนจอ hero/tile เป็น "ฉากประกอบของ feed จำลอง" (แผง hatch
// แทนสตรีมที่เดโม่ยังไม่มีจริง — DESIGN.md: hatch = สิ่งที่ระบบมองไม่เห็น)
// เมื่อ WebRTC/RTSP จริงมาถึง overlay นี้ถูกแทนด้วย bbox telemetry จาก engine
export const HERO_SCENES = {
  'CAM-02': {
    aiFocus: true,
    boxes: [
      { kind: 'auth', label: 'AUTH // J. SMITH // 98%', top: '30%', left: '14%', width: '22%', height: '56%' },
      { kind: 'unk', label: 'UNKNOWN PERSON // 82%', top: '24%', left: '58%', width: '24%', height: '62%' },
    ],
    subjects: 2,
  },
  'CAM-01': {
    boxes: [{ kind: 'auth', label: 'AUTH // SOMCHAI T. // 98%', top: '32%', left: '30%', width: '24%', height: '52%' }],
    subjects: 1,
  },
  'CAM-05': {
    boxes: [{ kind: 'auth', label: 'AUTH // A. OKAFOR // 95%', top: '28%', left: '38%', width: '22%', height: '56%' }],
    subjects: 1,
  },
  'CAM-04': { boxes: [], subjects: 0 },
  'CAM-06': { boxes: [], subjects: 0 },
}

export const TILE_BOXES = {
  'CAM-01': [{ kind: 'auth', top: '32%', left: '30%', width: '24%', height: '52%' }],
  'CAM-02': [
    { kind: 'auth', top: '30%', left: '14%', width: '22%', height: '56%' },
    { kind: 'unk', top: '24%', left: '58%', width: '24%', height: '62%' },
  ],
  'CAM-05': [{ kind: 'auth', top: '28%', left: '38%', width: '22%', height: '56%' }],
  'CAM-04': [],
  'CAM-06': [],
}

/* ---------- formatting ---------- */

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-GB')
export const fmtHM = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export function fmtDate(ms) {
  const d = new Date(ms)
  return `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${MO[d.getMonth()]} ${d.getFullYear()}`
}

export function fmtDur(totalSec) {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
