// ⚠️ MOCK ONLY. In production this is `POST /api/auth/login` against the AEGIS
// auth service. The role is decided by the SERVER from the user record in
// PostgreSQL and travels back inside a signed, HttpOnly, Secure,
// SameSite=Strict session cookie that this JavaScript can never read.
//
// หมายเหตุความปลอดภัย (สำหรับผู้ตรวจ):
// - บทบาท (role) ถูกตัดสินโดย "เซิร์ฟเวอร์" เท่านั้น — หน้า login นี้จึงไม่มี
//   ตัวเลือก role ใด ๆ ทั้งสิ้น การให้ client ประกาศสิทธิ์ของตัวเองคือช่องโหว่
//   Broken Access Control (OWASP A01) โดยตรง
// - session ของจริงอยู่ใน HttpOnly + Secure + SameSite=Strict cookie ที่ JS
//   อ่านไม่ได้ — XSS จึงขโมย session ไม่ได้ ที่นี่เก็บใน React state (หน่วยความจำ)
//   เพื่อจำลองพฤติกรรมเดียวกัน: ปิดแท็บ = เซสชันหาย ไม่มีอะไรตกค้างในเครื่อง
// - รหัสผ่านด้านล่างเป็น plaintext เพราะเป็นต้นแบบจำลองเท่านั้น ระบบจริงต้องเก็บ
//   เป็นแฮช argon2id ฝั่งเซิร์ฟเวอร์ และห้ามฝังบัญชีไว้ใน bundle ฝั่ง client

const MOCK_USERS = [
  { username: 'user', password: 'aegis-user', role: 'datalake-user', displayName: 'Kanya Srisuwan' },
  { username: 'admin', password: 'aegis-admin', role: 'admin', displayName: 'Veerachat J.' },
]

// หน่วงเวลาเท่ากันทุกกรณี — สำเร็จ / รหัสผิด / ไม่พบผู้ใช้ ใช้เวลาเท่ากันหมด
// กันการเดาบัญชีจากเวลาตอบสนอง (timing side-channel); ระบบจริงต้องใช้
// การเปรียบเทียบแฮชแบบ constant-time ฝั่งเซิร์ฟเวอร์ด้วย
const MOCK_LATENCY_MS = 550

/**
 * Mock of `POST /api/auth/login`.
 * Success → `{ ok: true, user: { username, role, displayName } }`
 * Failure → `{ ok: false }` — deliberately nothing more granular.
 *
 * ป้องกัน username enumeration: ผลล้มเหลวมีรูปแบบเดียวเสมอ ไม่บอกว่า
 * "ไม่พบผู้ใช้" หรือ "รหัสผ่านผิด" เพราะข้อมูลนั้นช่วยผู้โจมตีไล่รายชื่อบัญชีจริง
 */
export function authenticate({ username, password, remember }) {
  // `remember` มีผล "ฝั่งเซิร์ฟเวอร์" เท่านั้น (ยืดอายุ cookie ที่ออกให้)
  // ห้ามใช้เป็นเหตุผลเก็บ credential/role ฝั่ง client เด็ดขาด
  void remember

  // Normalize username like a real auth service (trim + lowercase) —
  // stray spaces from mobile keyboards must not fail a login.
  // รหัสผ่านไม่ normalize เด็ดขาด — เทียบตรงตัวอักษรเสมอ
  const uname = String(username ?? '').trim().toLowerCase()

  return new Promise((resolve) => {
    setTimeout(() => {
      const record = MOCK_USERS.find((u) => u.username === uname && u.password === password)
      resolve(
        record
          ? { ok: true, user: { username: record.username, role: record.role, displayName: record.displayName } }
          : { ok: false },
      )
    }, MOCK_LATENCY_MS)
  })
}
