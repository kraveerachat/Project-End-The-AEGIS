// src/data.js — AEGIS Monitor (IDEA2) · display helpers เท่านั้น
//
// ⚠️ แก้คอมเมนต์ 2026-07-27: หัวไฟล์เดิมประกาศว่า "ข้อมูลจำลองทั้งหมดถูกถอนออกจาก
//    client แล้ว — ทุกแถวบนจอมาจาก /api/*" ซึ่ง **ไม่จริง** ตอนที่เขียน: ใต้บรรทัดนั้น
//    ลงมามี HERO_SCENES/TILE_BOXES ที่ฝัง "ชื่อคน + เปอร์เซ็นต์ความมั่นใจ" ที่กุขึ้นเอง
//    (J. SMITH 98%, SOMCHAI T. 98%, A. OKAFOR 95%, UNKNOWN 82%) แล้ววาดทับจอ hero
//    ทุกครั้งที่เลือกกล้องนั้น — ไม่เกี่ยวกับ detection จริงเลยสักนิด
//    ทั้งสองค่าถูกลบทิ้งแล้ว และหัวไฟล์นี้ถูกแก้ให้ตรงความจริง
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
