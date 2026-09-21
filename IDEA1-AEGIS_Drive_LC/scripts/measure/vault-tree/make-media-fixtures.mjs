// scripts/measure/vault-tree/make-media-fixtures.mjs — PR #157 Phase 0 Task 0.2 · fixture generator
//
// ⚠️ DISPOSABLE. Writes synthetic media into a directory under os.tmpdir() only.
//    Nothing is committed. Classes whose tool is missing are recorded as
//    NOT_MEASURED in the manifest, never faked.
//
//   node scripts/measure/vault-tree/make-media-fixtures.mjs --out <dir>
//
// Produces:
//   image classes (sharp): jpeg/png/webp at target ~1, 4, 16, 32, 64 MiB — the
//     dimensions grow until the encoded byte size crosses the target; decoded
//     pixel counts are recorded (that is the quantity the product will bound).
//   animated gif (sharp, if the installed build supports gif output): 1, 4, 16, 32, 64 MiB
//   mp4 (ffmpeg, if present): 30 s 1280×720 and 3840×2160
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outDir = outIdx >= 0 ? args[outIdx + 1] : null
if (!outDir) { console.error('need --out <dir>'); process.exit(2) }
fs.mkdirSync(outDir, { recursive: true })

const MIB = 1_048_576
const TARGETS = [1, 4, 16, 32, 64]
const manifest = { generatedAt: new Date().toISOString(), tools: {}, fixtures: [] }

let sharp = null
try { sharp = (await import('sharp')).default; manifest.tools.sharp = sharp.versions } catch (e) { manifest.tools.sharp = 'NOT_AVAILABLE: ' + e.message }
const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
manifest.tools.ffmpeg = ffmpeg.status === 0 ? ffmpeg.stdout.split('\n')[0] : 'NOT_AVAILABLE'

// Noise image so that lossy/lossless encoders cannot compress it away: the byte
// size then tracks the pixel count, which is what we need to relate bytes ↔ pixels.
function noise(width, height) {
  const buf = Buffer.alloc(width * height * 3)
  let x = 0x9e3779b9
  for (let i = 0; i < buf.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; buf[i] = x & 0xff }
  return buf
}

async function imageClass(format, targetMiB) {
  if (!sharp) return { format, targetMiB, status: 'NOT_MEASURED', reason: 'sharp unavailable' }
  // grow square edge until encoded size ≥ target
  let edge = 512
  let encoded = null, tries = 0
  while (tries++ < 14) {
    const raw = noise(edge, edge)
    let img = sharp(raw, { raw: { width: edge, height: edge, channels: 3 } })
    if (format === 'jpeg') img = img.jpeg({ quality: 92 })
    else if (format === 'png') img = img.png({ compressionLevel: 6 })
    else if (format === 'webp') img = img.webp({ quality: 90 })
    encoded = await img.toBuffer()
    if (encoded.length >= targetMiB * MIB) break
    edge = Math.ceil(edge * Math.sqrt(Math.max(1.25, (targetMiB * MIB) / encoded.length)))
    if (edge > 16_384) break
  }
  const name = `${format}-${targetMiB}mib.${format === 'jpeg' ? 'jpg' : format}`
  fs.writeFileSync(path.join(outDir, name), encoded)
  return { name, format, targetMiB, bytes: encoded.length, width: edge, height: edge, pixels: edge * edge, status: 'OK' }
}

async function gifClass(targetMiB) {
  if (!sharp) return { format: 'gif', targetMiB, status: 'NOT_MEASURED', reason: 'sharp unavailable' }
  try {
    // animated noise GIF: frames stacked vertically as pages
    const edge = 512
    let frames = 4, encoded = null, tries = 0
    while (tries++ < 10) {
      const raw = Buffer.concat(Array.from({ length: frames }, (_, i) => noise(edge, edge).map((b, j) => (b + i * 37 + j) & 0xff)))
      encoded = await sharp(raw, { raw: { width: edge, height: edge * frames, channels: 3 }, animated: true })
        .gif({ colours: 256, dither: 1 }).toBuffer()
      if (encoded.length >= targetMiB * MIB) break
      frames = Math.ceil(frames * Math.max(1.3, (targetMiB * MIB) / encoded.length))
      if (frames > 400) break
    }
    const name = `gif-${targetMiB}mib.gif`
    fs.writeFileSync(path.join(outDir, name), encoded)
    return { name, format: 'gif', targetMiB, bytes: encoded.length, width: edge, height: edge, frames, pixelsPerFrame: edge * edge, status: 'OK' }
  } catch (e) {
    return { format: 'gif', targetMiB, status: 'NOT_MEASURED', reason: 'sharp gif output failed: ' + e.message }
  }
}

function mp4Class(width, height, seconds) {
  if (ffmpeg.status !== 0) return { format: 'mp4', width, height, seconds, status: 'NOT_MEASURED', reason: 'ffmpeg unavailable' }
  const name = `video-${width}x${height}-${seconds}s.mp4`
  const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(outDir, name)], { encoding: 'utf8' })
  if (r.status !== 0) return { format: 'mp4', width, height, seconds, status: 'NOT_MEASURED', reason: 'ffmpeg failed' }
  return { name, format: 'mp4', width, height, seconds, bytes: fs.statSync(path.join(outDir, name)).size, status: 'OK' }
}

for (const f of ['jpeg', 'png', 'webp']) for (const t of TARGETS) { const r = await imageClass(f, t); manifest.fixtures.push(r); console.error(JSON.stringify(r)) }
for (const t of TARGETS) { const r = await gifClass(t); manifest.fixtures.push(r); console.error(JSON.stringify(r)) }
manifest.fixtures.push(mp4Class(1280, 720, 30))
manifest.fixtures.push(mp4Class(3840, 2160, 30))
fs.writeFileSync(path.join(outDir, 'fixtures.json'), JSON.stringify(manifest, null, 2))
console.log(`fixtures written to ${outDir}`)
