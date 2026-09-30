// src/lib/preview/formats.js — AEGIS Drive (IDEA1) · Unified Preview P0 · format detection
//
// ⚠️ This module decides WHAT a file is, never WHETHER it may be rendered (that is registry.js).
//    Pure functions only: no I/O, no DOM, no storage, no account input — the same bytes and name
//    always give the same answer for every user.
// ⚠️ Trust order (spec §5): content signature → normalised extension. The client-provided MIME
//    (`hintMime`) is accepted for API symmetry and deliberately ignored: a hint can never promote
//    a file into an inline-capable format.

/** Closed set of canonical format ids (spec §5.2). */
export const FORMAT_IDS = Object.freeze([
  'jpeg', 'png', 'apng', 'gif', 'webp', 'webp-animated', 'bmp', 'avif', 'heif', 'raw',
  'mp4', 'mov', 'webm', 'mkv', 'ogg-video',
  'mp3', 'aac', 'm4a', 'ogg-audio', 'opus', 'wav', 'flac',
  'pdf', 'zip', 'ooxml-docx', 'ooxml-xlsx', 'ooxml-pptx', 'odf-ods', 'cfb-legacy',
  'text', 'markdown', 'json', 'csv', 'tsv', 'svg', 'html', 'xml', 'source',
  'unknown',
])

/** At most this many leading bytes are ever inspected. */
export const HEAD_BYTES = 4096

/**
 * Last extension of a name, lower-cased after NFC; `tar.gz` is kept whole; '' when there is none.
 * `.bashrc` → 'bashrc' (matches the server's `name.split('.').pop()` rule).
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeExtension(name) {
  const text = String(name ?? '').normalize('NFC').toLowerCase()
  if (text.endsWith('.tar.gz')) return 'tar.gz'
  const at = text.lastIndexOf('.')
  if (at < 0) return ''
  return text.slice(at + 1)
}

const ascii = (u8, at, len) => (u8.length >= at + len ? String.fromCharCode(...u8.subarray(at, at + len)) : '')
const includesAscii = (u8, needle, limit = u8.length) => {
  const end = Math.min(u8.length, limit) - needle.length
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (u8[i + j] !== needle.charCodeAt(j)) continue outer
    return true
  }
  return false
}
const u32be = (u8, at) => ((u8[at] << 24) >>> 0) + (u8[at + 1] << 16) + (u8[at + 2] << 8) + u8[at + 3]
const u32le = (u8, at) => u8[at] + (u8[at + 1] << 8) + (u8[at + 2] << 16) + ((u8[at + 3] << 24) >>> 0)

function pngKind(u8) {
  // walk chunks after the 8-byte signature; an acTL before IDAT marks APNG
  let at = 8
  while (at + 8 <= u8.length) {
    const len = u32be(u8, at)
    const type = ascii(u8, at + 4, 4)
    if (type === 'acTL') return 'apng'
    if (type === 'IDAT' || type === 'IEND') return 'png'
    at += 12 + len
  }
  return 'png'
}

function webpKind(u8) {
  if (ascii(u8, 12, 4) === 'VP8X' && u8.length > 20 && (u8[20] & 0x02)) return 'webp-animated'
  if (includesAscii(u8, 'ANIM', HEAD_BYTES)) return 'webp-animated'
  return 'webp'
}

function isoBmffKind(u8) {
  const brand = ascii(u8, 8, 4)
  if (brand === 'avif' || brand === 'avis') return 'avif'
  if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heif'
  if (brand === 'crx ') return 'raw'
  if (brand === 'qt  ') return 'mov'
  if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return 'm4a'
  return 'mp4'
}

function oggKind(u8) {
  if (includesAscii(u8, 'OpusHead', HEAD_BYTES)) return 'opus'
  if (includesAscii(u8, 'theora', HEAD_BYTES)) return 'ogg-video'
  return 'ogg-audio'
}

/** MPEG audio frame header: 11-bit sync, version ≠ reserved, layer ≠ reserved, bitrate ≠ bad, sample rate ≠ reserved */
function isMpegAudioFrame(u8) {
  if (u8.length < 3 || u8[0] !== 0xff || (u8[1] & 0xe0) !== 0xe0) return false
  const version = (u8[1] >> 3) & 0x03
  const layer = (u8[1] >> 1) & 0x03
  const bitrate = (u8[2] >> 4) & 0x0f
  const sampleRate = (u8[2] >> 2) & 0x03
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03
}

