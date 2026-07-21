// server/rbac/permissions.js — AEGIS Drive (IDEA1)
// ⚠️ Authorization ทั้งหมดอยู่ที่นี่ — ฝั่งเซิร์ฟเวอร์เท่านั้น
// ห้ามรับค่า role จาก client — server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
//
// Drive มีสอง role เท่านั้น และทั้งสองมีความสามารถจัดการไฟล์ "เท่ากัน"
// (upload/download/share) — Admin ได้เพิ่มเฉพาะจอ governance (Audit / Access)
export const ROLES = Object.freeze({
  ADMIN: 'Admin',
  USER: 'DataLake-User',
})

const ALL_ROLES = new Set(Object.values(ROLES))

/** role ที่เซิร์ฟเวอร์ยอมรับเท่านั้น — อย่างอื่น = ปฏิเสธ (default-deny) */
export function isValidRole(role) {
  return ALL_ROLES.has(role)
}

// ── Navigation registry — แหล่งความจริงว่าแต่ละ role เห็นเมนูอะไร ─────────────
// labelKey/icon/group ตรงกับ i18n + Sidebar ฝั่ง client — เซิร์ฟเวอร์ส่งเฉพาะ
// "รายการที่อนุญาต" แล้ว client แค่ .map() สิ่งที่ได้รับ
//
// ⚠️ เมนูที่ role ไม่มีสิทธิ์ "ไม่ถูกใส่ลง payload เลย" — ไม่ใช่ส่งไปแล้วซ่อน
// เมนูที่ไม่มีสิทธิ์ต้องไม่ถูก render ลง DOM เลย ไม่ใช่แค่ซ่อนด้วย CSS
// (ดู source ของหน้าในฐานะ DataLake-User ต้องไม่พบสตริง "Audit" แม้แต่ครั้งเดียว)
const NAV_REGISTRY = [
  { id: 'dashboard', icon: 'gauge',     labelKey: 'navDashboard', group: 'navGroupWorkspace',  roles: [ROLES.USER, ROLES.ADMIN] },
  { id: 'files',     icon: 'folder',    labelKey: 'navFiles',     group: 'navGroupWorkspace',  roles: [ROLES.USER, ROLES.ADMIN] },
  { id: 'vault',     icon: 'vault',     labelKey: 'navVault',     group: 'navGroupWorkspace',  roles: [ROLES.USER, ROLES.ADMIN] },
  { id: 'uploads',   icon: 'upload',    labelKey: 'navUploads',   group: 'navGroupWorkspace',  roles: [ROLES.USER, ROLES.ADMIN] },
  { id: 'shares',    icon: 'link',      labelKey: 'navShares',    group: 'navGroupProtection', roles: [ROLES.USER, ROLES.ADMIN] },
  { id: 'snapshots', icon: 'history',   labelKey: 'navSnapshots', group: 'navGroupProtection', roles: [ROLES.USER, ROLES.ADMIN] },
  { id: 'storage',   icon: 'harddrive', labelKey: 'navStorage',   group: 'navGroupProtection', roles: [ROLES.USER, ROLES.ADMIN] },
  // Admin-only governance — role อื่นต้องไม่พบร่องรอยใน DOM เลยแม้แต่ตัวอักษรเดียว
  { id: 'audit',     icon: 'scroll',    labelKey: 'navAudit',     group: 'navGroupAdmin',      roles: [ROLES.ADMIN] },
  { id: 'access',    icon: 'usercog',   labelKey: 'navAccess',    group: 'navGroupAdmin',      roles: [ROLES.ADMIN] },
]

/**
 * เมนูของ role หนึ่ง ๆ — filter "ก่อน" ส่งออกเสมอ
 * default-deny: role แปลก / null / undefined → [] (ไม่ใช่ชุดของ user)
 * ไม่รั่ว field `roles` ออกไปฝั่ง client
 * @param {string | null | undefined} role
 */
export function getNavForRole(role) {
  if (!isValidRole(role)) return [] // default-deny — "เผื่อใจให้ผ่าน" คือจุดเริ่มของ A01
  return NAV_REGISTRY
    .filter((item) => item.roles.includes(role))
    .map(({ id, icon, labelKey, group }) => ({ id, icon, labelKey, group }))
}
