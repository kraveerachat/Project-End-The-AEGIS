// server/auth/login.js — AEGIS Monitor (IDEA2)
// ตรวจสอบรหัสผ่านด้วย bcrypt — ห้ามรับค่า role จาก client — server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
import bcrypt from 'bcryptjs'
import { getUserByUsername } from '../db/connection.js'

// hash หลอกไว้เทียบเวลา (timing) กรณีไม่พบ user — กัน username enumeration ผ่าน side-channel เวลา
// (โค้ดเดิมของแอปนี้ return ทันทีเมื่อไม่พบ user = โปรไฟล์เวลาต่างกันชัดเจน — แก้แล้วที่นี่)
const DUMMY_HASH = bcrypt.hashSync('aegis-monitor-timing-equalizer', 10)

/**
 * ยืนยันตัวตนจาก { username, password } เท่านั้น
 * สำเร็จ → { id, username, displayName, role }  (role มาจาก DB)
 * ล้มเหลว → null  (ไม่แยกว่า user ผิดหรือรหัสผิด — กัน enumeration)
 */
export async function verifyCredentials(username, password) {
  const pw = String(password ?? '')
  const user = await getUserByUsername(username)

  if (!user) {
    // ข้อความ error เหมือนกันทุกกรณี และใช้เวลาประมวลผลเท่ากัน เพื่อป้องกัน username enumeration
    await bcrypt.compare(pw, DUMMY_HASH)
    return null
  }

  const ok = await bcrypt.compare(pw, user.passwordHash) // async — ไม่บล็อก event loop
  if (!ok) return null

  // ⚠️ role มาจาก record ใน DB เท่านั้น — ไม่ใช่จาก input ของ client
  // mustResetPassword ก็เช่นกัน — client ไม่มีทางส่งค่านี้มาเอง (ดู force-reset gate ใน requireRole.js)
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    mustResetPassword: Boolean(user.mustResetPassword),
  }
}
