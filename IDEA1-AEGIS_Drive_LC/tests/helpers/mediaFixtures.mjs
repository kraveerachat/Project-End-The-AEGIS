// tests/helpers/mediaFixtures.mjs — AEGIS Drive (IDEA1) · media fixtures generated at test time (never committed)
//
// ⚠️ ไม่มีไบนารีขนาดใหญ่ใน Git: ทุกไฟล์ถูกสร้างใน tmp ตอนรันด้วย ffmpeg ของเครื่อง (supplemental) หรือ
//    ประกอบเป็นไบต์ด้วยมือ (crafted) — fixture ที่สร้างไม่ได้เพราะไม่มีเครื่องมือ/encoder จะคืน
//    { skipped: reason } ให้ชุดทดสอบ skip อย่างซื่อสัตย์ ไม่ใช่แกล้งผ่าน
// ⚠️ ไม่มี sharp ใน package.json ของสาขานี้ (Task 15 เป็นผู้เพิ่ม) — helper นี้ไม่ import sharp

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

const exec = (bin, args, timeoutMs = 60_000) => new Promise((resolve) => {
  execFile(bin, args, { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err })
  })
})

/** ffmpeg บนเครื่อง (ถ้ามี) — ไว้สร้าง fixture เท่านั้น ไม่ใช่ toolchain ที่ใช้ตัดสิน PASS ของ Production */
export async function hostTools() {
  const ff = await exec('ffmpeg', ['-hide_banner', '-version'], 10_000)
  const fp = await exec('ffprobe', ['-hide_banner', '-version'], 10_000)
  if (!ff.ok || !fp.ok) return { ffmpeg: false, ffprobe: fp.ok, encoders: new Set(), decoders: new Set(), version: null }
  const enc = await exec('ffmpeg', ['-hide_banner', '-encoders'], 10_000)
  const dec = await exec('ffmpeg', ['-hide_banner', '-decoders'], 10_000)
  const names = (txt) => new Set([...txt.matchAll(/^\s*[A-Z.]{6}\s+([A-Za-z0-9_-]+)\b/gm)].map((m) => m[1]))
  const v = /version\s+n?(\d+)\.(\d+)/.exec(ff.stdout)
  return { ffmpeg: true, ffprobe: true, encoders: names(enc.stdout), decoders: names(dec.stdout), version: v ? `${v[1]}.${v[2]}` : null }
}

async function stat(p) { return { path: p, bytes: (await fs.stat(p)).size } }

/**
 * สร้างชุด fixture ลง dir — แต่ละรายการคือ { path, bytes } หรือ { skipped: reason }
 * @param {string} dir
 * @param {{ tools?: Awaited<ReturnType<typeof hostTools>> }} [opts]
 */
