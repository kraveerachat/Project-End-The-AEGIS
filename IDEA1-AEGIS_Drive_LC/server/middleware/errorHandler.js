// server/middleware/errorHandler.js — AEGIS Drive (IDEA1)
// Error handler ตัวสุดท้ายของ chain — รายละเอียดจริง (stack, SQL error, path)
// ลง log ฝั่งเซิร์ฟเวอร์เท่านั้น; client ได้ข้อความ generic เสมอ
// ห้ามรั่ว internals ใน response เด็ดขาด (information disclosure ช่วยผู้โจมตี map ระบบ)
export function errorHandler(err, req, res, _next) {
  console.error('[aegis-drive] unhandled error:', err)
  if (res.headersSent) return
  res.status(500).json({ error: 'Internal error' })
}

/** 404 ของ API — ข้อความเดียวกับ resource ที่ "มีแต่ไม่มีสิทธิ์" เพื่อไม่ให้เดา endpoint ได้ */
export function apiNotFound(req, res) {
  res.status(404).json({ error: 'Not found' })
}
