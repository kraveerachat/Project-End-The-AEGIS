// server/media/capabilities.js — AEGIS Drive (IDEA1) · ตรวจ toolchain ของ media derivative ตอนบูต
//
// ⚠️ ฟังก์ชันนี้ "ไม่มีวัน reject": เครื่องมือหาย/ค้าง/ไม่มี encoder = ลดระดับความสามารถอย่างซื่อสัตย์
//    (enabled=false หรือ reasons[]) ไม่ใช่ทำให้ Drive บูตไม่ขึ้น — การจัดการไฟล์ต้องไม่ผูกกับ thumbnail
// ⚠️ ผลลัพธ์ถูกแช่แข็ง: runtime สร้าง service จากวัตถุนี้ครั้งเดียว ไม่มีการ "อัปเกรดทีหลัง" (spec §10.4)

import { createProcessRunner } from './processRunner.js'

const DECODER_NAMES = ['gif', 'apng', 'webp', 'av1', 'h264', 'vp8', 'vp9']
const ENCODER_NAMES = ['libx264', 'libwebp']

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

export const CAPABILITIES_NONE = deepFreeze({
  enabled: false,
  ffmpeg: { ok: false, version: null },
  ffprobe: { ok: false, version: null },
  encoders: { libx264: false, libwebp: false },
  decoders: { gif: false, apng: false, webp: false, webpAnimated: false, av1: false, h264: false, vp8: false, vp9: false },
  sharp: { ok: false, version: null, avif: false },
  reasons: ['NOT_PROBED'],
})

/** บรรทัดของ `ffmpeg -encoders/-decoders` ขึ้นต้นด้วยธง 6 ตัว แล้วตามด้วยชื่อ — จับชื่อแบบเต็มคำเท่านั้น */
function listedNames(listing) {
  const names = new Set()
  for (const line of String(listing ?? '').split(/\r?\n/)) {
    const m = /^\s*[A-Z.]{6}\s+([A-Za-z0-9_]+)\b/.exec(line)
    if (m) names.add(m[1])
  }
  return names
}

function parseVersion(stdout) {
  const m = /version\s+n?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(stdout ?? ''))
  if (!m) return null
  return { text: m[3] !== undefined ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`, major: Number(m[1]), minor: Number(m[2]) }
}

/**
 * @returns {Promise<Readonly<typeof CAPABILITIES_NONE>>}
 */
export async function detectCapabilities({
  runner = createProcessRunner(),
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  loadSharp = () => import('sharp'),
  timeoutMs = 10_000,
} = {}) {
  const reasons = []
  const probe = async (bin, args, missingReason, timeoutReason) => {
    try {
      const result = await runner.run({ bin, args, timeoutMs })
      if (result.timedOut) { reasons.push(timeoutReason); return null }
      if (result.code !== 0) { reasons.push(missingReason); return null }
      return result.stdout
    } catch {
      reasons.push(missingReason)
      return null
    }
  }

  const ffmpegVersionOut = await probe(ffmpegBin, ['-version'], 'FFMPEG_MISSING', 'FFMPEG_TIMEOUT')
  const ffmpegVersion = ffmpegVersionOut === null ? null : parseVersion(ffmpegVersionOut)
  const ffmpegOk = ffmpegVersionOut !== null
  let encoders = { libx264: false, libwebp: false }
  let decoders = { gif: false, apng: false, webp: false, webpAnimated: false, av1: false, h264: false, vp8: false, vp9: false }
  if (ffmpegOk) {
    const enc = listedNames(await probe(ffmpegBin, ['-hide_banner', '-encoders'], 'FFMPEG_ENCODERS_UNREADABLE', 'FFMPEG_TIMEOUT'))
    const dec = listedNames(await probe(ffmpegBin, ['-hide_banner', '-decoders'], 'FFMPEG_DECODERS_UNREADABLE', 'FFMPEG_TIMEOUT'))
    encoders = Object.fromEntries(ENCODER_NAMES.map((n) => [n, enc.has(n)]))
    decoders = Object.fromEntries(DECODER_NAMES.map((n) => [n, dec.has(n)]))
    // ⚠️ animated WebP ถอดได้จริงตั้งแต่สาย 7.1 — รุ่นเก่ากว่านั้นถอดแค่เฟรมแรก (spec §6)
    const atLeast71 = ffmpegVersion !== null && (ffmpegVersion.major > 7 || (ffmpegVersion.major === 7 && ffmpegVersion.minor >= 1))
    decoders.webpAnimated = decoders.webp && atLeast71
    for (const n of ENCODER_NAMES) if (!encoders[n]) reasons.push(`ENCODER_${n.toUpperCase()}_MISSING`)
    for (const n of DECODER_NAMES) if (!decoders[n]) reasons.push(`DECODER_${n.toUpperCase()}_MISSING`)
  }

  const ffprobeVersionOut = await probe(ffprobeBin, ['-version'], 'FFPROBE_MISSING', 'FFPROBE_TIMEOUT')
  const ffprobeVersion = ffprobeVersionOut === null ? null : parseVersion(ffprobeVersionOut)

  let sharp = { ok: false, version: null, avif: false }
  try {
    const mod = await loadSharp()
    const s = mod?.default ?? mod
    sharp = {
      ok: true,
      version: s?.versions?.sharp ?? s?.versions?.vips ?? null,
      avif: Boolean(s?.format?.heif?.input?.file),
    }
  } catch {
    reasons.push('SHARP_UNAVAILABLE')
  }

  return deepFreeze({
    enabled: ffmpegOk && ffprobeVersionOut !== null,
    ffmpeg: { ok: ffmpegOk, version: ffmpegVersion?.text ?? null },
    ffprobe: { ok: ffprobeVersionOut !== null, version: ffprobeVersion?.text ?? null },
    encoders,
    decoders,
    sharp,
    reasons,
  })
}