export async function makeFixtures(dir, { tools } = {}) {
  const t = tools ?? await hostTools()
  const out = {}
  const gen = async (name, args, needEncoder) => {
    if (!t.ffmpeg) return { skipped: 'FFMPEG_NOT_ON_HOST' }
    if (needEncoder && !t.encoders.has(needEncoder)) return { skipped: `ENCODER_${needEncoder.toUpperCase()}_MISSING` }
    const file = path.join(dir, name)
    const r = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args, file])
    if (!r.ok) return { skipped: `FFMPEG_FAILED:${name}:${r.stderr.trim().split('\n').pop() ?? ''}`.slice(0, 200) }
    return stat(file)
  }
  const src = (size, rate, seconds) => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}`, '-t', String(seconds)]

  out.stillJpeg = await gen('still.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '5'], 'mjpeg')
  out.stillPng = await gen('still.png', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1', '-frames:v', '1', '-c:v', 'png'], 'png')
  out.apng = await gen('anim.png', [...src('64x64', 5, 1), '-c:v', 'apng', '-plays', '0', '-f', 'apng'], 'apng')
  out.bmp = await gen('still.bmp', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1', '-frames:v', '1', '-c:v', 'bmp'], 'bmp')
  out.stillWebp = await gen('still.webp', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1', '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0'], 'libwebp')
  out.animatedWebp = await gen('anim.webp', [...src('64x64', 5, 1), '-c:v', 'libwebp_anim', '-loop', '0'], 'libwebp_anim')
  const av1Encoder = ['libaom-av1', 'libsvtav1', 'librav1e'].find((e) => t.encoders.has(e))
  out.stillAvif = av1Encoder
    ? await gen('still.avif', ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1', '-frames:v', '1', '-c:v', av1Encoder, '-still-picture', '1', '-f', 'avif'], av1Encoder)
    : { skipped: 'AV1_ENCODER_MISSING' }
  out.animatedAvif = av1Encoder
    ? await gen('anim.avif', [...src('64x64', 5, 1), '-c:v', av1Encoder, '-f', 'avif'], av1Encoder)
    : { skipped: 'AV1_ENCODER_MISSING' }
  out.oneFrameGif = await gen('one.gif', ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1', '-frames:v', '1', '-f', 'gif'], 'gif')
  out.multiFrameGif = await gen('multi.gif', [...src('64x64', 5, 2), '-f', 'gif'], 'gif')
  out.mp4Faststart = await gen('fast.mp4', [...src('160x90', 10, 4), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], 'libx264')
  out.mp4MoovAtEnd = await gen('tail.mp4', [...src('160x90', 10, 4), '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 'libx264')
  out.webmWithCues = await gen('cues.webm', [...src('160x90', 10, 4), '-c:v', 'libvpx', '-b:v', '200k'], 'libvpx')
  out.webmWithoutCues = await gen('nocues.webm', [...src('160x90', 10, 4), '-c:v', 'libvpx', '-b:v', '200k', '-live', '1'], 'libvpx')

  // crafted, tool-free
  const mismatched = path.join(dir, 'mismatched.jpg')
  await fs.writeFile(mismatched, '<html><body>not a jpeg</body></html>')
  out.mismatchedJpeg = await stat(mismatched)
  const pngNamedJpg = path.join(dir, 'png-named.jpg')
  if (out.stillPng.path) { await fs.copyFile(out.stillPng.path, pngNamedJpg); out.pngNamedJpg = await stat(pngNamedJpg) } else out.pngNamedJpg = { skipped: 'FFMPEG_NOT_ON_HOST' }
  if (out.mp4Faststart.path) {
    const buf = await fs.readFile(out.mp4Faststart.path)
    const trunc = path.join(dir, 'truncated.mp4')
    await fs.writeFile(trunc, buf.subarray(0, Math.floor(buf.length * 0.4)))
    out.truncatedMp4 = await stat(trunc)
  } else out.truncatedMp4 = { skipped: 'FFMPEG_NOT_ON_HOST' }
  return out
}

/* ── crafted headers (ไม่ต้องมีเครื่องมือ) ─────────────────────────────────── */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
export function pngChunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}
export function ihdr(width, height) {
  const d = Buffer.alloc(13); d.writeUInt32BE(width, 0); d.writeUInt32BE(height, 4); d[8] = 8; d[9] = 6; d[10] = 0; d[11] = 0; d[12] = 0
  return pngChunk('IHDR', d)
}
export function actl(numFrames, numPlays = 0) {
  const d = Buffer.alloc(8); d.writeUInt32BE(numFrames, 0); d.writeUInt32BE(numPlays, 4)
  return pngChunk('acTL', d)
}
/** PNG/APNG ที่ประกอบเอง: chunks คือรายการหลัง IHDR ก่อน IDAT (เช่น tEXt ยาว ๆ, acTL) */
export function craftedPng({ width = 4, height = 4, chunks = [], withIdat = true } = {}) {
  const parts = [PNG_SIG, ihdr(width, height), ...chunks]
  if (withIdat) parts.push(pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])))
  parts.push(pngChunk('IEND'))
  return Buffer.concat(parts)
}
export function textChunk(bytes) { return pngChunk('tEXt', Buffer.alloc(bytes, 0x41)) }

/** WebP header ที่ประกอบเอง: VP8X (extended) พร้อมธง animation หรือ VP8 ธรรมดา */
export function craftedWebp({ vp8x = true, animation = false, width = 16, height = 16, frames = 0, frameBytes = 8 } = {}) {
  const canvas = Buffer.alloc(6)
  canvas.writeUIntLE(width - 1, 0, 3); canvas.writeUIntLE(height - 1, 3, 3)
  const flags = Buffer.from([animation ? 0x02 : 0x00, 0, 0, 0])
  const chunk = vp8x
    ? Buffer.concat([Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), flags, canvas])
    : Buffer.concat([Buffer.from('VP8 '), Buffer.from([4, 0, 0, 0]), Buffer.from([0, 0, 0, 0])])
  const riffChunk = (type, payload) => { const size = Buffer.alloc(4); size.writeUInt32LE(payload.length); return Buffer.concat([Buffer.from(type), size, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]) }
  const anim = frames > 0 ? [riffChunk('ANIM', Buffer.alloc(6))] : []
  const anmf = Array.from({ length: frames }, () => riffChunk('ANMF', Buffer.alloc(16 + frameBytes)))
  const body = Buffer.concat([Buffer.from('WEBP'), chunk, ...anim, ...anmf])
  const size = Buffer.alloc(4); size.writeUInt32LE(body.length)
  return Buffer.concat([Buffer.from('RIFF'), size, body])
}

/** ISO-BMFF ftyp box ที่ประกอบเอง (major + compatible brands) */
export function craftedFtyp(major, compatible = []) {
  const brands = Buffer.concat([Buffer.from(major.padEnd(4)), Buffer.from([0, 0, 0, 0]), ...compatible.map((b) => Buffer.from(b.padEnd(4)))])
  const size = Buffer.alloc(4); size.writeUInt32BE(8 + brands.length)
  return Buffer.concat([size, Buffer.from('ftyp'), brands])
}

/** GIF header ที่ประกอบเอง (logical screen size) — ไม่มีเฟรม */
export function craftedGifHeader(width = 8, height = 8) {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(width, 6); b.writeUInt16LE(height, 8); b[10] = 0; b[11] = 0; b[12] = 0
  return b
}
