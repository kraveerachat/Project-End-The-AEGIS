// tests/helpers/mediaFixtures.mjs — AEGIS Drive (IDEA1) · media fixtures generated at test time (never committed)
//
// ⚠️ ไม่มีไบนารีขนาดใหญ่ใน Git: ทุกไฟล์ถูกสร้างใน tmp ตอนรันด้วย ffmpeg ของเครื่อง (supplemental) หรือ
//    ประกอบเป็นไบต์ด้วยมือ (crafted) — fixture ที่สร้างไม่ได้เพราะไม่มีเครื่องมือ/encoder จะคืน
//    { skipped: reason } ให้ชุดทดสอบ skip อย่างซื่อสัตย์ ไม่ใช่แกล้งผ่าน
// ⚠️ helper นี้ไม่ import sharp (และไม่มี devDependency ใด ๆ) — ต้องรันได้ใน runtime image ที่ไม่มี devDependencies

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import zlib from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'

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

/* ════════════════════════════════════════════════════════════════════════════
   byte-class fixtures (plan Task 16) — สร้างตอนรันเท่านั้น ขนาดพิสูจน์ด้วย stat; ถึงแถบไม่ได้ใน 6 รอบ = throw (→ NOT_PROVEN)
   ═══════════════════════════════════════════════════════════════════════════ */

export const MiB = 1024 * 1024
export const BYTE_CLASSES = Object.freeze({
  still200: { lo: 180 * MiB, hi: 240 * MiB }, still300: { lo: 280 * MiB, hi: 340 * MiB },
  gif518k: { lo: 400 * 1024, hi: 640 * 1024 }, gif49m: { lo: 45 * MiB, hi: 55 * MiB },
  anim200: { lo: 180 * MiB, hi: 240 * MiB }, anim300: { lo: 280 * MiB, hi: 340 * MiB },
  video196: { lo: 176 * MiB, hi: 216 * MiB },
})

/** PNG 16-bit noise (deterministic xorshift) เขียนแบบ stream — ขนาด ≈ w×h×channels×2 (noise บีบอัดไม่ได้) */
export async function makeNoisePng({ out, width, height, channels = 3, seed = 0x9e3779b9 }) {
  const colorType = channels === 4 ? 6 : 2
  const rowBytes = 1 + width * channels * 2
  let x = seed >>> 0 || 1
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x }
  const rows = (async function * () {
    const row = Buffer.alloc(rowBytes)
    for (let y = 0; y < height; y += 1) {
      row[0] = 0
      for (let i = 1; i < rowBytes; i += 4) { const v = next(); row[i] = v & 0xff; row[i + 1] = (v >>> 8) & 0xff; row[i + 2] = (v >>> 16) & 0xff; row[i + 3] = (v >>> 24) & 0xff }
      yield Buffer.from(row)
    }
  })()
  const ws = createWriteStream(out)
  const write = (b) => new Promise((resolve, reject) => ws.write(b, (e) => (e ? reject(e) : resolve())))
  await write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  await write(pngChunk('IHDR', (() => { const b = Buffer.alloc(13); b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4); b[8] = 16; b[9] = colorType; return b })()))
  // IDAT หลายชิ้น (ชิ้นละ ≤ 8 MiB) จาก deflate level 1
  const deflate = zlib.createDeflate({ level: 1, chunkSize: 1 << 20 })
  let pending = []
  let pendingBytes = 0
  const flushIdat = async () => { if (pendingBytes === 0) return; await write(pngChunk('IDAT', Buffer.concat(pending))); pending = []; pendingBytes = 0 }
  const sink = new Writable({ write(chunk, _enc, cb) { pending.push(chunk); pendingBytes += chunk.length; if (pendingBytes >= 8 * MiB) flushIdat().then(() => cb(), cb); else cb() } })
  await pipeline(Readable.from(rows), deflate, sink)
  await flushIdat()
  await write(pngChunk('IEND'))
  await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())))
  const bytes = (await fs.stat(out)).size
  return { path: out, bytes, width, height, pixels: width * height, format: channels === 4 ? 'png-rgba16' : 'png-rgb16' }
}

