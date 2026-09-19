// server/media/errors.js — AEGIS Drive (IDEA1) · ข้อผิดพลาดของงาน media ที่จำแนกชั้นได้
//
// class: PERMANENT (ไม่วนซ้ำ → GENERATION_FAILED) | TRANSIENT (retry ตาม backoff) | CANCELLED (shutdown —
// ไม่ใช่ความล้มเหลว: ไม่บันทึกสถานะ ไม่นับ attempt ปล่อยให้โปรเซสถัดไปสร้างใหม่)
export class MediaJobError extends Error {
  /** @param {{ class: 'PERMANENT'|'TRANSIENT'|'CANCELLED', reason: string, detail?: object, cause?: unknown }} opts */
  constructor({ class: cls, reason, detail = null, cause }) {
    super(`${cls} ${reason}`)
    this.name = 'MediaJobError'
    this.class = cls
    this.reason = reason
    this.detail = detail
    if (cause !== undefined) this.cause = cause
  }
}
export const permanent = (reason, detail) => new MediaJobError({ class: 'PERMANENT', reason, detail })
export const transient = (reason, detail) => new MediaJobError({ class: 'TRANSIENT', reason, detail })
/** งานถูกยกเลิกโดย AbortSignal (service.stop / SIGTERM) — reason คงที่ SHUTDOWN */
export const cancelled = (detail) => new MediaJobError({ class: 'CANCELLED', reason: 'SHUTDOWN', detail })
export const isCancelled = (err) => err instanceof MediaJobError && err.class === 'CANCELLED'
