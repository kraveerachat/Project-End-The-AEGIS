// tests/formatSignatureParity.test.js — AEGIS Drive (IDEA1) · Unified Preview P1 · Task 2
//
// The Drive runtime image ships only `server/` + `dist/`, so the server cannot import the client
// signature table (src/lib/preview/formats.js). It keeps its own copy; this test is the contract that
// the two copies give the SAME answer for every byte pattern, and pins the text/audio acceptance rules
// the /preview route uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { craftedPng, actl, craftedWebp, craftedFtyp, craftedGifHeader } from './helpers/mediaFixtures.mjs'
import { sniffFormat, probeHead } from '../src/lib/preview/formats.js'
import { sniffFormatServer, familyMatches, isTextLikeHead, SIGNATURE_HEAD_BYTES } from '../server/config/formatSignatures.js'
import { FORMAT_TABLE } from '../server/config/previewMedia.js'

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))))
const pad = (b, n = 64) => { const out = Buffer.alloc(Math.max(n, b.length)); b.copy(out); return out }
const rnd = (seed, n) => { let x = seed >>> 0 || 1; const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff } return b }

const CORPUS = [
  pad(bytes([0xff, 0xd8, 0xff, 0xe0])), Buffer.from(craftedPng()), Buffer.from(craftedPng({ chunks: [actl(2)] })),
  pad(Buffer.from(craftedGifHeader())), Buffer.from(craftedWebp()), Buffer.from(craftedWebp({ animation: true, frames: 2 })),
  pad(Buffer.from(craftedFtyp('isom', ['mp41']))), pad(Buffer.from(craftedFtyp('qt  '))), pad(Buffer.from(craftedFtyp('M4A ', ['isom']))),
  pad(Buffer.from(craftedFtyp('mp42', ['M4A ']))), pad(Buffer.from(craftedFtyp('avif'))), pad(Buffer.from(craftedFtyp('heic'))), pad(Buffer.from(craftedFtyp('crx '))),
  pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84], 'webm')), pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88], 'matroska')),
  pad(bytes('OggS', new Array(24).fill(0), [0x01], 'vorbis')), pad(bytes('OggS', new Array(24).fill(0), 'OpusHead')), pad(bytes('OggS', new Array(24).fill(0), [0x80], 'theora')),
  pad(bytes('ID3', [0x04, 0, 0, 0, 0, 0, 0])), pad(bytes([0xff, 0xfb, 0x90, 0x64])), pad(bytes([0xff, 0xf1, 0x50, 0x80])),
  pad(bytes([0xff, 0xff, 0x90, 0x64])), pad(bytes([0xff, 0xfb, 0xf0, 0x64])), pad(bytes([0xff, 0xfe, 0x41, 0x00])), pad(bytes([0xfe, 0xff, 0x00, 0x41])),
  pad(bytes('fLaC', [0, 0, 0, 0x22])), pad(bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ')), pad(bytes('RIFF', [0x24, 0, 0, 0], 'AVI LIST')),
  pad(bytes('%PDF-1.7\n')), pad(bytes('PK', [0x03, 0x04, 0x14, 0])), pad(bytes('PK', [0x05, 0x06, 0, 0])),
  pad(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), pad(bytes('FUJIFILMCCD-RAW 0201')),
  pad(bytes('BM', [0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 0x28, 0, 0, 0])), pad(bytes('BM', new Array(20).fill(0x41))),
  pad(bytes('II', [0x2a, 0x00, 0x08, 0, 0, 0])), pad(bytes('MM', [0x00, 0x2a, 0, 0, 0, 8])),
  bytes('hello world, plain text\n'), bytes('<svg onload="alert(1)"></svg>'), bytes('<!doctype html><script>alert(1)</script>'),
  bytes('{"a":1}'), bytes([0xff, 0xd8]), Buffer.alloc(0),
  ...Array.from({ length: 200 }, (_, i) => rnd(1000 + i, 64)),
]

