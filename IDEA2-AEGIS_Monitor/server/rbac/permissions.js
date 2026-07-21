// server/rbac/permissions.js — AEGIS Monitor (IDEA2)
// ⚠️ Authorization ทั้งหมดอยู่ที่นี่ — ฝั่งเซิร์ฟเวอร์เท่านั้น
// ห้ามรับค่า role จาก client — server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
//
// AEGIS Monitor เป็น "แอปเดียว สองมุมมอง":
//   SOC-Responder → Aggregate View (ทุกกล้อง + detection stream + alerts + จัดการ operator)
//   CCTV-Operator → Scoped View  (เฉพาะกล้องตาม camera_assignment)
export const ROLES = Object.freeze({
  SOC: 'SOC-Responder',
  OPERATOR: 'CCTV-Operator',
})

const ALL_ROLES = new Set(Object.values(ROLES))

export function isValidRole(role) {
  return ALL_ROLES.has(role)
}

// ── View registry — แหล่งความจริงว่า role ไหนเห็นเมนู/วิวอะไร ────────────────
// ⚠️ วิวที่ role ไม่มีสิทธิ์ "ไม่ถูกใส่ลง payload เลย" — ไม่ใช่ส่งแล้วซ่อนด้วย CSS
//    ดู page source ในฐานะ CCTV-Operator ต้องไม่พบสตริง "Detection stream" หรือ
//    "Alerts" แม้แต่ครั้งเดียว (ข้อบังคับของสเปก: absent from DOM, not hidden)
//
// 'scoped' บอก client ว่าวิวนั้นต้อง render แบบจำกัดกล้อง — แต่การกรองจริง
// เกิดที่ endpoint ข้อมูล (ผ่าน camera_assignment) เสมอ ไม่ใช่ที่ flag นี้
const VIEW_REGISTRY = [
  { id: 'live',        labelKey: 'navLive',        group: 'navObservation', roles: [ROLES.SOC, ROLES.OPERATOR] },
  { id: 'archive',     labelKey: 'navArchive',     group: 'navObservation', roles: [ROLES.SOC, ROLES.OPERATOR] },
  { id: 'detection',   labelKey: 'navDetection',   group: 'navAnalytics',   roles: [ROLES.SOC] },
  { id: 'alerts',      labelKey: 'navAlerts',      group: 'navAnalytics',   roles: [ROLES.SOC] },
  { id: 'nodes',       labelKey: 'navNodes',       group: 'navInfra',       roles: [ROLES.SOC] },
  // Operators = UI จัดการตาราง camera_assignment ของ IDEA2 เอง — SOC-Responder เท่านั้น
  { id: 'operators',   labelKey: 'navOperators',   group: 'navInfra',       roles: [ROLES.SOC] },
  // diagnostics = จอสุขภาพกล้องของ Scoped View (สเปกของ CCTV-Operator)
  { id: 'diagnostics', labelKey: 'navDiagnostics', group: 'navInfra',       roles: [ROLES.OPERATOR] },
  { id: 'settings',    labelKey: 'navSettings',    group: 'navPrefs',       roles: [ROLES.SOC, ROLES.OPERATOR] },
]

/**
 * เมนูของ role — filter "ก่อน" ส่งออกเสมอ; default-deny คืน []
 * ไม่รั่ว field `roles` ออกไปฝั่ง client
 */
export function getMenuForRole(role) {
  if (!isValidRole(role)) return []
  return VIEW_REGISTRY
    .filter((v) => v.roles.includes(role))
    .map(({ id, labelKey, group }) => ({ id, labelKey, group }))
}

/** view id ที่ role นี้เปิดได้ — ใช้ตรวจซ้ำฝั่ง endpoint (ไม่เชื่อ client) */
export function canOpenView(role, viewId) {
  return VIEW_REGISTRY.some((v) => v.id === viewId && v.roles.includes(role))
}
