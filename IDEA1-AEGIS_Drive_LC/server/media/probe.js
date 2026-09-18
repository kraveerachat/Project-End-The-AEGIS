// server/media/probe.js — AEGIS Drive (IDEA1) · ตรวจ media ต้นฉบับแบบมีขอบเขต: ตระกูล, ขนาด, เคลื่อนไหวหรือไม่
//
// ⚠️ หลักการ (spec §6, §6.1, §13.3, §18):
//    - นามสกุลเป็นแค่ "ข้ออ้าง": ไบต์หัวไฟล์ต้องยืนยันตระกูลเดียวกัน ไม่งั้น FAMILY_MISMATCH
//    - อ่านหัวไฟล์ไม่เกิน 64 KiB ครั้งเดียว ไม่มีการอ่านทั้งไฟล์เข้า Buffer ของ Node
//    - กฎ "เคลื่อนไหว" เป็นกฎรายตระกูลที่พิสูจน์ได้ภายในงบ — ไม่มีกฎรวม frames/duration
//      พิสูจน์ไม่ได้ = animated null = posterOnly (ไม่มีวันเดาว่าเคลื่อนไหวแล้วไปสั่ง encode)
//    - เพดานพิกเซลถูกตรวจจาก metadata ก่อนใครจะถอดรหัสภาพ (decompression-bomb guard)
//    - ffprobe ถูกเรียกผ่าน processRunner ด้วย argument array เท่านั้น (ไม่มี shell) พร้อม
//      -probesize / timeout ตาม limits และไม่มี -count_frames (จะสแกนทั้งไฟล์)
//    - โมดูลนี้ไม่ persist อะไร (Task 7 เป็นเจ้าของ cache) และไม่ import route ใด ๆ

import fsp from 'node:fs/promises'
import { isPreviewableExtension } from '../config/previewMedia.js'

export const PROBE_VERSION = 1
const HEADER_BYTES = 65_536
const APNG_BUDGET = Object.freeze({ maxChunks: 32, maxBytes: 65_536 })
const WEBP_HEADER_BYTES = 30
const STDERR_DETAIL_BYTES = 512

const FAMILY_BY_EXT = Object.freeze({
  jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp', mp4: 'mp4', webm: 'webm',
})
const VIDEO_FAMILIES = new Set(['mp4', 'webm'])
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'msdh', 'msix', 'm4v ', 'M4V ', 'f4v '])
const AVIF_BRANDS = new Set(['avif', 'avis'])

/* ── header sniffing ──────────────────────────────────────────────────────── */
function ftypBrands(buf) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return null
  const size = buf.readUInt32BE(0)
  const end = Math.min(buf.length, size >= 16 ? size : buf.length, 256)
  const brands = [buf.toString('latin1', 8, 12)]
  for (let off = 16; off + 4 <= end; off += 4) brands.push(buf.toString('latin1', off, off + 4))
  return brands
}

/**
 * ตระกูลจากไบต์หัวไฟล์ (bounded) — null = ไม่รู้จัก
 * @param {Buffer} buf
 * @returns {'jpeg'|'png'|'webp'|'avif'|'bmp'|'gif'|'mp4'|'webm'|null}
 */
export function sniffFamily(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm'
  const brands = ftypBrands(buf)
  if (brands) {
    if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif'
    if (brands.some((b) => MP4_BRANDS.has(b))) return 'mp4'
  }
  return null
}

/* ── family-specific animation rules ─────────────────────────────────────── */
/**
 * APNG: เดินหัว chunk ตั้งแต่ signature ข้ามเนื้อ chunk ตามความยาวที่ประกาศ จนถึง IDAT ตัวแรก
 * animated = acTL ก่อน IDAT และ num_frames > 1 · งบ 32 chunk / 64 KiB หมดก่อนตัดสิน = null
 * @param {Buffer} header
 */
export function probeApngAnimation(header, { maxChunks = APNG_BUDGET.maxChunks, maxBytes = APNG_BUDGET.maxBytes } = {}) {
  let off = 8
  let actl = null
  for (let n = 0; n < maxChunks; n += 1) {
    if (off + 8 > Math.min(header.length, maxBytes)) return { animated: null, evidence: 'apng-budget-exhausted', frames: actl }
    const len = header.readUInt32BE(off)
    const type = header.toString('latin1', off + 4, off + 8)
    if (type === 'acTL' && off + 12 <= header.length) actl = header.readUInt32BE(off + 8)
    if (type === 'IDAT' || type === 'IEND') {
      if (actl === null) return { animated: false, evidence: 'png-no-actl', frames: null }
      return actl > 1
        ? { animated: true, evidence: 'apng-actl-before-idat', frames: actl }
        : { animated: false, evidence: 'apng-actl-single-frame', frames: actl }
    }
    off += 12 + len
  }
  return { animated: null, evidence: 'apng-budget-exhausted', frames: actl }
}
probeApngAnimation.budget = APNG_BUDGET

