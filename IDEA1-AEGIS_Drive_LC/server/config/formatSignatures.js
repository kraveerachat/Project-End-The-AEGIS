// server/config/formatSignatures.js — AEGIS Drive (IDEA1) · Unified Preview P1 · server signature table
//
// ⚠️ A byte-for-byte behavioural copy of `sniffFormat` + the text rule in src/lib/preview/formats.js.
//    The Drive runtime image ships only `server/` + `dist/`, so the server cannot import `src/`.
//    tests/formatSignatureParity.test.js feeds one corpus to both copies and requires identical answers —
//    change BOTH files together or that test fails.
// ⚠️ Pure functions over a Buffer/Uint8Array head: no I/O, no account input.

/** bytes the /preview route reads from the head of a file before deciding */
export const SIGNATURE_HEAD_BYTES = 8192
const HEAD_BYTES = 4096 // client constant: ANIM / OpusHead / theora scan window

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
 * FormatId from the leading bytes only — must equal the client `sniffFormat` for every input.
 * @param {Buffer|Uint8Array|null|undefined} head
 * @returns {string|null}
 */
export function sniffFormatServer(head) {
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
  if ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff)) return null // UTF-16 BOM = text
  if (u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0) return 'aac'
  if (isMpegAudioFrame(u8)) return 'mp3'
  if (ascii(u8, 0, 5) === '%PDF-') return 'pdf'
  if (u8[0] === 0x50 && u8[1] === 0x4b && ((u8[2] === 0x03 && u8[3] === 0x04) || (u8[2] === 0x05 && u8[3] === 0x06))) return 'zip'
  if (u8.length >= 8 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0 && u8[4] === 0xa1 && u8[5] === 0xb1 && u8[6] === 0x1a && u8[7] === 0xe1) return 'cfb-legacy'
  if (ascii(u8, 0, 15) === 'FUJIFILMCCD-RAW') return 'raw'
  const tiffLE = u8[0] === 0x49 && u8[1] === 0x49 && (u8[2] === 0x2a || u8[2] === 0x52 || u8[2] === 0x55)
  const tiffBE = u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0x00 && u8[3] === 0x2a
  if (tiffLE || tiffBE) return 'raw'
  if (isBmp(u8)) return 'bmp'
  return null
}

/** C0 controls that occur in real text: TAB, LF, FF, CR, ESC */
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b])

/**
 * UTF-16 BOM, or valid UTF-8 with no NUL / other C0 control in the first 8 KiB (client `textLike`).
 * @param {Buffer|Uint8Array} head
 */
export function isTextLikeHead(head) {
  const u8 = head instanceof Uint8Array ? head : new Uint8Array(head ?? [])
  if (u8.length >= 2 && ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff))) return true
  const window = u8.subarray(0, Math.min(u8.length, 8192))
  for (let i = 0; i < window.length; i++) if (window[i] < 0x20 && !TEXT_CONTROLS.has(window[i])) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(window, { stream: true }) // tolerate a cut multi-byte tail
    return true
  } catch {
    return false
  }
}

/**
 * Do the head bytes belong to the inline entry's family? (P1 audio/text entries)
 *  - audio: the sniffed FormatId is one the entry accepts
 *  - text: no binary signature AND text-like head
 *  - anything else: false (the route only asks this for P1 entries; image/video keep their prior path)
 * @param {{ family: string, accepts?: readonly string[] } | null} entry
 * @param {string|null} sniffed
 * @param {Buffer|Uint8Array} head
 */
export function familyMatches(entry, sniffed, head) {
  if (!entry) return false
  if (entry.family === 'audio') return Array.isArray(entry.accepts) && sniffed !== null && entry.accepts.includes(sniffed)
  if (entry.family === 'text') return sniffed === null && isTextLikeHead(head)
  return false
}
