// src/lib/sessionEnded.js — AEGIS Drive (IDEA1) · PR #157 Task 5.4 · "เซสชันจบแล้ว" — ผู้ฟังฝั่ง client
//
// ทำไมต้องมีโมดูลเล็ก ๆ นี้: api.js (401 / PASSWORD_RESET_REQUIRED) และ auth.js (logout) คือผู้รู้ว่าเซสชันจบ
// ส่วนจอ Vault คือผู้ที่ต้อง "ทิ้งทุกอย่างที่ถอดรหัสไว้" ทันทีที่มันจบ (purgeUnlockedVaultState) — ถ้าให้ api.js
// import Vault หรือให้ auth.js import api.js ย้อนกลับจะเกิดวงจร import โมดูลนี้จึงไม่ import อะไรเลย
// ⚠️ ไม่มี state ใดเกี่ยวกับตัวตนผู้ใช้ที่นี่ — มีแค่รายชื่อ listener ในหน่วยความจำ

export const SESSION_END_REASONS = Object.freeze({ LOGOUT: 'LOGOUT', SESSION_INVALIDATED: 'SESSION_INVALIDATED' })

const listeners = new Set()

/** ลงทะเบียนผู้ฟัง → คืนฟังก์ชันถอน */
export function onSessionEnded(listener) {
  if (typeof listener !== 'function') throw new TypeError('onSessionEnded: listener must be a function')
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** แจ้งทุกผู้ฟัง (ข้อผิดพลาดของผู้ฟังหนึ่งไม่กันผู้ฟังอื่น) */
export function notifySessionEnded(reason = SESSION_END_REASONS.SESSION_INVALIDATED) {
  for (const fn of [...listeners]) {
    try { fn(reason) } catch { /* ผู้ฟังพัง ≠ เซสชันไม่จบ */ }
  }
  return listeners.size
}
