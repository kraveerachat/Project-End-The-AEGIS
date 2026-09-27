// src/lib/vaultImageFormats.js — AEGIS Drive (IDEA1) · PR220-R2 · Vault image format capability registry
//
// The codec is decided from the decrypted CONTENT (magic bytes), never from a filename. An
// upper-case camera extension and a lower-case one with the same JPEG bytes therefore take
// the same path by construction: there is no name in this module to branch on.
//   • preview       — the Vault may try to render a thumbnail for this format at all
//   • reducedDecode — the format may use the reduced-resolution lane (worker ImageDecoder with a
//                     bounded desired size). Only JPEG: its decoder downscales during the DCT, and
//                     that was measured natively (PR220-R2). PNG/WebP/GIF stay on the proven
//                     normal lane; AVIF/HEIF are not claimed without runtime evidence; camera RAW
//                     needs a dedicated RAW decoder that this app does not ship.

export const IMAGE_FORMAT_CAPABILITIES = Object.freeze({
  JPEG: Object.freeze({ mime: 'image/jpeg', preview: true, reducedDecode: true }),
  PNG: Object.freeze({ mime: 'image/png', preview: true, reducedDecode: false }),
  WebP: Object.freeze({ mime: 'image/webp', preview: true, reducedDecode: false }),
  GIF: Object.freeze({ mime: 'image/gif', preview: true, reducedDecode: false }),
  AVIF: Object.freeze({ mime: 'image/avif', preview: false, reducedDecode: false }),
  HEIF: Object.freeze({ mime: 'image/heif', preview: false, reducedDecode: false }),
  RAW: Object.freeze({ mime: null, preview: false, reducedDecode: false }),
})

const ascii = (u8, at, len) => String.fromCharCode(...u8.subarray(at, at + len))

/**
 * @param {Uint8Array} bytes the first decrypted bytes of the file
 * @returns {{ format: keyof IMAGE_FORMAT_CAPABILITIES, mime: string|null } | null}
 */
export function sniffImageFormat(bytes) {
  if (!bytes || bytes.length < 12) return null
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const is = (format) => ({ format, mime: IMAGE_FORMAT_CAPABILITIES[format].mime })
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return is('JPEG')
  if (u8[0] === 0x89 && ascii(u8, 1, 3) === 'PNG') return is('PNG')
  if (ascii(u8, 0, 4) === 'GIF8') return is('GIF')
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return is('WebP')
  if (ascii(u8, 4, 4) === 'ftyp') {
    const brand = ascii(u8, 8, 4)
    if (brand === 'avif' || brand === 'avis') return is('AVIF')
    if (brand === 'crx ') return is('RAW')                              // Canon CR3
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return is('HEIF')
    return null
  }
  if (ascii(u8, 0, 15) === 'FUJIFILMCCD-RAW') return is('RAW')          // Fujifilm RAF
  // TIFF containers: CR2 / NEF / ARW / DNG / ORF ("IIRO") / RW2 ("IIU\0") — all camera RAW here,
  // because the Vault never treated plain TIFF as previewable either.
  const tiffLE = u8[0] === 0x49 && u8[1] === 0x49 && (u8[2] === 0x2a || u8[2] === 0x52 || u8[2] === 0x55)
  const tiffBE = u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0x00 && u8[3] === 0x2a
  if (tiffLE || tiffBE) return is('RAW')
  return null
}