/**
 * WebP: chunk แรกต้องเป็น VP8X ที่ตั้งธง Animation (บิต 1) และต้องมีหลักฐานจำนวนหน้า > 1
 * ธงไม่ตั้ง/ไม่มี VP8X = นิ่ง · ธงตั้งแต่พิสูจน์หน้าไม่ได้ = null
 * @param {Buffer} header
 * @param {{ pageEvidence: number|null }} opts
 */
export function probeWebpAnimation(header, { pageEvidence = null } = {}) {
  const chunk = header.length >= 16 ? header.toString('latin1', 12, 16) : ''
  if (chunk !== 'VP8X') return { animated: false, evidence: 'webp-no-vp8x-animation-flag' }
  const flags = header.length >= 21 ? header[20] : 0
  if (!(flags & 0x02)) return { animated: false, evidence: 'webp-no-vp8x-animation-flag' }
  if (Number.isInteger(pageEvidence) && pageEvidence > 1) return { animated: true, evidence: 'webp-vp8x-flag-and-pages' }
  return { animated: null, evidence: 'webp-vp8x-flag-pages-unproven' }
}
probeWebpAnimation.headerBytes = WEBP_HEADER_BYTES

/**
 * นับ ANMF (frame) chunk ที่เห็นในหัวไฟล์แบบมีขอบเขต — ≥ 2 = หลักฐานเชิงโครงสร้างว่ามีหลายเฟรม
 * หยุดที่ 2 (ไม่นับทั้งไฟล์); เฟรมแรกใหญ่กว่างบ = เห็นไม่ครบ = พิสูจน์ไม่ได้
 * @param {Buffer} header
 */
export function countWebpFrameChunks(header, { maxBytes = HEADER_BYTES, stopAt = 2 } = {}) {
  let off = 12
  let frames = 0
  const end = Math.min(header.length, maxBytes)
  while (off + 8 <= end && frames < stopAt) {
    const type = header.toString('latin1', off, off + 4)
    const size = header.readUInt32LE(off + 4)
    if (type === 'ANMF') frames += 1
    off += 8 + size + (size % 2)
  }
  return frames
}

/**
 * AVIF: ต้องมี brand `avis` (image sequence) ก่อน แล้วจึงนับ sample จาก container probe
 * ไม่มี avis = นิ่ง (ไม่ว่า duration จะบอกอะไร) · avis แต่ sample count ไม่ได้/≤ 1 = null
 * @param {Buffer} header
 * @param {{ sampleCount: number|null }} opts
 */
export function probeAvifAnimation(header, { sampleCount = null } = {}) {
  const brands = ftypBrands(header) ?? []
  if (!brands.includes('avis')) return { animated: false, evidence: 'avif-no-avis-brand' }
  if (Number.isInteger(sampleCount) && sampleCount > 1) return { animated: true, evidence: 'avif-avis-sample-count' }
  return { animated: null, evidence: 'avif-avis-unproven' }
}

/**
 * ตัด string ให้ไม่เกิน maxBytes เมื่อเข้ารหัส UTF-8 โดยไม่ผ่ากลาง codepoint — สำหรับ diagnostic เท่านั้น
 * ⚠️ `.slice(0, n)` นับ UTF-16 code unit ('€' = 1 หน่วยแต่ 3 ไบต์) จึงไม่ใช่ขอบเขตไบต์; ไม่ใช้
 *    Buffer.subarray แล้ว decode กลับด้วย เพราะจะได้ U+FFFD ที่ปลายเมื่อตัดกลาง sequence
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8Bytes(value, maxBytes) {
  const text = String(value ?? '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  let out = ''
  for (const ch of text) { // iterates by codepoint (surrogate pairs stay together)
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (used + bytes > maxBytes) break
    out += ch
    used += bytes
  }
  return out
}

function ffprobeBaseArgs(limits) {
  return ['-v', 'error', '-hide_banner', '-protocol_whitelist', 'file', '-probesize', String(limits.probesizeBytes), '-analyzeduration', '5000000']
}

/** อ่านสูงสุดสอง packet แรก (หนึ่ง packet ต่อหนึ่งภาพใน GIF/animated WebP) แล้วหยุด — ไม่มี -count_frames */
async function twoPacketCount({ absPath, runner, limits, ffprobeBin }) {
  const result = await runner.run({
    bin: ffprobeBin,
    args: [...ffprobeBaseArgs(limits), '-read_intervals', '%+#2', '-show_packets', '-print_format', 'json', absPath],
    timeoutMs: limits.probeTimeoutMs,
  })
  if (result.timedOut) return { count: null, timedOut: true }
  if (result.code !== 0) return { count: null, timedOut: false }
  try {
    const parsed = JSON.parse(result.stdout)
    return { count: Array.isArray(parsed.packets) ? parsed.packets.length : null, timedOut: false }
  } catch {
    return { count: null, timedOut: false }
  }
}

