// ⚠️ MOCK เท่านั้น — ในระบบจริงนี่คือ POST ไปยัง AEGIS auth service
//
// role ถูกตัดสินโดย SERVER จาก record ของ user ใน PostgreSQL
// แล้วถูก "เซ็น" ลงใน session token (HttpOnly, Secure, SameSite=Strict cookie)
// ซึ่ง JavaScript ฝั่ง client อ่านไม่ได้และแก้ไม่ได้
//
// client ไม่เคยประกาศ role ของตัวเอง — มันแค่ "อ่าน" สิ่งที่ server ตัดสินมาแล้ว
// code path ใดก็ตามที่ยอมให้ client กำหนด role เอง = ช่องโหว่ร้ายแรง (OWASP A01)
// หน้า login จึงไม่มีตัวเลือก role ใด ๆ ทั้งสิ้น

// สองบัญชีเดโม่ — เท่านั้น รหัสผ่านเป็น plaintext เพราะเป็นต้นแบบจำลอง
// ระบบจริงต้องเก็บเป็นแฮช argon2id ฝั่งเซิร์ฟเวอร์ และห้ามฝังบัญชีใน bundle
const DEMO_ACCOUNTS = [
  { username: 'user', password: 'aegis-user', role: 'user', displayName: 'Kanya S.' },
  { username: 'admin', password: 'aegis-admin', role: 'admin', displayName: 'Veerachat J.' },
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Mock of `POST /api/auth/login`.
 * Success → `{ ok: true, user: { username, role, displayName } }`
 * Failure → `{ ok: false }` — deliberately nothing more granular.
 */
export async function authenticate({ username, password, remember }) {
  // `remember` มีผล "ฝั่งเซิร์ฟเวอร์" เท่านั้น — ยืดอายุ cookie ที่ออกให้
  // ห้ามใช้เป็นเหตุผลเก็บ credential หรือ role ฝั่ง client เด็ดขาด
  void remember

  // หน่วงเวลาเท่ากันทุกกรณี — สำเร็จ / รหัสผิด / ไม่พบผู้ใช้ ใช้เวลาเท่ากันหมด
  // กันการเดาบัญชีจากเวลาตอบสนอง (timing side-channel); ระบบจริงต้องใช้
  // การเปรียบเทียบแฮชแบบ constant-time ฝั่งเซิร์ฟเวอร์ด้วย
  await delay(600)

  // Normalize username เหมือน auth service จริง (trim + lowercase) —
  // ช่องว่างหลงมาจากคีย์บอร์ดมือถือต้องไม่ทำให้ login พลาด
  // รหัสผ่านไม่ normalize เด็ดขาด — เทียบตรงตัวอักษรเสมอ
  const uname = String(username ?? '').trim().toLowerCase()

  const account = DEMO_ACCOUNTS.find((a) => a.username === uname && a.password === password)

  // ⚠️ response ต้องหยาบที่สุดเท่าที่จะทำได้ — ห้ามบอกว่า "ไม่พบ user" หรือ
  // "รหัสผ่านผิด" แยกกัน → กัน username enumeration
  if (!account) return { ok: false }

  return {
    ok: true,
    user: { username: account.username, role: account.role, displayName: account.displayName },
  }
}
