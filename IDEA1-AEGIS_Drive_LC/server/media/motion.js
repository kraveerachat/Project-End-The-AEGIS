// server/media/motion.js — AEGIS Drive (IDEA1) · motion proxy (hover playback) ลง tmpPath ที่ผู้เรียกกำหนด
//
// ⚠️ สัญญา (spec §9): FFmpeg เท่านั้น → MP4/H.264 (libx264 veryfast, yuv420p, main 3.1, faststart) fit-inside
//    480×270 (คู่), 12 fps, หน้าต่าง 6 s, ไม่มีเสียง, ≤ motionMaxBytes — เกินเพดาน = ล้มเหลวถาวร (ไม่ค้นหาคุณภาพ)
// ⚠️ ความจริงเรื่องขอบเขต: `-t 6.5` ฝั่ง input จำกัด "หน้าต่างเวลาที่ demux/ถอดรหัส" ไม่ใช่จำนวนไบต์ของต้นฉบับ —
//    GIF/APNG ที่ bitrate สูงอาจต้องอ่านไบต์มากในหกวินาทีแรก ขอบเขตที่รับประกันคือ เวลา/พิกเซล/concurrency/
//    timeout/ขนาดผลลัพธ์ และ "ไม่มี Buffer ของต้นฉบับใน Node" (spec §9, §18) — I/O จริงถูกวัดใน Task 16
// ⚠️ ทำเฉพาะเมื่อ probe พิสูจน์ว่าเคลื่อนไหว (animated === true): นิ่ง → NOT_ANIMATED, พิสูจน์ไม่ได้ →
//    ANIMATION_UNKNOWN — ไม่มีวันเดาแล้วสั่ง encode; decoder ของตระกูลต้องมีจริงตาม capability probe
// ⚠️ ไม่มีการ spawn โปรเซสเองที่นี่ (ผ่าน runner เท่านั้น), ไม่มี shell, เขียนเฉพาะ tmpPath (Task 7 rename เข้า cache)

import fsp from 'node:fs/promises'
import { MediaJobError } from './poster.js'
import { truncateUtf8Bytes } from './probe.js'

export const MOTION_ENCODE = Object.freeze({ preset: 'veryfast', crf: 28, maxrate: '1200k', bufsize: '2400k', gop: 24, profile: 'main', level: '3.1' })
const STDERR_DETAIL_BYTES = 512
const permanent = (reason, detail) => new MediaJobError({ class: 'PERMANENT', reason, detail })
const transient = (reason, detail) => new MediaJobError({ class: 'TRANSIENT', reason, detail })

/**
 * อาร์กิวเมนต์ FFmpeg ของ motion proxy — แหล่งเดียวของ array นี้ (spec §9)
 * @param {{ absPath: string, tmpPath: string, limits: object }} o
 */