/**
 * GIF: สอง packet → เคลื่อนไหว, หนึ่ง packet แล้วจบ → นิ่ง, timeout/ล้มเหลว → null
 * (NETSCAPE loop extension เป็นแค่คำใบ้ ไม่ใช่หลักฐาน — ไม่ถูกใช้ตัดสิน)
 */
export async function probeGifAnimation({ absPath, runner, limits, ffprobeBin = 'ffprobe' }) {
  const { count, timedOut } = await twoPacketCount({ absPath, runner, limits, ffprobeBin })
  if (timedOut) return { animated: null, evidence: 'gif-probe-timeout' }
  if (count === null) return { animated: null, evidence: 'gif-probe-failed' }
  if (count >= 2) return { animated: true, evidence: 'gif-second-packet' }
  return { animated: false, evidence: 'gif-single-packet' }
}

/* ── dimensions ───────────────────────────────────────────────────────────── */
function headerDimensions(family, buf) {
  switch (family) {
    case 'png':
      return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null
    case 'gif':
      return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null
    case 'bmp':
      return buf.length >= 26 ? { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) } : null
    case 'webp':
      if (buf.length >= 30 && buf.toString('latin1', 12, 16) === 'VP8X') {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
      }
      return null
    case 'jpeg': {
      // SOFn marker scan within the bounded header
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off += 1; continue }
        const marker = buf[off + 1]
        if (marker === 0xff) { off += 1; continue }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
        const len = buf.readUInt16BE(off + 2)
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
        }
        if (marker === 0xda) return null // start of scan without SOF: leave to the tool
        off += 2 + len
      }
      return null
    }
    default:
      return null
  }
}

async function toolStreamInfo({ absPath, runner, limits, capabilities, ffprobeBin }) {
  if (!capabilities?.ffprobe?.ok) return { error: { cause: 'FFPROBE_UNAVAILABLE' } }
  const result = await runner.run({
    bin: ffprobeBin,
    args: [...ffprobeBaseArgs(limits), '-select_streams', 'v:0', '-show_streams', '-show_format', '-print_format', 'json', absPath],
    timeoutMs: limits.probeTimeoutMs,
  })
  if (result.timedOut) return { error: { cause: 'PROBE_TIMEOUT', timedOut: true } }
  if (result.code !== 0) return { error: { cause: 'FFPROBE_EXIT', exitCode: result.code, stderr: truncateUtf8Bytes(result.stderr, STDERR_DETAIL_BYTES) } }
  let parsed
  try { parsed = JSON.parse(result.stdout) } catch { return { error: { cause: 'FFPROBE_OUTPUT_UNPARSEABLE' } } }
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null
  if (!stream) return { error: { cause: 'NO_VIDEO_STREAM' } }
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
  return {
    width: num(stream.width), height: num(stream.height),
    sampleCount: Number.isInteger(Number(stream.nb_frames)) && stream.nb_frames !== undefined ? Number(stream.nb_frames) : null,
    durationSeconds: num(stream.duration) ?? num(parsed.format?.duration),
    codec: stream.codec_name ?? null,
  }
}

