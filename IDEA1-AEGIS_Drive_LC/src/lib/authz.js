// src/lib/authz.js — AEGIS Drive (IDEA1)
// ⚠️ เมนู/สิทธิ์ทั้งหมดถูกตัดสิน "ฝั่งเซิร์ฟเวอร์" แล้ว (server/rbac/permissions.js)
// client ได้รับเมนูที่ filter ตาม role มากับ /api/login และ /api/me — แล้วแค่ render
// สิ่งที่ได้รับ รายการที่ไม่มีสิทธิ์ "ไม่เคยถูกส่งมาถึง client เลย" จึงไม่มีอยู่ใน DOM
// (ไม่ใช่ render แล้วซ่อนด้วย CSS — Information Disclosure)
//
// ไฟล์นี้เหลือแค่ helper แสดงผลเล็ก ๆ ที่ไม่ใช่ security control:
// backend ตรวจ role ซ้ำทุก request เสมอ — ค่าที่นี่ใช้จัด layout เท่านั้น

export const ROLE_ADMIN = 'Admin'
export const ROLE_USER = 'DataLake-User'

/** ใช้เลือก "แสดง" กลุ่มตั้งค่า Admin — ตัว endpoint จริงมี requireRole ครอบเสมอ */
export function canAdministrate(role) {
  return role === ROLE_ADMIN
}
