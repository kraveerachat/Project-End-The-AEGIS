// tests/previewFormats.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 · T-DETECT-1
//
// Format detection is the root of every preview decision: the extension is only a hint, the
// content signature decides, and the client MIME never promotes a file. These tests pin the
// signature table, the case-insensitive extension rule, and the resolution order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { craftedPng, actl, craftedWebp, craftedFtyp, craftedGifHeader } from './helpers/mediaFixtures.mjs'
import * as formats from '../src/lib/preview/formats.js'

const { FORMAT_IDS, normalizeExtension, sniffFormat } = formats
const probeHead = (...a) => formats.probeHead(...a)
const detectFormat = (...a) => formats.detectFormat(...a)
const familyOf = (...a) => formats.familyOf(...a)

const bytes = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)))))
const pad = (u8, n = 64) => { const out = new Uint8Array(Math.max(n, u8.length)); out.set(u8); return out }

test('PF-1 normalizeExtension is case-insensitive and takes the last segment', () => {
  assert.equal(normalizeExtension('IMG_0001.JPG'), 'jpg')
  assert.equal(normalizeExtension('a.Jpg'), 'jpg')
  assert.equal(normalizeExtension('a.jpg'), 'jpg')
  assert.equal(normalizeExtension('backup.TAR.GZ'), 'tar.gz')
  assert.equal(normalizeExtension('x.tar.gz'), 'tar.gz')
  assert.equal(normalizeExtension('README'), '')
  assert.equal(normalizeExtension('.bashrc'), 'bashrc')
  assert.equal(normalizeExtension('trailing.'), '')
  assert.equal(normalizeExtension(''), '')
  assert.equal(normalizeExtension(null), '')
  assert.equal(normalizeExtension('ภาพ.PNG'), 'png')
})

test('PF-2 sniffFormat recognises the signature table', () => {
  const cases = [
    [pad(bytes([0xff, 0xd8, 0xff, 0xe0])), 'jpeg'],
    [new Uint8Array(craftedPng()), 'png'],
    [new Uint8Array(craftedPng({ chunks: [actl(2)] })), 'apng'],
    [pad(new Uint8Array(craftedGifHeader())), 'gif'],
    [new Uint8Array(craftedWebp()), 'webp'],
    [new Uint8Array(craftedWebp({ animation: true, frames: 2 })), 'webp-animated'],
    [pad(new Uint8Array(craftedFtyp('isom', ['mp41']))), 'mp4'],
    [pad(new Uint8Array(craftedFtyp('qt  '))), 'mov'],
    [pad(new Uint8Array(craftedFtyp('M4A ', ['isom']))), 'm4a'],
    [pad(new Uint8Array(craftedFtyp('avif'))), 'avif'],
    [pad(new Uint8Array(craftedFtyp('heic'))), 'heif'],
    [pad(new Uint8Array(craftedFtyp('crx '))), 'raw'],
    [pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84], 'webm')), 'webm'],
    [pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88], 'matroska')), 'mkv'],
    [pad(bytes('OggS', new Array(24).fill(0), [0x01], 'vorbis')), 'ogg-audio'],
    [pad(bytes('OggS', new Array(24).fill(0), 'OpusHead')), 'opus'],
    [pad(bytes('OggS', new Array(24).fill(0), [0x80], 'theora')), 'ogg-video'],
    [pad(bytes('ID3', [0x04, 0, 0, 0, 0, 0, 0])), 'mp3'],
    [pad(bytes([0xff, 0xfb, 0x90, 0x64])), 'mp3'],
    [pad(bytes([0xff, 0xf1, 0x50, 0x80])), 'aac'],
    [pad(bytes('fLaC', [0, 0, 0, 0x22])), 'flac'],
    [pad(bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ')), 'wav'],
    [pad(bytes('%PDF-1.7\n')), 'pdf'],
    [pad(bytes('PK', [0x03, 0x04, 0x14, 0])), 'zip'],
    [pad(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'cfb-legacy'],
    [pad(bytes('BM', [0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 0x28, 0, 0, 0])), 'bmp'],
    [pad(bytes('II', [0x2a, 0x00, 0x08, 0, 0, 0])), 'raw'],
  ]
  for (const [head, expected] of cases) assert.equal(sniffFormat(head), expected, `expected ${expected}`)
  for (const [, expected] of cases) assert.ok(FORMAT_IDS.includes(expected), `${expected} is a known FormatId`)
})

test('PF-3 sniffFormat returns null for unknown, short, or text content', () => {
  const random = new Uint8Array(64); for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) & 0xff
  random[0] = 0x13
  assert.equal(sniffFormat(random), null)
  assert.equal(sniffFormat(new Uint8Array([0xff, 0xd8])), null)
  assert.equal(sniffFormat(null), null)
  assert.equal(sniffFormat(bytes('hello world, plain text\n')), null)
  assert.equal(sniffFormat(pad(bytes('BM', new Array(20).fill(0x41)))), null, 'a text file starting with "BM" is not a bitmap')
})