const defaultReadHeader = async (absPath, bytes) => {
  const fh = await fsp.open(absPath, 'r')
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(bytes), 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

function unsupported(reason, extra = {}) {
  return {
    probeVersion: PROBE_VERSION, family: null, width: null, height: null, pixels: null, durationSeconds: null, frames: null,
    animated: null, animationEvidence: null, posterOnly: true, unsupported: true, reason, engine: null, measuredAt: new Date().toISOString(),
    ...extra,
  }
}

/**
 * @param {{ absPath: string, ext: string, limits: object, capabilities: object, runner: { run: Function },
 *           metadataProvider?: { metadataFor: (absPath: string) => Promise<{ width?: number, height?: number, pages?: number }> } | null,
 *           readHeader?: (absPath: string, bytes: number) => Promise<Buffer>, ffprobeBin?: string, now?: () => Date }} opts
 * @returns {Promise<object>} ProbeResult (spec §13.3) — `unsupported:true` with `reason` when refused
 */
export async function probeMedia({ absPath, ext, limits, capabilities, runner, metadataProvider = null, readHeader = defaultReadHeader, ffprobeBin = 'ffprobe', now = () => new Date() }) {
  const lowerExt = String(ext ?? '').toLowerCase()
  if (!isPreviewableExtension(lowerExt)) return unsupported('UNSUPPORTED_TYPE')
  const expected = FAMILY_BY_EXT[lowerExt]

  let header
  try {
    header = await readHeader(absPath, HEADER_BYTES)
  } catch {
    return unsupported('SOURCE_UNREADABLE')
  }
  const family = sniffFamily(header)
  if (family !== expected) return unsupported('FAMILY_MISMATCH', { family })

  // ── dimensions: header first, then the metadata provider (sharp, when the runtime injects it), then ffprobe
  let dims = headerDimensions(family, header)
  let tool = null
  let pages = null
  let engine = dims ? 'header' : null
  const isVideo = VIDEO_FAMILIES.has(family)
  const needTool = !dims || isVideo || family === 'avif'
  if (needTool) {
    if (metadataProvider && !isVideo) {
      try {
        const meta = await metadataProvider.metadataFor(absPath)
        if (meta && Number.isFinite(meta.width) && Number.isFinite(meta.height)) {
          dims = dims ?? { width: meta.width, height: meta.height }
          engine = engine ?? 'metadata-provider'
        }
        if (Number.isInteger(meta?.pages)) pages = meta.pages
      } catch { /* provider เป็นตัวช่วย ไม่ใช่ตัวตัดสิน — ถ้าล้มเหลวตกไปใช้ ffprobe */ }
    }
    if (!dims || isVideo || (family === 'avif' && tool === null)) {
      tool = await toolStreamInfo({ absPath, runner, limits, capabilities, ffprobeBin })
      if (tool.error) {
        if (!dims || isVideo) return unsupported('PROBE_FAILED', { family, detail: tool.error })
        tool = null
      } else {
        dims = dims ?? (Number.isFinite(tool.width) && Number.isFinite(tool.height) ? { width: tool.width, height: tool.height } : null)
        engine = engine ?? 'ffprobe'
      }
    }
  }
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) return unsupported('PROBE_FAILED', { family, detail: { cause: 'DIMENSIONS_UNKNOWN' } })
  const pixels = dims.width * dims.height
  const guard = isVideo ? limits.maxVideoFramePixels : limits.maxSourcePixels
  if (pixels > guard) return unsupported('DIMENSIONS', { family, width: dims.width, height: dims.height, pixels })

  // ── animation: one rule per family (spec §6.1)
  let rule
  let frames = null
  switch (family) {
    case 'jpeg':
    case 'bmp':
      rule = { animated: false, evidence: 'family-still' }
      break
    case 'png': {
      const apng = probeApngAnimation(header)
      rule = apng; frames = apng.frames
      break
    }
    case 'webp': {
      let pageEvidence = pages
      const flagSet = header.length >= 21 && header.toString('latin1', 12, 16) === 'VP8X' && (header[20] & 0x02) !== 0
      // หลักฐานจำนวนเฟรม: (1) metadata provider (sharp เมื่อ runtime inject) → pages
      //                   (2) ANMF chunk ≥ 2 ในหัวไฟล์ 64 KiB (เชิงโครงสร้าง ไม่ถอดรหัส)
      // ⚠️ ไม่ใช้ packet ของ ffprobe: demuxer อาจส่งทั้ง animation เป็น packet เดียว จึงไม่ใช่หลักฐาน
      if (flagSet && pageEvidence === null && metadataProvider) {
        try { const meta = await metadataProvider.metadataFor(absPath); if (Number.isInteger(meta?.pages)) pageEvidence = meta.pages } catch { /* ไม่ใช่ตัวตัดสิน */ }
      }
      if (flagSet && pageEvidence !== null) {
        rule = probeWebpAnimation(header, { pageEvidence })
      } else if (flagSet && countWebpFrameChunks(header) >= 2) {
        rule = { animated: true, evidence: 'webp-vp8x-flag-and-anmf' }
      } else {
        rule = probeWebpAnimation(header, { pageEvidence: null })
      }
      break
    }
    case 'gif':
      rule = capabilities?.ffprobe?.ok
        ? await probeGifAnimation({ absPath, runner, limits, ffprobeBin })
        : { animated: null, evidence: 'gif-probe-unavailable' }
      break
    case 'avif':
      rule = probeAvifAnimation(header, { sampleCount: tool?.sampleCount ?? null })
      if (rule.animated === true) frames = tool.sampleCount
      break
    default:
      rule = { animated: true, evidence: 'family-video' }
  }

  return {
    probeVersion: PROBE_VERSION,
    family,
    codec: tool?.codec ?? null,
    width: dims.width,
    height: dims.height,
    pixels,
    durationSeconds: tool?.durationSeconds ?? null,
    frames,
    animated: rule.animated,
    animationEvidence: rule.evidence,
    // posterOnly = "พิสูจน์ไม่ได้" (null) → ห้ามสั่ง motion; ภาพนิ่ง (false) มีเหตุผลของตัวเอง (NOT_ANIMATED) ใน Task 7
    posterOnly: rule.animated === null,
    unsupported: false,
    reason: null,
    engine,
    measuredAt: now().toISOString(),
  }
}
