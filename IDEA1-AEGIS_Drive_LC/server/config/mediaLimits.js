// server/config/mediaLimits.js — AEGIS Drive (IDEA1) · เพดานของท่อ media derivative (poster / motion proxy)
//
// ⚠️ แบบแผนเดียวกับ transferLimits.js: อ่านครั้งเดียวตอนบูต ค่าผิด = โยน error ทันที ไม่ clamp
//    เงียบ ๆ และผลลัพธ์ถูกแช่แข็งลึกเพื่อให้ route/service อ่านวัตถุเดียวกันโดยไม่มีใครแก้ระหว่างรัน
// ⚠️ เพดานชุดนี้ "ไม่ใช่" เพดานอัปโหลด — ไม่มีค่าใดที่นี่แตะ MAX_LOGICAL_FILE_BYTES หรือ chunk
//    (spec §5, §18: ขนาดไบต์ของต้นฉบับไม่มีเพดาน; ความปลอดภัยมาจาก pixel/เวลา/probesize/output)
// ⚠️ MEDIA_PROFILE_VERSION คือส่วนหนึ่งของตัวตน derivative (path บนดิสก์, media-info, URL `p=`,
//    ETag) — เปลี่ยนความหมายของ v1 ไม่ได้ ต้องเพิ่มเป็น v2 (spec §12)

import path from 'node:path'

export const MEDIA_PROFILE_VERSION = 'v1'

const KIB = 1024
const MIB = 1_048_576
const GIB = 1_073_741_824

/** batch ids ต่อคำขอ media-info — สัญญาบนสาย ไม่ใช่ปุ่มปรับของผู้ดูแล (spec §14.2) */
const BATCH_MAX_IDS = 64

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

function readInteger(env, name, fallback, { min, max }) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is not a safe integer`)
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}

function readFraction(env, name, fallback) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be a fraction in (0, 1)`)
  }
  return value
}

function readEnum(env, name, fallback, allowed) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback
  if (!allowed.includes(raw)) throw new Error(`${name} must be one of ${allowed.join('|')}`)
  return raw
}

function readBoolean(env, name, fallback) {
  const raw = String(env[name] ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function readAbsolutePath(env, name, fallback) {
  // ⚠️ ไม่มี key = ค่าเริ่มต้น; มี key แต่ว่าง = ตั้งค่าผิด (ไม่ใช่ "ใช้ค่าเริ่มต้น" เงียบ ๆ)
  //    Production เป็น Linux (posix) แต่ชุดทดสอบบนเครื่องพัฒนา Windows ต้องชี้ tmp dir ของตัวเองได้
  if (env[name] === undefined) return fallback
  const raw = String(env[name]).trim()
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(raw)
  if (!raw || !(path.posix.isAbsolute(raw) || windowsAbsolute)) throw new Error(`${name} must be an absolute path`)
  const normalised = windowsAbsolute ? path.win32.normalize(raw) : path.posix.normalize(raw)
  // ตัด separator ท้าย แต่ไม่ตัด root เอง ('/' และ 'C:\' คงเดิม)
  const stripped = normalised.replace(/[\\/]+$/, '')
  return stripped === '' || /^[A-Za-z]:$/.test(stripped) ? normalised : stripped
}

/**
 * อ่านเพดานทั้งชุดจาก environment — โยน error ทันทีเมื่อค่าไม่ถูกต้อง
 * @param {Record<string, string|undefined>} [env]
 */
export function mediaLimitsFromEnv(env = process.env) {
  const limits = {
    profile: MEDIA_PROFILE_VERSION,
    enabled: readBoolean(env, 'MEDIA_ENABLED', true),
    cacheDir: readAbsolutePath(env, 'MEDIA_CACHE_DIR', '/var/cache/aegis-media'),
    cacheMaxBytes: readInteger(env, 'MEDIA_CACHE_MAX_BYTES', 2 * GIB, { min: 64 * MIB, max: Number.MAX_SAFE_INTEGER }),
    cacheLowWater: readFraction(env, 'MEDIA_CACHE_LOW_WATER', 0.8),
    cacheFreeReserveBytes: readInteger(env, 'MEDIA_CACHE_FREE_RESERVE_BYTES', 512 * MIB, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    cachePolicy: readEnum(env, 'MEDIA_CACHE_POLICY', 'immutable', ['immutable', 'revalidate']),
    workers: readInteger(env, 'MEDIA_WORKERS', 1, { min: 1, max: 2 }),
    decoderThreads: readInteger(env, 'MEDIA_FFMPEG_DECODER_THREADS', 1, { min: 1, max: 8 }),
    filterThreads: readInteger(env, 'MEDIA_FFMPEG_FILTER_THREADS', 1, { min: 1, max: 8 }),
    encoderThreads: readInteger(env, 'MEDIA_FFMPEG_ENCODER_THREADS', 2, { min: 1, max: 8 }),
    maxSourcePixels: readInteger(env, 'MEDIA_MAX_SOURCE_PIXELS', 40_000_000, { min: 1_000_000, max: 400_000_000 }),
    maxVideoFramePixels: readInteger(env, 'MEDIA_MAX_VIDEO_FRAME_PIXELS', 35_389_440, { min: 1_000_000, max: 400_000_000 }),
    posterBox: { width: 640, height: 360 },
    motionBox: { width: 480, height: 270 },
    motionFps: readInteger(env, 'MEDIA_MOTION_FPS', 12, { min: 1, max: 30 }),
    motionMaxSeconds: readInteger(env, 'MEDIA_MOTION_MAX_SECONDS', 6, { min: 1, max: 15 }),
    probesizeBytes: readInteger(env, 'MEDIA_PROBESIZE_BYTES', 32 * MIB, { min: MIB, max: GIB }),
    posterMaxBytes: readInteger(env, 'MEDIA_POSTER_MAX_BYTES', 512 * KIB, { min: 16 * KIB, max: 16 * MIB }),
    motionMaxBytes: readInteger(env, 'MEDIA_MOTION_MAX_BYTES', 4 * MIB, { min: 64 * KIB, max: 64 * MIB }),
    probeTimeoutMs: readInteger(env, 'MEDIA_PROBE_TIMEOUT_MS', 20_000, { min: 1000, max: 600_000 }),
    posterTimeoutMs: readInteger(env, 'MEDIA_POSTER_TIMEOUT_MS', 60_000, { min: 1000, max: 600_000 }),
    motionTimeoutMs: readInteger(env, 'MEDIA_MOTION_TIMEOUT_MS', 120_000, { min: 1000, max: 600_000 }),
    queueMax: readInteger(env, 'MEDIA_QUEUE_MAX', 500, { min: 1, max: 10_000 }),
    stillEngine: readEnum(env, 'MEDIA_STILL_ENGINE', 'sharp', ['sharp', 'ffmpeg']),
    batchMaxIds: BATCH_MAX_IDS,
  }
  return deepFreeze(limits)
}

/** ค่าเริ่มต้นของทุก deployment — ตรึงไว้ให้ชุดทดสอบเทียบได้แบบ deep-equal */
export const MEDIA_DEFAULTS = mediaLimitsFromEnv({})
