// server/middleware/securityHeaders.js — AEGIS Drive (IDEA1)
// Security headers บนทุก response — ไม่พึ่ง nginx เพราะ header ที่เป็น "ข้อบังคับของแอป"
// ต้องอยู่กับแอป (ย้าย container ไปที่ไหน นโยบายก็ตามไปด้วย)
//
// CSP เข้มโดยเจตนา: ไม่มี 'unsafe-inline' และไม่มี 'unsafe-eval'
// - Vite build แยก JS/CSS เป็นไฟล์ภายนอกทั้งหมด → script-src/style-src 'self' เพียงพอ
// - React ตั้ง style ผ่าน CSSOM (el.style.x) ซึ่ง CSP ไม่บล็อก — แต่แท็ก <style> ที่เขียน
//   ตรง ๆ ใน JSX จะถูกบล็อก จึงต้องย้าย keyframes ทั้งหมดไปไว้ใน index.css (ทำแล้ว)
//
// ⚠️ 'wasm-unsafe-eval' ถูกเพิ่มเพื่อ Argon2id (hash-wasm) ของ Private Vault เท่านั้น
//    ชื่อมันน่ากลัวกว่าที่มันทำจริงมาก — เป็น keyword ที่ "แคบกว่า" 'unsafe-eval' อย่างมี
//    นัยสำคัญ: อนุญาตแค่การคอมไพล์/สร้าง WebAssembly module เท่านั้น
//    ไม่เปิด eval(), ไม่เปิด new Function(), ไม่เปิด setTimeout('string')
//    ทางเลือกที่ไม่ต้องใช้ keyword นี้เลยมีอย่างเดียวคือกลับไปใช้ PBKDF2 (WebCrypto
//    built-in) ซึ่งแลกด้วยการเสีย memory-hardness ที่เป็นเหตุผลหลักของการเลือก Argon2id
export function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self' data:",   // data: สำหรับ favicon/asset ขนาดเล็กที่ bundler ฝังมา
      "font-src 'self'",
      "connect-src 'self'",     // fetch ไปได้แค่ origin ตัวเอง — กัน exfiltration ผ่าน XHR
      "frame-ancestors 'none'", // ห้ามถูก embed ใน iframe — กัน clickjacking
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  )
  res.setHeader('X-Frame-Options', 'DENY')            // เบราว์เซอร์เก่าที่ไม่รู้จัก frame-ancestors
  res.setHeader('X-Content-Type-Options', 'nosniff')  // ห้ามเดา MIME — กัน content sniffing
  res.setHeader('Referrer-Policy', 'no-referrer')     // ไม่รั่ว URL ภายในไปที่อื่น
  // HSTS มีผลเฉพาะเมื่อเสิร์ฟผ่าน HTTPS (ผ่าน reverse proxy/TLS) — ใส่ไว้เสมอ ไม่มีโทษบน http
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  // แอปนี้ไม่ใช้กล้อง/ไมค์/ตำแหน่ง — ประกาศปิดไว้เลย (ลด attack surface ของ permission prompt)
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  next()
}
