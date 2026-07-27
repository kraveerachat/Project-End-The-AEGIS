// server/auth/login.js — AEGIS Drive (IDEA1)
// ตรวจสอบรหัสผ่านด้วย bcrypt — ห้ามรับค่า role จาก client — server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
import bcrypt from 'bcryptjs'
import { getUserByUsername, effectiveDisplayName } from '../db/connection.js'

// hash หลอกไว้เทียบเวลา (timing) กรณีไม่พบ user — กัน username enumeration ผ่าน
// side-channel เวลา: กรณี "พบ" และ "ไม่พบ" user ต้องเสียเวลา bcrypt.compare พอ ๆ กัน
const DUMMY_HASH = bcrypt.hashSync('aegis-drive-timing-equalizer', 10)

/**
 * ยืนยันตัวตนจาก { username, password } เท่านั้น
 * สำเร็จ → { id, username, displayName, role }  (role มาจาก DB)
 * ล้มเหลว → null  (ไม่แยกว่า user ผิดหรือรหัสผิด — กัน enumeration)
 */
export async function verifyCredentials(username, password) {
  const pw = String(password ?? '')
  const user = await getUserByUsername(username)

  if (!user) {
    // เทียบกับ hash หลอกให้เสียเวลาเท่ากรณีพบ user จริง แล้วค่อยปฏิเสธ
    // ข้อความ error เหมือนกันทุกกรณี และใช้เวลาประมวลผลเท่ากัน เพื่อป้องกัน username enumeration
    await bcrypt.compare(pw, DUMMY_HASH)
    return null
  }

  const ok = await bcrypt.compare(pw, user.passwordHash)
  if (!ok) return null

  // ⚠️ role มาจาก record ใน DB เท่านั้น — ไม่ใช่จาก input ของ client
  // mustResetPassword ก็เช่นกัน — client ไม่มีทางส่งค่านี้มาเอง (ดู force-reset gate ใน requireRole.js)
  return {
    id: user.id,
    username: user.username,
    // ชื่อที่ผู้ใช้ตั้งเองมาก่อน ถ้ายังไม่ตั้งก็ใช้ชื่อที่ Admin ตั้ง — ห้ามใช้ชี้ตัวตน
    // เชิงสิทธิ์ (ดู effectiveDisplayName ใน db/connection.js)
    displayName: effectiveDisplayName(user),
    accountName: user.displayName,
    role: user.role,
    mustResetPassword: Boolean(user.mustResetPassword),
  }
}
