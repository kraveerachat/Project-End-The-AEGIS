// server/storage/avatarStore.js — AEGIS Drive (IDEA1) · รูปโปรไฟล์ใน Storage Layer
//
// แยกโฟลเดอร์จาก uploads/ และ vault/ โดยเจตนา: avatars/ เป็นที่เดียวในระบบที่ไบต์
// ของผู้ใช้ถูกส่งกลับให้เบราว์เซอร์ "render เอง" (ไม่ใช่ attachment) ความเสี่ยงจึงคนละ
// ระดับกับไฟล์ใน Data Lake และต้องมีกฎของตัวเอง ไม่ใช่เกาะไปกับ fileStore.js
//
// ── สิ่งที่ไฟล์นี้รับประกัน (ทั้งสี่ข้อคือข้อกำหนด ไม่ใช่ความพยายาม) ─────────────────
//  1. ชนิดไฟล์ตัดสินจาก "ไบต์จริง" (magic bytes) เท่านั้น — ไม่เชื่อนามสกุลและไม่เชื่อ
//     Content-Type ที่ client แจ้งมา ทั้งสองอย่างนั้นผู้ใช้พิมพ์อะไรลงไปก็ได้
//     รับแค่ PNG กับ JPEG: SVG คือเอกสารที่รัน <script> ได้ (= XSS ใน origin ของแอป
//     เอง อ่าน CSRF token/ยิง API แทนผู้ใช้ได้) GIF/WebP ไม่ได้เพิ่มอะไรจึงไม่เปิดรับ
//  2. เพดานขนาด — บังคับสองชั้น: multer ตัดที่ขอบ (ไม่ให้ RAM โดนไฟล์ใหญ่) และตรวจ
//     ความยาว buffer อีกครั้งก่อนเขียน
//  3. ชื่อไฟล์บนดิสก์เป็น UUID ล้วน — ไม่มีเศษของชื่อที่ผู้ใช้ส่งมาปนแม้แต่นามสกุล
//     (นามสกุลมาจากชนิดที่ sniff ได้ ไม่ใช่จากชื่อเดิม)
//  4. metadata ถูกถอดออกก่อนเขียนลงดิสก์ — ไม่ใช่ก่อนส่งออก: ไบต์ที่นอนอยู่บนดิสก์
//     ต้องสะอาดตั้งแต่แรก ถ้าถอดตอนอ่าน ไฟล์ต้นฉบับที่มีพิกัด GPS ก็ยังอยู่บนดิสก์ต่อไป
//
// ⚠️ ทำไมเขียน parser เอง ไม่ใช้ sharp/imagemagick: ทั้งคู่เป็น native binary ก้อนใหญ่
//    บนเครื่องเป้าหมาย (Beelink 8GB, alpine) และการ re-encode ทั้งภาพเพื่อลบ metadata
//    คือการใช้เครื่องมือที่ใหญ่กว่าปัญหา — โครงสร้าง chunk ของ PNG และ segment ของ
//    JPEG ถูกกำหนดไว้ชัดเจน การ "คงไว้เฉพาะที่จำเป็นต่อการถอดภาพ" อ่านง่ายและ
//    ตรวจสอบได้ด้วยเทสต์ (ดู tests/profileAvatar.test.js ที่ยืนยันว่าไบต์ EXIF หายจริง)
//
// ⚠️ ข้อจำกัดที่ยอมรับไว้อย่างรู้ตัว: การถอด APP1 ทิ้งพา EXIF Orientation ไปด้วย
//    รูปถ่ายจากมือถือที่หมุนภาพด้วย Orientation แทนการหมุน pixel จริงจะแสดงตะแคง
//    การแก้ต้องหมุน pixel = ต้อง re-encode = ต้องมี codec ซึ่งเป็นการแลกที่ไม่คุ้ม
//    ในเฟสนี้ ความเป็นส่วนตัว (พิกัด GPS/รุ่นกล้อง/เวลาถ่ายไม่รั่ว) สำคัญกว่าการหมุน
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from './fileStore.js'

const AVATAR_DIR = 'avatars'

/** 2 MiB — รูปโปรไฟล์ที่ใหญ่กว่านี้ไม่ได้ช่วยอะไร นอกจากกินพื้นที่และ RAM ตอนถอด metadata */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

export async function initAvatarStorage() {
  await fsp.mkdir(path.join(STORAGE_ROOT, AVATAR_DIR), { recursive: true })
  return { dir: path.join(STORAGE_ROOT, AVATAR_DIR) }
}

