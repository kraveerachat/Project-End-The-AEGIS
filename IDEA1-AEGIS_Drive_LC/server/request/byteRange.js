// server/request/byteRange.js — AEGIS Drive (IDEA1) · แปลง Range header (ย้ายมาจาก routes/api.js แบบรักษาพฤติกรรม)
//
// ⚠️ ใช้ร่วมกันโดย GET /api/files/:id/preview (ต้นฉบับ) และ GET /api/files/:id/motion-preview (derivative) —
//    ความหมายเดิมทุกประการ: เฉพาะ bytes ช่วงเดียว, ไวยากรณ์ผิด = ไม่มี Range (200 ทั้งก้อน), ช่วงที่ถูกแต่เป็นไปไม่ได้ = 416

/**
 * แปลง Range header เป็นช่วง [start, end] ตาม RFC 9110 §14 — เฉพาะ bytes และช่วงเดียว
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null}
 *   null = ไม่มี/ไม่รองรับ (ตอบทั้งก้อน 200 อย่างซื่อสัตย์ ไม่ปลอม 206)
 *   'unsatisfiable' = รูปแบบถูกแต่ช่วงเป็นไปไม่ได้ → 416
 */
export function parseByteRange(header, size) {
  if (typeof header !== 'string') return null
  // ⚠️ ไวยากรณ์ผิด (รวมหลายช่วง/หน่วยอื่น) = "ไม่มี Range" ตาม RFC 9110 §14.2 → ตอบ 200 ทั้งก้อน
  //    416 สงวนไว้สำหรับช่วงที่ไวยากรณ์ถูกแต่ไม่ทับกับตัวแทนเลย
  const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(header.trim())
  if (!m) return null
  const [, first, last] = m
  if (first === '' && last === '') return 'unsatisfiable'
  if (first === '') {
    // suffix-range: N ไบต์สุดท้าย — "-0" ไม่มีความหมาย
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable'
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable'
  return { start, end }
}