function isBmp(u8) {
  if (!(u8[0] === 0x42 && u8[1] === 0x4d) || u8.length < 18) return false
  const dib = u32le(u8, 14)
  return dib === 12 || dib === 40 || dib === 52 || dib === 56 || dib === 64 || dib === 108 || dib === 124
}

/**
 * Canonical format from the leading bytes only (signature table, spec §5.3 step 2).
 * @param {Uint8Array|ArrayBuffer|null|undefined} head
 * @returns {string|null} a FormatId, or null when no signature matches
 */
export function sniffFormat(head) {
  if (!head) return null
  const u8 = head instanceof Uint8Array ? head : new Uint8Array(head)
  if (u8.length < 4) return null
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg'
  if (u8[0] === 0x89 && ascii(u8, 1, 3) === 'PNG' && u8[4] === 0x0d && u8[5] === 0x0a) return pngKind(u8)
  if (ascii(u8, 0, 4) === 'GIF8') return 'gif'
  if (ascii(u8, 0, 4) === 'RIFF') {
    const form = ascii(u8, 8, 4)
    if (form === 'WEBP') return webpKind(u8)
    if (form === 'WAVE') return 'wav'
    return null
  }
  if (ascii(u8, 4, 4) === 'ftyp') return isoBmffKind(u8)
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return includesAscii(u8, 'webm', 64) ? 'webm' : 'mkv'
  if (ascii(u8, 0, 4) === 'OggS') return oggKind(u8)
  if (ascii(u8, 0, 4) === 'fLaC') return 'flac'
  if (ascii(u8, 0, 3) === 'ID3') return 'mp3'
  // a UTF-16 byte-order mark also satisfies the MPEG frame-sync bit pattern; it is text, never audio
  if ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff)) return null
  if (u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0) return 'aac' // ADTS: sync + layer 00
  if (isMpegAudioFrame(u8)) return 'mp3'
  if (ascii(u8, 0, 5) === '%PDF-') return 'pdf'
  if (u8[0] === 0x50 && u8[1] === 0x4b && ((u8[2] === 0x03 && u8[3] === 0x04) || (u8[2] === 0x05 && u8[3] === 0x06))) return 'zip'
  if (u8.length >= 8 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0 && u8[4] === 0xa1 && u8[5] === 0xb1 && u8[6] === 0x1a && u8[7] === 0xe1) return 'cfb-legacy'
  if (ascii(u8, 0, 15) === 'FUJIFILMCCD-RAW') return 'raw'
  const tiffLE = u8[0] === 0x49 && u8[1] === 0x49 && (u8[2] === 0x2a || u8[2] === 0x52 || u8[2] === 0x55)
  const tiffBE = u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0x00 && u8[3] === 0x2a
  if (tiffLE || tiffBE) return 'raw' // the app never treated plain TIFF as previewable either
  if (isBmp(u8)) return 'bmp'
  return null
}

/* ── resolution (spec §5.3) ──────────────────────────────────────────────── */