/**
 * ชนิดไฟล์จากไบต์จริง — คืน null ถ้าไม่ใช่ PNG/JPEG (= ปฏิเสธ ไม่ใช่เดาต่อ)
 * ⚠️ ห้ามเปลี่ยนไปอ่านนามสกุลหรือ file.mimetype เด็ดขาด — ดูเหตุผลข้อ 1 ที่หัวไฟล์
 */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return { mime: 'image/png', ext: 'png' }
  // JPEG: SOI (FFD8) + marker แรกต้องเป็น FF — ท้ายไฟล์ควรเป็น EOI (FFD9) แต่ไฟล์จริง
  // จำนวนมากมี padding ต่อท้าย จึงไม่บังคับ (การ parse ด้านล่างจะจับไฟล์พังอยู่แล้ว)
  if (buf.subarray(0, 3).equals(JPEG_MAGIC)) return { mime: 'image/jpeg', ext: 'jpg' }
  return null
}

// ── PNG: คงไว้เฉพาะ chunk ที่จำเป็นต่อการถอดภาพ ────────────────────────────────
// โครงสร้าง: magic(8) + [ length(4) | type(4) | data | crc(4) ]…
// eXIf คือที่อยู่ของ EXIF ใน PNG; tEXt/zTXt/iTXt เก็บข้อความอิสระ (ชื่อซอฟต์แวร์,
// คอมเมนต์, บางครั้งเป็น XMP ที่มีพิกัด) — ทั้งหมดถูกทิ้ง
// allowlist ไม่ใช่ blocklist โดยเจตนา: chunk ชนิดใหม่ที่เราไม่รู้จักต้องถูกทิ้ง
// ไม่ใช่ผ่านไปเพราะยังไม่มีใครใส่ชื่อมันในรายการห้าม
const PNG_KEEP = new Set([
  'IHDR', // ขนาด/บิตเดปธ์ — ขาดไม่ได้
  'PLTE', // palette (จำเป็นสำหรับ color type 3)
  'IDAT', // ตัวภาพ
  'IEND', // จุดจบไฟล์
  'tRNS', // ความโปร่งใสของ palette — ทิ้งแล้วภาพเปลี่ยนหน้าตา
  'gAMA', 'sRGB', // ค่าสีพื้นฐาน ไม่มีข้อมูลส่วนตัว
])

function stripPngMetadata(buf) {
  const out = [buf.subarray(0, 8)]
  let off = 8
  let sawIhdr = false
  let sawIdat = false

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('latin1')
    const end = off + 12 + len // length + type + data + crc
    if (len > buf.length || end > buf.length) return null // ไฟล์พัง/ถูกตัด — ปฏิเสธ ไม่ซ่อม
    if (type === 'IHDR') sawIhdr = true
    if (type === 'IDAT') sawIdat = true
    if (PNG_KEEP.has(type)) out.push(buf.subarray(off, end))
    off = end
    if (type === 'IEND') break
  }

  if (!sawIhdr || !sawIdat) return null // ไม่ใช่ PNG ที่ถอดภาพได้จริง
  return Buffer.concat(out)
}

// ── JPEG: ทิ้ง APPn ทุกตัว และ COM ─────────────────────────────────────────────
// APP1 = EXIF (พิกัด GPS, รุ่นกล้อง, เวลาถ่าย, บางกล้องใส่ thumbnail ของภาพต้นฉบับ
// ไว้ในนี้ด้วย — thumbnail ที่ยังเป็นภาพ "ก่อนครอป" ของผู้ใช้), APP1 ยังเป็นที่อยู่ของ
// XMP; APP13 = IPTC (เครดิต/สถานที่); COM = คอมเมนต์อิสระ
// APP2 (ICC profile) ก็ถูกทิ้งด้วย: สีอาจเพี้ยนเล็กน้อยบนจอ wide-gamut แต่โปรไฟล์ ICC
// เป็นก้อนใหญ่และไม่จำเป็นสำหรับรูปโปรไฟล์ — ทิ้งทั้งกลุ่มง่ายกว่าเลือกเก็บบางตัว
// แล้วพลาดตัวที่ไม่รู้จัก
function stripJpegMetadata(buf) {
  const out = [Buffer.from([0xff, 0xd8])] // SOI
  let off = 2

  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null // ไม่ได้อยู่ที่ขอบ marker — ไฟล์พัง
    const marker = buf[off + 1]

    // SOS (FFDA): ตามด้วย entropy-coded data ที่ยาวจนจบไฟล์ — คัดลอกส่วนที่เหลือทั้งก้อน
    // (การเดินหา marker ต่อไปในโซนนี้ไม่ปลอดภัย: ไบต์ FF โผล่ในข้อมูลบีบอัดได้ปกติ)
    if (marker === 0xda) {
      out.push(buf.subarray(off))
      return Buffer.concat(out)
    }
    if (marker === 0xd9) { // EOI
      out.push(buf.subarray(off, off + 2))
      return Buffer.concat(out)
    }
    // marker ที่ไม่มี payload (RSTn / TEM)
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(off, off + 2))
      off += 2
      continue
    }

    const segLen = buf.readUInt16BE(off + 2)
    if (segLen < 2 || off + 2 + segLen > buf.length) return null
    const isAppn = marker >= 0xe0 && marker <= 0xef
    const isComment = marker === 0xfe
    if (!isAppn && !isComment) out.push(buf.subarray(off, off + 2 + segLen))
    off += 2 + segLen
  }

  return null // ไม่พบ SOS/EOI — ไม่ใช่ JPEG ที่ใช้งานได้
}

