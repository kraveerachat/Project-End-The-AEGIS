// server/media/poster.js — AEGIS Drive (IDEA1) · สร้าง poster นิ่งหนึ่งใบลง tmpPath ที่ผู้เรียกกำหนด
//
// ⚠️ ขอบเขต (spec §8, §10, §18, §22): โมดูลนี้ "ผลิต" อย่างเดียว — เขียนเฉพาะ tmpPath ที่ได้รับ ไม่ rename
//    เข้า cache ไม่เขียน state/probe ไม่แตะ DB ไม่แตะต้นฉบับ (เปิดอ่านเท่านั้น) — Task 7 เป็นเจ้าของ
//    การประกอบ atomic (cache.writeAtomic) และการบันทึกสถานะ
// ⚠️ เครื่องยนต์: sharp สำหรับภาพนิ่ง jpeg/png/webp/avif (shrink-on-load / sequential read / เพดานพิกเซล
//    ก่อนถอดรหัส) เมื่อ MEDIA_STILL_ENGINE=sharp และ sharp โหลดได้; FFmpeg สำหรับ BMP, เฟรมแรกของ GIF/
//    AVIF เคลื่อนไหว, เฟรมวิดีโอ, และภาพนิ่งเมื่อสวิตช์ MEDIA_STILL_ENGINE=ffmpeg (rollback ตอนรัน)
// ⚠️ ผลลัพธ์: WebP q80 fit-inside 640×360 ไม่ขยาย ปอก metadata (EXIF/ICC/XMP — ไม่เรียกเมธอดคง metadata ใด ๆ)
//    แต่ใช้ orientation ก่อน resize และคง alpha; เกินเพดานไบต์ → ลองใหม่ q60 "ครั้งเดียว" แล้วล้มเหลว
//    PNG เฉพาะเมื่อ FFmpeg ไม่มี libwebp (sharp path ไม่ขึ้นกับ capability ของ FFmpeg)
// ⚠️ ไม่มีการ spawn โปรเซสเองที่นี่ (ผ่าน runner เท่านั้น), ไม่มี shell, ไม่มี import sharp เอง (inject จาก runtime)
//    และไม่ตั้งค่า thread pool ส่วนกลางของ sharp ต่อการเรียก — การตั้งค่า global ครั้งเดียวเป็นหน้าที่ของ runtime (Task 7/15)

import fsp from 'node:fs/promises'
import { truncateUtf8Bytes } from './probe.js'

export const POSTER_QUALITY = Object.freeze({ primary: 80, retry: 60 })
const PNG_COMPRESSION = Object.freeze({ primary: 6, retry: 9 })
const STDERR_DETAIL_BYTES = 512
const SHARP_STILL_FAMILIES = new Set(['jpeg', 'png', 'webp', 'avif'])
const VIDEO_FAMILIES = new Set(['mp4', 'webm'])

/** ข้อผิดพลาดของงาน media ที่ Task 6/7 ใช้ตัดสิน retry: class + reason คงที่, detail มีขอบเขต */
export class MediaJobError extends Error {
  /** @param {{ class: 'PERMANENT'|'TRANSIENT', reason: string, detail?: object, cause?: unknown }} opts */
  constructor({ class: cls, reason, detail = null, cause }) {
    super(`${cls} ${reason}`)
    this.name = 'MediaJobError'
    this.class = cls
    this.reason = reason
    this.detail = detail
    if (cause !== undefined) this.cause = cause
  }
}
const permanent = (reason, detail) => new MediaJobError({ class: 'PERMANENT', reason, detail })
const transient = (reason, detail) => new MediaJobError({ class: 'TRANSIENT', reason, detail })

/** เวลาที่ใช้ดึงเฟรม poster ของวิดีโอ: clamp(0.05·duration, 0.5 s, 3 s) แต่ไม่เกิน duration เอง */
export function videoPosterSeekSeconds(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  const clamped = Math.min(3, Math.max(0.5, durationSeconds * 0.05))
  return Math.min(clamped, durationSeconds)
}

/**
 * อาร์กิวเมนต์ FFmpeg สำหรับ poster หนึ่งเฟรม — แหล่งเดียวของ array นี้ (ทดสอบแบบ pure ได้)
 * @param {{ absPath: string, tmpPath: string, limits: object, encoder: 'libwebp'|'png', quality: number, seekSeconds?: number }} o
 */