const EXT_FORMAT = Object.freeze({
  jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', png: 'png', apng: 'apng', gif: 'gif', webp: 'webp',
  bmp: 'bmp', avif: 'avif', heic: 'heif', heif: 'heif',
  cr2: 'raw', cr3: 'raw', nef: 'raw', arw: 'raw', dng: 'raw', raf: 'raw', orf: 'raw', rw2: 'raw',
  mp4: 'mp4', m4v: 'mp4', mov: 'mov', webm: 'webm', mkv: 'mkv', ogv: 'ogg-video',
  mp3: 'mp3', aac: 'aac', m4a: 'm4a', ogg: 'ogg-audio', oga: 'ogg-audio', opus: 'opus', wav: 'wav', flac: 'flac',
  pdf: 'pdf', zip: 'zip', docx: 'ooxml-docx', xlsx: 'ooxml-xlsx', pptx: 'ooxml-pptx', ods: 'odf-ods',
  doc: 'cfb-legacy', xls: 'cfb-legacy', ppt: 'cfb-legacy',
  txt: 'text', log: 'text', md: 'markdown', markdown: 'markdown', json: 'json', csv: 'csv', tsv: 'tsv',
  svg: 'svg', html: 'html', htm: 'html', xml: 'xml',
})
const SOURCE_EXTS = new Set(['css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go',
  'rs', 'rb', 'php', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sql', 'kt', 'swift'])
const ZIP_BY_EXT = Object.freeze({ docx: 'ooxml-docx', xlsx: 'ooxml-xlsx', pptx: 'ooxml-pptx', ods: 'odf-ods' })

const FAMILY = Object.freeze({
  jpeg: 'image', png: 'image', webp: 'image', bmp: 'image', avif: 'image', heif: 'image', raw: 'image',
  gif: 'animated-image', apng: 'animated-image', 'webp-animated': 'animated-image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', 'ogg-video': 'video',
  mp3: 'audio', aac: 'audio', m4a: 'audio', 'ogg-audio': 'audio', opus: 'audio', wav: 'audio', flac: 'audio',
  pdf: 'pdf',
  'ooxml-docx': 'office-document', 'ooxml-xlsx': 'office-spreadsheet', 'odf-ods': 'office-spreadsheet', 'ooxml-pptx': 'office-presentation',
  text: 'text', markdown: 'text', json: 'text', csv: 'text', tsv: 'text', svg: 'text', html: 'text', xml: 'text', source: 'text',
})

/** @param {string} format @returns {string} closed family ('none' for containers/unknown) */
export function familyOf(format) {
  return Object.hasOwn(FAMILY, format) ? FAMILY[format] : 'none'
}

function formatForExtension(ext) {
  if (Object.hasOwn(EXT_FORMAT, ext)) return EXT_FORMAT[ext]
  if (SOURCE_EXTS.has(ext)) return 'source'
  return null
}
const isTextFormat = (format) => familyOf(format) === 'text'

/** UTF-16 BOM, or valid UTF-8 without NUL in the inspected window */
function textLike(u8) {
  if (u8.length >= 2 && ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff))) return true
  const window = u8.subarray(0, Math.min(u8.length, 8192))
  for (let i = 0; i < window.length; i++) if (window[i] === 0) return false
  try {
    // a multi-byte sequence may be cut at the window edge: tolerate an incomplete tail
    new TextDecoder('utf-8', { fatal: true }).decode(window, { stream: true })
    return true
  } catch {
    return false
  }
}

/**
 * Derived facts about the leading bytes — safe to keep in page memory (no plaintext retained).
 * @param {Uint8Array|ArrayBuffer} head
 * @returns {{ sniff: string|null, textLike: boolean }}
 */
export function probeHead(head) {
  const u8 = head instanceof Uint8Array ? head.subarray(0, HEAD_BYTES * 2) : new Uint8Array(head).subarray(0, HEAD_BYTES * 2)
  const sniff = sniffFormat(u8)
  return { sniff, textLike: sniff === null && textLike(u8) }
}

/**
 * Resolve the canonical format of a file.
 * - content present (head or probe): the signature decides; ZIP/CFB are refined by extension only
 *   inside their verified container; no signature → text-family by extension only if the content is text.
 * - no content: extension only (`basis: 'extension'`) — renderers must confirm the signature first.
 * - `hintMime` is never used to choose a format.
 * @param {{ head?: Uint8Array|null, probe?: { sniff: string|null, textLike: boolean }|null, name?: string, hintMime?: string }} input
 * @returns {{ format: string, family: string, basis: 'signature'|'extension'|'none', ext: string }}
 */
export function detectFormat({ head = null, probe = null, name = '' } = {}) {
  const ext = normalizeExtension(name)
  const facts = probe ?? (head ? probeHead(head) : null)
  if (facts) {
    if (facts.sniff) {
      let format = facts.sniff
      if (format === 'zip' && Object.hasOwn(ZIP_BY_EXT, ext)) format = ZIP_BY_EXT[ext]
      return { format, family: familyOf(format), basis: 'signature', ext }
    }
    const byExt = formatForExtension(ext)
    if (facts.textLike && byExt && isTextFormat(byExt)) return { format: byExt, family: 'text', basis: 'signature', ext }
    return { format: 'unknown', family: 'none', basis: 'none', ext }
  }
  const byExt = formatForExtension(ext)
  if (byExt) return { format: byExt, family: familyOf(byExt), basis: 'extension', ext }
  return { format: 'unknown', family: 'none', basis: 'none', ext }
}
