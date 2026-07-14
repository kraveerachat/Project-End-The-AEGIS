// Module resolution — the Hub's entire reason to exist.
//
// ⚠️ นี่คือ UX affordance เท่านั้น — ไม่ใช่ security control
// การซ่อนการ์ดในฝั่ง client ป้องกันแค่ "การมองเห็น" ไม่ได้ป้องกัน "การเข้าถึง"
// ในระบบจริง backend ต้อง re-authorize ทุก request เสมอ
// เพราะ attacker ที่ไม่รัน JS ของเรา จะ bypass การเช็คนี้ได้ทันที
//
// สำคัญ: โมดูลที่ไม่มีสิทธิ์ต้อง "ไม่ถูก render ลง DOM เลย" — ไม่ใช่ greyed out
// ไม่ใช่ disabled ไม่ใช่ display:none — เพื่อกัน Information Disclosure:
// แค่เผยว่า "CCTV Operator View" มีอยู่ ก็เท่ากับยื่นเป้าหมายและข้ออ้าง
// phishing ให้ผู้โจมตี ให้ filter array นี้ "ก่อน" ถึง .map() ที่ render เสมอ

export const MODULES = [
  { id: 'drive', titleKey: 'modDrive', descKey: 'modDriveDesc', roles: ['user', 'admin'] },
  { id: 'cctv', titleKey: 'modCctv', descKey: 'modCctvDesc', roles: ['admin'] },
  { id: 'monitoring', titleKey: 'modMonitor', descKey: 'modMonitorDesc', roles: ['admin'] },
]

/**
 * Single source of truth for what a role may launch.
 * default-deny: role ที่ไม่รู้จัก / null / undefined → คืนค่าว่าง ไม่ใช่คืนทุกอย่าง
 * เพราะ "เผื่อใจให้ผ่าน" คือจุดเริ่มของ Broken Access Control
 *
 * @param {string | null | undefined} role
 */
export function getModulesForRole(role) {
  if (role !== 'user' && role !== 'admin') return [] // default-deny
  return MODULES.filter((m) => m.roles.includes(role))
}
