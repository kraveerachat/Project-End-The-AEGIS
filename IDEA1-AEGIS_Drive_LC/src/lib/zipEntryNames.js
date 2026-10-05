// src/lib/zipEntryNames.js — AEGIS Drive (IDEA1) · ชื่อรายการใน ZIP ของการดาวน์โหลดหลายไฟล์ (spec §5)
//
// ⚠️ ชื่อในไฟล์ ZIP คือ path ที่โปรแกรมแตกไฟล์จะสร้างบนดิสก์ของผู้ใช้ — ชื่อที่มี '/' หรือ '..'
//    คือช่องโหว่ zip-slip ตรรกะนี้จึงลบตัวคั่น path ทิ้งทั้งหมด (ทุกชื่อเป็นไฟล์แบนในรากของ archive)
//    และตัดชื่อที่ Windows ตีความเป็นอุปกรณ์ (CON, NUL, COM1 …) ซึ่งแตกออกมาไม่ได้หรืออันตราย

const MAX_NAME_BYTES = 255
const MAX_EXT_BYTES = 32

// spec §5 step 2: ตัวคั่น path, อักขระที่ Windows ห้าม, และอักขระควบคุม C0/C1
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001F\u007F-\u009F]/g
const RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i

const encoder = new TextEncoder()
const utf8Bytes = (s) => encoder.encode(s).length

/** ตัดให้ไม่เกิน maxBytes ไบต์ UTF-8 โดยไม่ผ่ากลาง code point */
function truncateUtf8(s, maxBytes) {
  let out = ''
  let used = 0
  for (const cp of s) {
    const n = utf8Bytes(cp)
    if (used + n > maxBytes) break
    out += cp
    used += n
  }
  return out
}

/** แยกนามสกุลสุดท้าย — ไฟล์ที่ขึ้นต้นด้วยจุด (.env) ถือว่าไม่มีนามสกุล */
function splitExt(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/** ตัดให้ ≤ 255 ไบต์ โดยคงนามสกุล (≤ 32 ไบต์) ไว้ถ้าทำได้ */
function fitName(stem, ext) {
  if (utf8Bytes(stem + ext) <= MAX_NAME_BYTES) return stem + ext
  if (ext && utf8Bytes(ext) <= MAX_EXT_BYTES) return truncateUtf8(stem, MAX_NAME_BYTES - utf8Bytes(ext)) + ext
  return truncateUtf8(stem + ext, MAX_NAME_BYTES)
}

/**
 * ⚠️ ทำ "หลัง" ตัดตามงบไบต์เสมอ: การตัดอาจเผยจุด/ช่องว่างท้ายชื่อขึ้นมาใหม่ และ Windows ตัดสองตัวนี้ทิ้งตอนแตกไฟล์
 *    — ชื่อสองชื่อที่ต่างกันก่อนตัดจะกลายเป็นชื่อเดียวกันบนดิสก์ (ทับกันเงียบ ๆ) ถ้าไม่ทำให้เป็นรูปสุดท้ายก่อนกันชื่อซ้ำ
 */
function windowsCanonical(name) {
  const out = name.replace(/[. ]+$/, '')
  return out === '' ? 'file' : out
}

/** spec §5 steps 1–7 ตามลำดับ แล้วจึงทำให้เป็นชื่อที่ Windows เห็นจริง */
export function sanitizeZipEntryName(input) {
  let name = String(input).normalize('NFC')
  name = name.replace(FORBIDDEN, '_')
  name = name.trim()
  // step 4: '.' และ '..' ทั้งชื่อ — ตรวจก่อนตัดจุดท้าย ไม่งั้น '..' จะกลายเป็นชื่อว่าง
  if (name === '.' || name === '..') name = '_'
  // step 3 (Windows): ตัดจุดและช่องว่างท้ายชื่อจนกว่าจะไม่มีเหลือ
  name = name.replace(/[.\s]+$/u, '')
  const base = name.split('.')[0]
  if (RESERVED.test(base)) name = `_${name}`
  if (name === '') name = 'file'
  const { stem, ext } = splitExt(name)
  return windowsCanonical(fitName(stem, ext))
}

/**
 * ชื่อสุดท้ายของทุกรายการตามลำดับในแผน — ชื่อซ้ำ (ไม่สนตัวพิมพ์) ได้ "stem (k).ext"
 * ⚠️ ทุกชื่อที่สร้างถูกตรวจซ้ำกับชื่อที่ใช้ไปแล้วทั้งหมด รวมชื่อเดิมที่หน้าตาเหมือน "x (2).txt"
 */
export function assignZipEntryNames(names) {
  const taken = new Set()
  const out = []
  for (const raw of names) {
    const name = sanitizeZipEntryName(raw)
    let candidate = name
    if (taken.has(candidate.toLowerCase())) {
      const { stem, ext } = splitExt(name)
      for (let k = 2; ; k += 1) {
        const suffix = ` (${k})`
        const keepExt = ext && utf8Bytes(ext) <= MAX_EXT_BYTES ? ext : ''
        const head = keepExt ? stem : stem + ext
        candidate = windowsCanonical(truncateUtf8(head, MAX_NAME_BYTES - utf8Bytes(suffix + keepExt)) + suffix + keepExt)
        if (!taken.has(candidate.toLowerCase())) break
      }
    }
    taken.add(candidate.toLowerCase())
    out.push(candidate)
  }
  return out
}