test('SIG-PARITY-1 server sniffFormatServer equals client sniffFormat on the whole corpus', () => {
  for (const [i, head] of CORPUS.entries()) {
    assert.equal(sniffFormatServer(head), sniffFormat(new Uint8Array(head)), `corpus #${i} (${head.subarray(0, 8).toString('hex')})`)
  }
  assert.equal(sniffFormatServer(null), null)
  assert.equal(SIGNATURE_HEAD_BYTES, 8192)
})

test('SIG-PARITY-2 server text-likeness equals the client probeHead rule', () => {
  const texts = [
    bytes('plain\n'), bytes('tab\tand\r\nCRLF and \x1b[31mANSI\x1b[0m and form\x0cfeed'), bytes('ไทย 中文 😀'),
    bytes([0xef, 0xbb, 0xbf], 'bom'), bytes([0xff, 0xfe, 0x41, 0x00]), bytes([0xfe, 0xff, 0x00, 0x41]),
    bytes('nul\x00inside'), bytes('bell\x07'), bytes([0xc3, 0x28]), bytes('cut ', [0xe0, 0xb8]),
    Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0x00])]), // NUL after the window
  ]
  // none of these carry a binary signature, so the client's probeHead().textLike is exactly its text rule
  for (const b of texts) {
    assert.equal(sniffFormat(new Uint8Array(b)), null)
    assert.equal(isTextLikeHead(b), probeHead(new Uint8Array(b)).textLike, b.subarray(0, 12).toString('hex'))
  }
})

test('SIG-FAMILY-1 familyMatches: audio by accepted signature; text = no signature AND text-like', () => {
  const id3 = pad(bytes('ID3', [4, 0, 0, 0, 0, 0, 0]))
  const png = Buffer.from(craftedPng())
  const m = (ext, head) => familyMatches(FORMAT_TABLE[ext], sniffFormatServer(head), head)
  assert.equal(m('mp3', id3), true)
  assert.equal(m('mp3', png), false, 'PNG named .mp3')
  assert.equal(m('mp3', bytes('just text')), false)
  assert.equal(m('m4a', pad(Buffer.from(craftedFtyp('M4A ')))), true)
  assert.equal(m('m4a', pad(Buffer.from(craftedFtyp('mp42')))), true, 'M4A with a generic MP4 brand')
  assert.equal(m('wav', pad(bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt '))), true)
  assert.equal(m('flac', pad(bytes('fLaC', [0, 0, 0, 0x22]))), true)
  assert.equal(m('ogg', pad(bytes('OggS', new Array(24).fill(0), [0x01], 'vorbis'))), true)
  assert.equal(m('ogg', pad(bytes('OggS', new Array(24).fill(0), [0x80], 'theora'))), false, 'Ogg video is not audio')
  assert.equal(m('weba', pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84], 'webm'))), true)
  assert.equal(m('txt', bytes('notes\n')), true)
  assert.equal(m('md', bytes('# title\n')), true)
  assert.equal(m('txt', bytes([0xff, 0xfe, 0x41, 0x00])), true, 'UTF-16 LE BOM')
  assert.equal(m('txt', bytes([0xfe, 0xff, 0x00, 0x41])), true, 'UTF-16 BE BOM')
  assert.equal(m('txt', bytes('bin\x00ary')), false, 'NUL in the first 8 KiB')
  assert.equal(m('txt', png), false, 'PNG named .txt')
  assert.equal(m('txt', id3), false, 'MP3 named .txt')
  assert.equal(m('html', bytes('<script>alert(1)</script>')), true, 'HTML is text (served as text/plain)')
  assert.equal(m('svg', bytes('<svg onload="x()"/>')), true)
  assert.equal(m('json', bytes([0xc3, 0x28])), false, 'invalid UTF-8')
  assert.equal(m('txt', Buffer.alloc(0)), true, 'an empty text file is text')
  assert.equal(familyMatches(null, null, Buffer.alloc(0)), false)
})
