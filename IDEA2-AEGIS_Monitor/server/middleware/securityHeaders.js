// server/middleware/securityHeaders.js — AEGIS Monitor (IDEA2)
// Security headers บนทุก response — CSP เข้ม: ไม่มี 'unsafe-inline' / 'unsafe-eval'
// Vite build แยก JS/CSS เป็นไฟล์ภายนอก; React ตั้ง style ผ่าน CSSOM ซึ่ง CSP ไม่บล็อก
export function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      // connect-src 'self' ครอบทั้ง fetch และ WebSocket (ws จาก origin เดียวกัน)
      // เมื่อ integration กับ Detection Engine ใช้ reverse proxy เข้า origin เดียว
      // — อย่าเปิด host อื่นตรง ๆ ใน CSP
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  )
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  // เว็บแอปนี้ "ไม่เปิดกล้อง" โดยสถาปัตยกรรม (กล้องอยู่กับ Detection Engine บน Laptop)
  // ประกาศปิด permission ไว้เลย — ตอกย้ำ boundary ในระดับเบราว์เซอร์
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  next()
}