test('PF-4 detectFormat: signature wins over a misleading extension; hint never changes the result', () => {
  const pdf = pad(bytes('%PDF-1.4\n'))
  assert.deepEqual(pick(detectFormat({ head: pdf, name: 'photo.jpg', hintMime: 'image/jpeg' })), { format: 'pdf', family: 'pdf', basis: 'signature', ext: 'jpg' })
  assert.deepEqual(pick(detectFormat({ head: pdf, name: 'scan.bin', hintMime: 'image/png' })), { format: 'pdf', family: 'pdf', basis: 'signature', ext: 'bin' })
  const jpeg = pad(bytes([0xff, 0xd8, 0xff, 0xe1]))
  assert.equal(detectFormat({ head: jpeg, name: 'IMG.JPG', hintMime: '' }).format, 'jpeg')
  assert.equal(detectFormat({ head: jpeg, name: 'noext', hintMime: '' }).format, 'jpeg')
})

test('PF-5 detectFormat: extension-only and text-family rules', () => {
  assert.deepEqual(pick(detectFormat({ name: 'notes.md' })), { format: 'markdown', family: 'text', basis: 'extension', ext: 'md' })
  assert.deepEqual(pick(detectFormat({ name: 'Holiday.JPG' })), { format: 'jpeg', family: 'image', basis: 'extension', ext: 'jpg' })
  assert.equal(detectFormat({ head: bytes('plain utf-8 text ✓\n'), name: 'a.txt' }).format, 'text')
  assert.equal(detectFormat({ head: bytes('plain utf-8 text ✓\n'), name: 'a.txt' }).basis, 'signature')
  assert.equal(detectFormat({ head: bytes('abc', [0], 'def'), name: 'bin.txt' }).format, 'unknown')
  assert.equal(detectFormat({ head: bytes([0xff, 0xfe], 'h\0i\0'), name: 'wide.txt' }).format, 'text', 'UTF-16 BOM is text')
  assert.equal(detectFormat({ name: 'page.html' }).format, 'html')
  assert.equal(detectFormat({ name: 'icon.svg' }).family, 'text', 'SVG is source text, never an image')
  assert.equal(detectFormat({ head: bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'icon.svg' }).family, 'text')
  assert.deepEqual(pick(detectFormat({ name: 'photo', hintMime: 'image/jpeg' })), { format: 'unknown', family: 'none', basis: 'none', ext: '' }, 'the hint never promotes')
  assert.equal(detectFormat({ name: 'archive.tar.gz' }).format, 'unknown')
})

test('PF-6 detectFormat: ZIP and CFB containers resolve by extension only within the verified container', () => {
  const zip = pad(bytes('PK', [0x03, 0x04]))
  assert.equal(detectFormat({ head: zip, name: 'report.DOCX' }).format, 'ooxml-docx')
  assert.equal(detectFormat({ head: zip, name: 'sheet.xlsx' }).format, 'ooxml-xlsx')
  assert.equal(detectFormat({ head: zip, name: 'deck.pptx' }).format, 'ooxml-pptx')
  assert.equal(detectFormat({ head: zip, name: 'data.ods' }).format, 'odf-ods')
  assert.equal(detectFormat({ head: zip, name: 'bundle.zip' }).format, 'zip')
  assert.equal(detectFormat({ head: zip, name: 'photo.jpg' }).format, 'zip', 'an extension cannot turn a ZIP into an image')
  const cfb = pad(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  assert.equal(detectFormat({ head: cfb, name: 'old.doc' }).format, 'cfb-legacy')
})

test('PF-7 probeHead keeps only derived facts (no plaintext) and feeds detectFormat identically', () => {
  const head = pad(bytes([0xff, 0xd8, 0xff, 0xdb]))
  const probe = probeHead(head)
  assert.deepEqual(Object.keys(probe).sort(), ['sniff', 'textLike'])
  assert.equal(probe.sniff, 'jpeg')
  assert.deepEqual(detectFormat({ probe, name: 'a.JPG' }), detectFormat({ head, name: 'a.JPG' }))
  const text = probeHead(bytes('hello'))
  assert.deepEqual(text, { sniff: null, textLike: true })
  assert.equal(detectFormat({ probe: text, name: 'x.json' }).format, 'json')
})

test('PF-8 familyOf maps every FormatId to a closed family', () => {
  const families = new Set(['image', 'animated-image', 'video', 'audio', 'pdf', 'text', 'office-document', 'office-spreadsheet', 'office-presentation', 'none'])
  for (const id of FORMAT_IDS) assert.ok(families.has(familyOf(id)), `${id} → ${familyOf(id)}`)
  assert.equal(familyOf('gif'), 'animated-image')
  assert.equal(familyOf('mp3'), 'audio')
  assert.equal(familyOf('cfb-legacy'), 'none')
  assert.equal(familyOf('nonsense'), 'none')
})

function pick({ format, family, basis, ext }) { return { format, family, basis, ext } }