export function ffmpegPosterArgs({ absPath, tmpPath, limits, encoder, quality, seekSeconds = 0 }) {
  const { width, height } = limits.posterBox
  const seek = seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []
  const codec = encoder === 'png'
    ? ['-c:v', 'png', '-compression_level', String(quality === POSTER_QUALITY.retry ? PNG_COMPRESSION.retry : PNG_COMPRESSION.primary), '-f', 'image2']
    : ['-c:v', 'libwebp', '-quality', String(quality), '-f', 'webp']
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
    '-threads', String(limits.decoderThreads), '-filter_threads', String(limits.filterThreads),
    '-probesize', String(limits.probesizeBytes), '-analyzeduration', '5000000',
    ...seek, '-i', absPath, '-frames:v', '1',
    '-vf', `scale='min(${width},iw)':'min(${height},ih)':force_original_aspect_ratio=decrease`,
    ...codec, '-y', tmpPath,
  ]
}

const removeTmp = (tmpPath) => fsp.rm(tmpPath, { force: true }).catch(() => {})

async function statBytes(tmpPath) {
  try {
    const st = await fsp.stat(tmpPath)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/** ขนาดภาพจากหัวไฟล์ poster (webp/png) เมื่อไม่มี sharp ให้ตรวจ — อ่านไม่เกิน 64 ไบต์ */
async function headerDims(tmpPath) {
  const fh = await fsp.open(tmpPath, 'r')
  try {
    const { buffer: b, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0)
    if (bytesRead >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    if (bytesRead >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = b.toString('latin1', 12, 16)
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
      if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 } }
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    }
    return null
  } finally {
    await fh.close()
  }
}

async function outputDims(tmpPath, sharp) {
  if (sharp) {
    try {
      const meta = await sharp(tmpPath).metadata()
      if (Number.isFinite(meta.width) && Number.isFinite(meta.height)) return { width: meta.width, height: meta.height }
    } catch { /* ตกไปอ่านหัวไฟล์ */ }
  }
  return headerDims(tmpPath)
}

function classifyFsError(err) {
  if (err && ['ENOSPC', 'EDQUOT', 'EIO'].includes(err.code)) return transient('DISK', { code: err.code })
  return null
}

/* ── sharp path ──────────────────────────────────────────────────────────── */
async function encodeWithSharp({ absPath, tmpPath, limits, sharp, quality }) {
  const { width, height } = limits.posterBox
  try {
    return await sharp(absPath, { limitInputPixels: limits.maxSourcePixels, sequentialRead: true, failOn: 'error' })
      .rotate()
      .resize(width, height, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .webp({ quality, effort: 4 })
      .toFile(tmpPath)
  } catch (err) {
    throw classifyFsError(err) ?? permanent('DECODE_FAILED', { engine: 'sharp', message: truncateUtf8Bytes(err?.message, STDERR_DETAIL_BYTES) })
  }
}

async function sharpPoster({ absPath, tmpPath, limits, sharp }) {
  let info = await encodeWithSharp({ absPath, tmpPath, limits, sharp, quality: POSTER_QUALITY.primary })
  let bytes = await statBytes(tmpPath)
  if (bytes > limits.posterMaxBytes) {
    // ลองใหม่ที่คุณภาพต่ำลง "ครั้งเดียว" — ไม่มีลูปปรับคุณภาพไม่รู้จบ
    info = await encodeWithSharp({ absPath, tmpPath, limits, sharp, quality: POSTER_QUALITY.retry })
    bytes = await statBytes(tmpPath)
    if (bytes > limits.posterMaxBytes) {
      await removeTmp(tmpPath)
      throw permanent('OUTPUT_TOO_LARGE', { bytes, cap: limits.posterMaxBytes, retries: 1 })
    }
  }
  if (bytes <= 0) { await removeTmp(tmpPath); throw permanent('DECODE_FAILED', { engine: 'sharp', message: 'empty output' }) }
  const dims = (Number.isFinite(info?.width) && Number.isFinite(info?.height)) ? { width: info.width, height: info.height } : await outputDims(tmpPath, sharp)
  return { file: 'poster.webp', mime: 'image/webp', width: dims?.width ?? null, height: dims?.height ?? null, bytes, engine: 'sharp' }
}

/* ── ffmpeg path ─────────────────────────────────────────────────────────── */
async function runFfmpegOnce({ absPath, tmpPath, limits, runner, ffmpegBin, encoder, quality, seekSeconds }) {
  let result
  try {
    result = await runner.run({ bin: ffmpegBin, args: ffmpegPosterArgs({ absPath, tmpPath, limits, encoder, quality, seekSeconds }), timeoutMs: limits.posterTimeoutMs })
  } catch (err) {
    await removeTmp(tmpPath)
    if (err?.code === 'ENOENT') throw permanent('ENCODER_UNAVAILABLE', { bin: ffmpegBin })
    throw classifyFsError(err) ?? permanent('DECODE_FAILED', { engine: 'ffmpeg', message: truncateUtf8Bytes(err?.message, STDERR_DETAIL_BYTES) })
  }
  if (result.timedOut) { await removeTmp(tmpPath); throw transient('TIMEOUT', { timedOut: true, killed: Boolean(result.killed), timeoutMs: limits.posterTimeoutMs }) }
  if (result.code !== 0) {
    await removeTmp(tmpPath)
    throw permanent('DECODE_FAILED', { engine: 'ffmpeg', exitCode: result.code, signal: result.signal ?? null, stderr: truncateUtf8Bytes(result.stderr, STDERR_DETAIL_BYTES) })
  }
  return statBytes(tmpPath)
}

async function ffmpegPoster({ absPath, probe, tmpPath, limits, capabilities, runner, sharp, ffmpegBin }) {
  if (!capabilities?.ffmpeg?.ok) throw permanent('ENCODER_UNAVAILABLE', { engine: 'ffmpeg', cause: 'FFMPEG_UNAVAILABLE' })
  const encoder = capabilities?.encoders?.libwebp ? 'libwebp' : 'png'
  const seekSeconds = VIDEO_FAMILIES.has(probe.family) ? videoPosterSeekSeconds(probe.durationSeconds) : 0
  const base = { absPath, tmpPath, limits, runner, ffmpegBin, encoder, seekSeconds }
  let bytes = await runFfmpegOnce({ ...base, quality: POSTER_QUALITY.primary })
  if (bytes > limits.posterMaxBytes) {
    bytes = await runFfmpegOnce({ ...base, quality: POSTER_QUALITY.retry })
    if (bytes > limits.posterMaxBytes) {
      await removeTmp(tmpPath)
      throw permanent('OUTPUT_TOO_LARGE', { bytes, cap: limits.posterMaxBytes, retries: 1 })
    }
  }
  if (bytes <= 0) { await removeTmp(tmpPath); throw permanent('DECODE_FAILED', { engine: 'ffmpeg', message: 'ffmpeg exited 0 without writing a poster' }) }
  const dims = await outputDims(tmpPath, sharp)
  const { width: maxW, height: maxH } = limits.posterBox
  if (!dims || !(dims.width > 0) || !(dims.height > 0) || dims.width > maxW || dims.height > maxH) {
    await removeTmp(tmpPath)
    throw permanent('DECODE_FAILED', { engine: 'ffmpeg', message: 'poster dimensions unreadable or outside the poster box', dims })
  }
  return encoder === 'png'
    ? { file: 'poster.png', mime: 'image/png', width: dims.width, height: dims.height, bytes, engine: 'ffmpeg' }
    : { file: 'poster.webp', mime: 'image/webp', width: dims.width, height: dims.height, bytes, engine: 'ffmpeg' }
}

/**
 * สร้าง poster ลง tmpPath — ผู้เรียก (Task 7) rename เข้า cache เอง
 * @param {{ absPath: string, probe: object, tmpPath: string, limits: object, capabilities: object,
 *           runner: { run: Function }, sharp?: Function|null, ffmpegBin?: string }} o
 * @returns {Promise<{ file: string, mime: string, width: number, height: number, bytes: number, engine: 'sharp'|'ffmpeg' }>}
 */
export async function generatePoster({ absPath, probe, tmpPath, limits, capabilities, runner, sharp = null, ffmpegBin = 'ffmpeg' }) {
  if (typeof absPath !== 'string' || !absPath || typeof tmpPath !== 'string' || !tmpPath) throw permanent('DECODE_FAILED', { message: 'absPath and tmpPath are required' })
  if (!probe || probe.unsupported) throw permanent('DECODE_FAILED', { message: 'probe result missing or unsupported' })
  const stillViaSharp = SHARP_STILL_FAMILIES.has(probe.family) && limits.stillEngine === 'sharp' && capabilities?.sharp?.ok && typeof sharp === 'function'
  if (stillViaSharp) {
    try {
      return await sharpPoster({ absPath, tmpPath, limits, sharp })
    } catch (err) {
      await removeTmp(tmpPath)
      throw err
    }
  }
  if (!capabilities?.ffmpeg?.ok) throw permanent('ENCODER_UNAVAILABLE', { engine: 'ffmpeg', cause: 'FFMPEG_UNAVAILABLE', sharpAvailable: Boolean(capabilities?.sharp?.ok && sharp) })
  try {
    return await ffmpegPoster({ absPath, probe, tmpPath, limits, capabilities, runner, sharp, ffmpegBin })
  } catch (err) {
    await removeTmp(tmpPath)
    throw err
  }
}
