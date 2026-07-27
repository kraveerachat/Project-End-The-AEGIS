// src/data.js — AEGIS Monitor (IDEA2) · display helpers เท่านั้น
//
// ⚠️ แก้คอมเมนต์ 2026-07-27: หัวไฟล์เดิมประกาศว่า "ข้อมูลจำลองทั้งหมดถูกถอนออกจาก
//    client แล้ว — ทุกแถวบนจอมาจาก /api/*" ซึ่ง **ไม่จริง** ตอนที่เขียน: ใต้บรรทัดนั้น
//    ลงมามี HERO_SCENES/TILE_BOXES ที่ฝัง "ชื่อคน + เปอร์เซ็นต์ความมั่นใจ" ที่กุขึ้นเอง
//    (J. SMITH 98%, SOMCHAI T. 98%, A. OKAFOR 95%, UNKNOWN 82%) แล้ววาดทับจอ hero
//    ทุกครั้งที่เลือกกล้องนั้น — ไม่เกี่ยวกับ detection จริงเลยสักนิด
//    ทั้งสองค่าถูกลบทิ้งแล้ว (ดู bboxesFor ด้านล่าง) และหัวไฟล์นี้ถูกแก้ให้ตรงความจริง
//
// ตอนนี้ทุกแถว/ทุกกล่องบนจอมาจาก /api/* ของเซิร์ฟเวอร์ Monitor จริง ๆ
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

// ── Hero-feed overlay ────────────────────────────────────────────────
// ⚠️ HERO_SCENES / TILE_BOXES ถูก "ลบทิ้ง" แล้ว — มันคือชื่อคนและคะแนนความมั่นใจ
//    ที่กุขึ้นมาทั้งหมด ผูกกับ camera id ตายตัว ไม่ได้มาจาก detection ใด ๆ
//    ผู้ตรวจที่มองจอ hero จะอ่านว่า "ระบบจำหน้า J. SMITH ได้ 98%" ทั้งที่ระบบ
//    ไม่เคยเห็นใครเลย — นั่นคือการกุหลักฐานด้านความปลอดภัย ไม่ใช่ placeholder
//
// แทนที่ด้วยกล่องที่ "มาจากของจริงเท่านั้น": bboxesFor() อ่านจาก detection
// ล่าสุดจริงของกล้องนั้น (GET /api/detections ← ตาราง detections ← engine)
// ⚠️ ตำแหน่ง/ขนาดกล่องยังไม่ใช่ของจริง — schema `detections` ยังไม่มีคอลัมน์ bbox
//    (engine คำนวณ bbox ได้แล้วแต่ยังไม่ได้ส่ง) จึงจัดวางเป็นแถวเท่า ๆ กันเพื่อ
//    "นับจำนวนคนในเฟรม" ให้ตรงความจริง ไม่ได้อ้างว่าคนอยู่ตรงนั้นจริง
//    ป้ายกำกับแสดงได้แค่ผลที่ engine ให้มาจริง: UNKNOWN (+ % ถ้ามี) หรือชื่อที่จับคู่ได้
//    ตอนนี้ PlaceholderRecognizer คืน Unknown เสมอ → ป้ายจึงเป็น UNKNOWN เสมอ ถูกต้องแล้ว
const BOX_SLOTS = [
  { top: '26%', left: '12%', width: '20%', height: '58%' },
  { top: '26%', left: '40%', width: '20%', height: '58%' },
  { top: '26%', left: '68%', width: '20%', height: '58%' },
]

/**
 * กล่องสำหรับ overlay จาก detection frame จริงหนึ่งเฟรม (หรือ null = ไม่มีอะไรให้วาด)
 * คืน [] เมื่อไม่มี detection — จอจะว่าง ซึ่งคือความจริง ไม่ใช่ฉากที่แต่งไว้
 */
export function bboxesFor(frame) {
  if (!frame?.people?.length) return []
  return frame.people.slice(0, BOX_SLOTS.length).map((p, i) => ({
    kind: p.k === 'unk' ? 'unk' : 'auth',
    // ป้าย = ผลจริงเท่านั้น; ไม่มี conf ก็ไม่แสดงตัวเลข (ไม่เติมให้ดูสมบูรณ์)
    label: p.k === 'unk'
      ? (p.conf == null ? 'UNKNOWN' : `UNKNOWN // ${p.conf}%`)
      : `${String(p.name ?? 'AUTHORIZED').toUpperCase()}${p.conf == null ? '' : ` // ${p.conf}%`}`,
    ...BOX_SLOTS[i],
  }))
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