/**
 * ตรวจ + ถอด metadata → ไบต์ที่พร้อมเขียนลงดิสก์
 * @returns {{ bytes: Buffer, mime: string, ext: string } | null} null = ปฏิเสธ (ไม่ใช่ภาพที่รับ)
 */
export function sanitizeAvatar(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_AVATAR_BYTES) return null
  const kind = sniffImageType(buf)
  if (!kind) return null
  const bytes = kind.ext === 'png' ? stripPngMetadata(buf) : stripJpegMetadata(buf)
  if (!bytes || bytes.length === 0) return null
  return { bytes, mime: kind.mime, ext: kind.ext }
}

// ── multer: memoryStorage โดยเจตนา ────────────────────────────────────────────
// ต่างจาก /files/upload ที่ใช้ diskStorage (ไฟล์ 1GB ต้องไม่เข้า RAM) — ที่นี่เพดาน
// 2MiB และเราต้อง "อ่านทั้งไฟล์เพื่อถอด metadata ก่อนเขียน" อยู่แล้ว การเขียนไฟล์ดิบ
// ที่ยังมี EXIF ลงดิสก์ก่อนแล้วค่อยเขียนทับ = มีช่วงเวลาที่พิกัด GPS ของผู้ใช้นอนอยู่บนดิสก์
export const avatarUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 4 },
}).single('avatar')

/** เขียนไบต์ที่สะอาดแล้วลงดิสก์ → คืน storage key ('avatars/<uuid>.png') */
export async function writeAvatar({ bytes, ext }) {
  const key = `${AVATAR_DIR}/${randomUUID()}.${ext}`
  const abs = resolveAvatarKey(key)
  if (!abs) throw new Error('avatar key resolved outside STORAGE_ROOT')
  await fsp.writeFile(abs, bytes, { flag: 'wx' }) // wx = ห้ามทับไฟล์ที่มีอยู่ (UUID ชนกัน = ต้องรู้)
  return key
}

/** key → absolute path — ต้องอยู่ใต้ avatars/ เท่านั้น (ด่าน path traversal ชั้นที่สอง) */
export function resolveAvatarKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) return null
  const rel = key.replace(/^[/\\]+/, '')
  if (!rel.startsWith(`${AVATAR_DIR}/`)) return null
  const abs = path.resolve(STORAGE_ROOT, rel)
  const base = path.join(STORAGE_ROOT, AVATAR_DIR) + path.sep
  if (!abs.startsWith(base)) return null
  return abs
}

export function openAvatar(key) {
  const abs = resolveAvatarKey(key)
  if (!abs) return null
  return fs.createReadStream(abs)
}

export async function avatarSize(key) {
  const abs = resolveAvatarKey(key)
  if (!abs) return null
  try {
    return (await fsp.stat(abs)).size
  } catch {
    return null
  }
}

/** ลบไฟล์เดิม — เงียบถ้าไม่มี (แถวอาจถูกอัปเดตไปก่อนแล้ว) */
export async function removeAvatar(key) {
  const abs = resolveAvatarKey(key)
  if (!abs) return false
  try {
    await fsp.unlink(abs)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

export const avatarConfig = Object.freeze({ AVATAR_DIR, MAX_AVATAR_BYTES })
