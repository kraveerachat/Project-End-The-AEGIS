// server/media/disabledService.js — AEGIS Drive (IDEA1) · media service ที่ "ปิด" อย่างซื่อสัตย์
//
// ⚠️ ใช้ในสามกรณีเท่านั้น: (1) ค่าเริ่มต้นของ createApp เมื่อไม่มีใคร inject service (ชุดทดสอบ) —
//    reason MEDIA_SERVICE_NOT_INJECTED, (2) MEDIA_ENABLED=false, (3) เครื่องมือหายตอนบูต (TOOLS_MISSING)
//    ทุกเมธอดมี interface เดียวกับ service จริง แต่ไม่มีผลข้างเคียงใด ๆ: ไม่แตะดิสก์ ไม่ spawn ไม่ตั้ง timer
// ⚠️ ยังคง object-hiding: แถว vault/โฟลเดอร์ตอบ NOT_FOUND เหมือน service จริง (spec §14, §22)

/**
 * @param {import('../config/mediaLimits.js').MEDIA_DEFAULTS} limits
 * @param {'MEDIA_SERVICE_NOT_INJECTED'|'MEDIA_DISABLED'|'TOOLS_MISSING'|string} [reason]
 */
export function disabledMediaService(limits, reason = 'MEDIA_SERVICE_NOT_INJECTED') {
  const hidden = (row) => !row || row.vault === true || row.kind === 'folder'
  const infoOf = (row) => (hidden(row) ? { status: 'NOT_FOUND' } : { status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' })
  const health = () => ({ enabled: false, reason, ffmpeg: null, sharp: null, cacheWritable: false, cacheVolume: 'unknown' })
  return Object.freeze({
    limits,
    reason,
    async init() {},
    async start() {},
    async stop() {},
    async info(row) { return infoOf(row) },
    async infoBatch(rows) { return new Map(rows.map((row) => [String(row?.id), infoOf(row)])) },
    async ensure() { return false },
    async serve() { return { kind: 'disabled' } },
    async scheduleForFile() { return false },
    async peek(row) { return infoOf(row) },
    async invalidate() { return false },
    isPinned() { return false },
    health,
    adminStatus() { return { enabled: false, reason } },
  })
}
