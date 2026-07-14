// Role → navigation resolution. Exactly two roles exist in this application:
// 'admin' and 'datalake-user'. (CCTV-Operator / SOC-Responder belong to AEGIS
// Monitor — a different app with its own decoupled identity store. They must
// never appear here.)
//
// ⚠️ UX AFFORDANCE ONLY — ไม่ใช่ security control
// ฟังก์ชันนี้ซ่อนเมนูที่ user ไม่มีสิทธิ์ใช้ เพื่อ UX เท่านั้น
// ในระบบจริง backend ต้อง re-authorize ทุก request เสมอ
// client-side check ถูก bypass ได้ทันทีถ้า attacker ไม่รัน JS ของเรา
//
// สำคัญ: รายการที่ไม่มีสิทธิ์ต้อง "ไม่ถูก render ลง DOM เลย" — ไม่ใช่ซ่อนด้วย
// CSS ไม่ใช่ disabled — เพื่อกัน Information Disclosure: แค่เผยว่ามีเมนู
// "Audit Log" อยู่ ก็เท่ากับบอกผู้โจมตีว่ามีเป้าหมายอะไรให้ล่า
// ให้ filter array นี้ "ก่อน" ถึง .map() ที่ render เสมอ

export const ROLE_ADMIN = 'admin'
export const ROLE_USER = 'datalake-user'

/**
 * @typedef {{ id: string, icon: string, labelKey: string, group: string, roles: string[] }} NavItem
 */

/** @type {NavItem[]} */
const NAV_ITEMS = [
  { id: 'dashboard', icon: 'gauge', labelKey: 'navDashboard', group: 'navGroupWorkspace', roles: [ROLE_USER, ROLE_ADMIN] },
  { id: 'files', icon: 'folder', labelKey: 'navFiles', group: 'navGroupWorkspace', roles: [ROLE_USER, ROLE_ADMIN] },
  { id: 'vault', icon: 'vault', labelKey: 'navVault', group: 'navGroupWorkspace', roles: [ROLE_USER, ROLE_ADMIN] },
  { id: 'uploads', icon: 'upload', labelKey: 'navUploads', group: 'navGroupWorkspace', roles: [ROLE_USER, ROLE_ADMIN] },
  { id: 'shares', icon: 'link', labelKey: 'navShares', group: 'navGroupProtection', roles: [ROLE_USER, ROLE_ADMIN] },
  { id: 'snapshots', icon: 'history', labelKey: 'navSnapshots', group: 'navGroupProtection', roles: [ROLE_USER, ROLE_ADMIN] },
  { id: 'storage', icon: 'harddrive', labelKey: 'navStorage', group: 'navGroupProtection', roles: [ROLE_USER, ROLE_ADMIN] },
  // Admin-only back-office. ผู้ใช้ role อื่นต้องไม่พบ "ร่องรอย" ของสองรายการนี้
  // ใน DOM เลยแม้แต่ตัวอักษรเดียว (ดู getNavForRole ด้านล่าง)
  { id: 'audit', icon: 'scroll', labelKey: 'navAudit', group: 'navGroupAdmin', roles: [ROLE_ADMIN] },
  { id: 'access', icon: 'usercog', labelKey: 'navAccess', group: 'navGroupAdmin', roles: [ROLE_ADMIN] },
]

/**
 * Single source of truth for what a role can see.
 * default-deny: role ที่ไม่รู้จัก / null / undefined → คืนเมนูว่าง ไม่ใช่ชุดของ user
 * เพราะ "เผื่อใจให้ผ่าน" คือจุดเริ่มของ Broken Access Control
 *
 * @param {string | null | undefined} role
 * @returns {NavItem[]}
 */
export function getNavForRole(role) {
  if (role !== ROLE_USER && role !== ROLE_ADMIN) return [] // default-deny
  return NAV_ITEMS.filter((item) => item.roles.includes(role))
}

/** Settings groups follow the same rule — filtered BEFORE render, never hidden with CSS. */
export function canAdministrate(role) {
  return role === ROLE_ADMIN
}
