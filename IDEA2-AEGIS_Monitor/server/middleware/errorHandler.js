// server/middleware/errorHandler.js — AEGIS Monitor (IDEA2)
// รายละเอียด error จริงลง log ฝั่งเซิร์ฟเวอร์เท่านั้น — client ได้ข้อความ generic เสมอ
// ห้ามรั่ว stack trace / SQL error / path ภายในออกไปใน response
export function errorHandler(err, req, res, _next) {
  console.error('[aegis-monitor] unhandled error:', err)
  if (res.headersSent) return
  res.status(500).json({ error: 'Internal error' })
}

export function apiNotFound(req, res) {
  res.status(404).json({ error: 'Not found' })
}