export function motionArgs({ absPath, tmpPath, limits }) {
  const { width: W, height: H } = limits.motionBox
  const window = limits.motionMaxSeconds
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
    '-threads', String(limits.decoderThreads), '-filter_threads', String(limits.filterThreads),
    '-probesize', String(limits.probesizeBytes), '-analyzeduration', '5000000',
    '-ss', '0', '-t', String(window + 0.5), '-i', absPath,
    '-an', '-t', String(window),
    '-vf', `fps=${limits.motionFps},scale='min(${W},iw)':'min(${H},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
    '-c:v', 'libx264', '-threads:v', String(limits.encoderThreads), '-preset', MOTION_ENCODE.preset, '-crf', String(MOTION_ENCODE.crf),
    '-maxrate', MOTION_ENCODE.maxrate, '-bufsize', MOTION_ENCODE.bufsize, '-g', String(MOTION_ENCODE.gop), '-profile:v', MOTION_ENCODE.profile, '-level', MOTION_ENCODE.level,
    '-movflags', '+faststart', '-f', 'mp4', '-y', tmpPath,
  ]
}

/** decoder ที่ตระกูล/codec นี้ต้องมีตาม capability probe (spec §6) */
function requiredDecoder(probe) {
  switch (probe.family) {
    case 'gif': return 'gif'
    case 'png': return 'apng'
    case 'webp': return 'webpAnimated'
    case 'avif': return 'av1'
    case 'mp4':
    case 'webm': {
      const codec = String(probe.codec ?? '').toLowerCase()
      if (['h264', 'vp8', 'vp9', 'av1'].includes(codec)) return codec
      return probe.family === 'mp4' ? 'h264' : 'vp9'
    }
    default: return null
  }
}

/** ขนาดที่ขอ (fit-inside, ไม่ขยาย, คู่) — ค่าที่ FFmpeg จะได้จาก scale filter ข้างบน */
function requestedGeometry(probe, limits) {
  const { width: W, height: H } = limits.motionBox
  const scale = Math.min(1, W / probe.width, H / probe.height)
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2)
  return { width: even(Math.round(probe.width * scale)), height: even(Math.round(probe.height * scale)) }
}

const removeTmp = (tmpPath) => fsp.rm(tmpPath, { force: true }).catch(() => {})

/**
 * @param {{ absPath: string, probe: object, tmpPath: string, limits: object, capabilities: object,
 *           runner: { run: Function }, ffmpegBin?: string }} o
 * @returns {Promise<{ file: 'motion.mp4', mime: 'video/mp4', width: number, height: number, fps: number, seconds: number, bytes: number, engine: 'ffmpeg' }>}
 */
export async function generateMotion({ absPath, probe, tmpPath, limits, capabilities, runner, ffmpegBin = 'ffmpeg' }) {
  if (typeof absPath !== 'string' || !absPath || typeof tmpPath !== 'string' || !tmpPath) throw permanent('ENCODE_FAILED', { message: 'absPath and tmpPath are required' })
  if (!probe || probe.unsupported) throw permanent('ENCODE_FAILED', { message: 'probe result missing or unsupported' })
  if (probe.animated === false) throw permanent('NOT_ANIMATED', { family: probe.family, evidence: probe.animationEvidence ?? null })
  if (probe.animated !== true) throw permanent('ANIMATION_UNKNOWN', { family: probe.family, evidence: probe.animationEvidence ?? null })
  if (!capabilities?.ffmpeg?.ok) throw permanent('ENCODER_UNAVAILABLE', { cause: 'FFMPEG_UNAVAILABLE' })
  if (!capabilities?.encoders?.libx264) throw permanent('ENCODER_UNAVAILABLE', { cause: 'ENCODER_LIBX264_MISSING' })
  const decoder = requiredDecoder(probe)
  if (!decoder) throw permanent('NOT_ANIMATED', { family: probe.family, message: 'family has no motion path' })
  if (!capabilities?.decoders?.[decoder]) throw permanent('DECODER_UNAVAILABLE', { family: probe.family, decoder })

  let result
  try {
    result = await runner.run({ bin: ffmpegBin, args: motionArgs({ absPath, tmpPath, limits }), timeoutMs: limits.motionTimeoutMs })
  } catch (err) {
    await removeTmp(tmpPath)
    if (err?.code === 'ENOENT') throw permanent('ENCODER_UNAVAILABLE', { bin: ffmpegBin })
    if (err && ['ENOSPC', 'EDQUOT', 'EIO'].includes(err.code)) throw transient('DISK', { code: err.code })
    throw permanent('ENCODE_FAILED', { message: truncateUtf8Bytes(err?.message, STDERR_DETAIL_BYTES) })
  }
  if (result.timedOut) { await removeTmp(tmpPath); throw transient('TIMEOUT', { timedOut: true, killed: Boolean(result.killed), timeoutMs: limits.motionTimeoutMs }) }
  if (result.code !== 0) {
    await removeTmp(tmpPath)
    throw permanent('ENCODE_FAILED', { exitCode: result.code, signal: result.signal ?? null, stderr: truncateUtf8Bytes(result.stderr, STDERR_DETAIL_BYTES) })
  }
  let bytes = 0
  try { const st = await fsp.stat(tmpPath); bytes = st.isFile() ? st.size : 0 } catch { bytes = 0 }
  if (bytes <= 0) { await removeTmp(tmpPath); throw permanent('ENCODE_FAILED', { message: 'ffmpeg exited 0 without writing a proxy' }) }
  if (bytes > limits.motionMaxBytes) { await removeTmp(tmpPath); throw permanent('OUTPUT_TOO_LARGE', { bytes, cap: limits.motionMaxBytes, retries: 0 }) }

  const geometry = requestedGeometry(probe, limits)
  const seconds = Number.isFinite(probe.durationSeconds) && probe.durationSeconds > 0 ? Math.min(probe.durationSeconds, limits.motionMaxSeconds) : limits.motionMaxSeconds
  return { file: 'motion.mp4', mime: 'video/mp4', width: geometry.width, height: geometry.height, fps: limits.motionFps, seconds, bytes, engine: 'ffmpeg' }
}