/** ค้นหา -t ให้ขนาดไฟล์อยู่ในแถบ [lo, hi] ภายใน ≤ 6 รอบ (สัดส่วนเชิงเส้น) — ไม่ถึง = throw */
async function growToBand({ gen, lo, hi, guessSeconds, maxIters = 6 }) {
  let t = guessSeconds
  const tried = []
  for (let i = 0; i < maxIters; i += 1) {
    const r = await gen(t)
    tried.push({ t, bytes: r.bytes })
    if (r.bytes >= lo && r.bytes <= hi) return { ...r, seconds: t, iterations: i + 1 }
    const target = (lo + hi) / 2
    t = Math.max(0.5, t * (target / Math.max(1, r.bytes)))
    t = Math.round(t * 10) / 10
  }
  throw new Error(`byte class not reached in ${maxIters} iterations: ${JSON.stringify(tried)}`)
}

const noiseSrc = (size, rate, { lowFirstWindow = false } = {}) => [
  '-f', 'lavfi', '-i', `nullsrc=size=${size}:rate=${rate},format=rgb24,noise=alls=100:allf=t+u${lowFirstWindow ? ":enable='gte(t,6.5)'" : ''}`,
]

/**
 * fixture แบบ byte-class (ต้องมี ffmpeg ที่ระบุ — ใน gate คือตัวใน image); คืน { path, bytes, width, height, pixels, format, frames?, seconds? } หรือ throw
 * @param {{ dir: string, ffmpegBin?: string, klass: string, variant?: 'hi'|'lo', codec?: 'gif'|'apng' }} o
 */
export async function makeByteClassFixture({ dir, ffmpegBin = 'ffmpeg', klass, variant = 'hi', codec = 'gif' }) {
  const band = BYTE_CLASSES[klass]
  if (!band) throw new Error(`unknown byte class ${klass}`)
  const run = async (name, args, timeoutMs = 900_000) => {
    const file = path.join(dir, name)
    const r = await exec(ffmpegBin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args, file], timeoutMs)
    if (!r.ok) throw new Error(`ffmpeg failed for ${name}: ${r.stderr.trim().split('\n').pop() ?? ''}`)
    return stat(file)
  }
  switch (klass) {
    case 'still200': return makeNoisePng({ out: path.join(dir, 'still-200mb.png'), width: 7000, height: 5000, channels: 3 })
    case 'still300': return makeNoisePng({ out: path.join(dir, 'still-300mb.png'), width: 8000, height: 5000, channels: 4 })
    case 'gif518k': {
      const r = await growToBand({ lo: band.lo, hi: band.hi, guessSeconds: 2, gen: (t) => run('gif-518k.gif', [...noiseSrc('160x120', 10), '-t', String(t), '-f', 'gif']) })
      return { ...r, width: 160, height: 120, pixels: 160 * 120, format: 'gif', frames: Math.round(r.seconds * 10) }
    }
    case 'gif49m': {
      const r = await growToBand({ lo: band.lo, hi: band.hi, guessSeconds: 40, gen: (t) => run('gif-49mb.gif', [...noiseSrc('320x240', 10), '-t', String(t), '-f', 'gif']) })
      return { ...r, width: 320, height: 240, pixels: 320 * 240, format: 'gif', frames: Math.round(r.seconds * 10) }
    }
    case 'anim200':
    case 'anim300': {
      const size = '640x480'
      const guess = klass === 'anim200' ? (codec === 'gif' ? 70 : 24) : (codec === 'gif' ? 105 : 36)
      const name = `anim-${klass}-${codec}-${variant}.${codec === 'gif' ? 'gif' : 'png'}`
      const enc = codec === 'gif' ? ['-f', 'gif'] : ['-c:v', 'apng', '-plays', '0', '-f', 'apng']
      const r = await growToBand({ lo: band.lo, hi: band.hi, guessSeconds: guess, gen: (t) => run(name, [...noiseSrc(size, 10, { lowFirstWindow: variant === 'lo' }), '-t', String(t), ...enc]) })
      return { ...r, width: 640, height: 480, pixels: 640 * 480, format: codec, frames: Math.round(r.seconds * 10), variant }
    }
    case 'video196': {
      const r = await growToBand({ lo: band.lo, hi: band.hi, guessSeconds: 66, gen: (t) => run('video-196mb.mp4', [...noiseSrc('1280x720', 24), '-t', String(t), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '24M', '-maxrate', '24M', '-bufsize', '48M', '-movflags', '+faststart']) })
      return { ...r, width: 1280, height: 720, pixels: 1280 * 720, format: 'mp4/h264' }
    }
    default: throw new Error(`unhandled class ${klass}`)
  }
}
