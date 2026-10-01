// server/config/previewMedia.js — AEGIS Drive (IDEA1) · allowlist "เดียว" ของชนิดที่ preview ได้
//
// ⚠️ ย้ายมาจาก routes/api.js แบบรักษาพฤติกรรม (Round 8 preview route): ชุดนามสกุลนี้คือขอบเขตของ
//    การอนุญาต ทั้ง GET /api/files/:id/preview และท่อ derivative (probe/poster/motion/routes) ต้อง
//    import จากที่นี่เท่านั้น — ห้ามมี allowlist ชุดที่สองที่ไหนอีก (spec §6, plan Task 4)
// ⚠️ Unified Preview P1: ตารางนี้แยกสองความหมายออกจากกัน
//      - inline: route /preview เสิร์ฟได้ (ภาพ/วิดีโอเดิม + เสียง + ตระกูลข้อความ)
//      - derivative: ท่อ poster/motion ประมวลผลได้ — ชุดเดิม 9 นามสกุล "ไม่เปลี่ยน" (PREVIEW_MIME)
// ⚠️ SVG/HTML/XML และไฟล์ข้อความทุกชนิดถูกประกาศเป็น text/plain; charset=utf-8 เสมอ — ไม่มีวันเป็น
//    MIME ที่เบราว์เซอร์ทำงานได้ (text/html, image/svg+xml, …); nosniff + CSP sandbox กำกับอีกชั้น
// ⚠️ MIME มาจากนามสกุลของ "ชื่อในฐานข้อมูล" ไม่ใช่จาก client; รายการใหม่ของ P1 (เสียง/ข้อความ) ถูก
//    ยืนยันกับไบต์หัวไฟล์ใน route (config/formatSignatures.js); ภาพ/วิดีโอเดิมคงพฤติกรรมเดิม
//    (media/probe.js ยืนยันฝั่ง derivative)

const TEXT_MIME = 'text/plain; charset=utf-8'

const entry = (formatId, family, inlineMime, derivative = 'none', accepts = null) =>
  Object.freeze({ formatId, family, inlineMime, derivative, ...(accepts ? { accepts: Object.freeze(accepts) } : {}) })
const text = (formatId) => entry(formatId, 'text', TEXT_MIME)

const SOURCE_EXTS = ['css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go',
  'rs', 'rb', 'php', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sql', 'kt', 'swift']

/**
 * ext → { formatId, family, inlineMime, derivative, accepts? }
 * `accepts` (เสียงเท่านั้น) = FormatId จากลายเซ็นไบต์ที่ยอมรับสำหรับนามสกุลนี้
 */
export const FORMAT_TABLE = Object.freeze({
  // ── ภาพ/วิดีโอเดิม: derivative-eligible (ห้ามเปลี่ยนชุดนี้) ──
  jpg: entry('jpeg', 'image', 'image/jpeg', 'poster+motion'),
  jpeg: entry('jpeg', 'image', 'image/jpeg', 'poster+motion'),
  png: entry('png', 'image', 'image/png', 'poster+motion'),
  gif: entry('gif', 'animated-image', 'image/gif', 'poster+motion'),
  webp: entry('webp', 'image', 'image/webp', 'poster+motion'),
  avif: entry('avif', 'image', 'image/avif', 'poster+motion'),
  bmp: entry('bmp', 'image', 'image/bmp', 'poster+motion'),
  mp4: entry('mp4', 'video', 'video/mp4', 'poster+motion'),
  webm: entry('webm', 'video', 'video/webm', 'poster+motion'),
  // ── เสียง (P1): inline เท่านั้น ──
  mp3: entry('mp3', 'audio', 'audio/mpeg', 'none', ['mp3']),
  m4a: entry('m4a', 'audio', 'audio/mp4', 'none', ['m4a', 'mp4']), // M4A ส่วนหนึ่งใช้ brand isom/mp42
  aac: entry('aac', 'audio', 'audio/aac', 'none', ['aac']),
  ogg: entry('ogg-audio', 'audio', 'audio/ogg', 'none', ['ogg-audio', 'opus']),
  oga: entry('ogg-audio', 'audio', 'audio/ogg', 'none', ['ogg-audio', 'opus']),
  opus: entry('opus', 'audio', 'audio/ogg', 'none', ['opus']),
  wav: entry('wav', 'audio', 'audio/wav', 'none', ['wav']),
  flac: entry('flac', 'audio', 'audio/flac', 'none', ['flac']),
  weba: entry('webm', 'audio', 'audio/webm', 'none', ['webm']), // container WebM ที่มีแต่เสียง
  // ── ตระกูลข้อความ (P1): แสดงเป็นข้อความล้วนเสมอ ──
  txt: text('text'), log: text('text'),
  md: text('markdown'), markdown: text('markdown'),
  json: text('json'), csv: text('csv'), tsv: text('tsv'),
  xml: text('xml'), svg: text('svg'), html: text('html'), htm: text('html'),
  ...Object.fromEntries(SOURCE_EXTS.map((ext) => [ext, text('source')])),
})

/** ชุด derivative-eligible เดิม (ext → MIME) — ใช้โดย media/derivatives.js, media/probe.js; ห้ามเปลี่ยน */
export const PREVIEW_MIME = Object.freeze(Object.fromEntries(
  Object.entries(FORMAT_TABLE).filter(([, e]) => e.derivative !== 'none').map(([ext, e]) => [ext, e.inlineMime]),
))

export const PREVIEW_EXTENSIONS = Object.freeze(Object.keys(PREVIEW_MIME))

/**
 * นามสกุลตัวสุดท้ายของชื่อ (ตัวพิมพ์เล็ก) — ชื่อที่ไม่มีจุดไม่มีนามสกุล (null)
 * เหมือน `name.toLowerCase().split('.').pop()` ของ route เดิมทุกประการ: 'x.tar.gz' → 'gz'
 * @param {string} name
 * @returns {string|null}
 */
export function previewExtForName(name) {
  const text = String(name ?? '')
  if (!text.includes('.')) return null
  return text.toLowerCase().split('.').pop()
}

/** derivative-eligible เท่านั้น (ชุดเดิม 9 นามสกุล) @param {string} ext */
export function isPreviewableExtension(ext) {
  return typeof ext === 'string' && Object.hasOwn(PREVIEW_MIME, ext.toLowerCase())
}

/**
 * รายการ inline ของชื่อนี้ หรือ null (route ตอบ 415)
 * @param {string} name
 */
export function inlineEntryForName(name) {
  const ext = previewExtForName(name)
  return ext !== null && Object.hasOwn(FORMAT_TABLE, ext) ? FORMAT_TABLE[ext] : null
}

/**
 * MIME ที่ route preview ประกาศสำหรับชื่อนี้ — null = ไม่รองรับ (route ตอบ 415)
 * @param {string} name
 * @returns {string|null}
 */
export function previewMimeForName(name) {
  return inlineEntryForName(name)?.inlineMime ?? null
}
