// tests/previewFormatTable.test.js — AEGIS Drive (IDEA1) · Unified Preview P1 · Task 1
//
// The server format table separates INLINE-previewable entries (what GET /files/:id/preview may serve)
// from DERIVATIVE-eligible entries (what the poster/motion pipeline may process). The derivative set must
// stay exactly the 9 extensions it was before P1 (NORMAL_FILES_POSTER_MOTION_PIPELINE=UNCHANGED).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FORMAT_TABLE, PREVIEW_MIME, PREVIEW_EXTENSIONS, isPreviewableExtension, inlineEntryForName, previewMimeForName,
} from '../server/config/previewMedia.js'
import { FORMAT_IDS, familyOf } from '../src/lib/preview/formats.js'

const DERIVATIVE_9 = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm' }
const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm' }
const TEXT_EXTS = 'txt log md markdown json csv tsv xml svg html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs rb php sh ps1 bat yml yaml toml ini cfg conf sql kt swift'.split(' ')

test('FT-1 the derivative-eligible set is exactly the former 9 (PREVIEW_MIME / isPreviewableExtension unchanged)', () => {
  assert.deepEqual(PREVIEW_MIME, DERIVATIVE_9)
  assert.ok(Object.isFrozen(PREVIEW_MIME))
  assert.deepEqual([...PREVIEW_EXTENSIONS], Object.keys(DERIVATIVE_9))
  assert.equal(isPreviewableExtension('JPG'), true)
  for (const ext of ['mp3', 'wav', 'txt', 'md', 'svg', 'html', 'pdf', 'json']) assert.equal(isPreviewableExtension(ext), false, ext)
  const derivative = Object.entries(FORMAT_TABLE).filter(([, e]) => e.derivative !== 'none').map(([ext]) => ext).sort()
  assert.deepEqual(derivative, Object.keys(DERIVATIVE_9).sort())
})

test('FT-2 inline entries: audio MIME map, every text extension is text/plain; charset=utf-8', () => {
  for (const [ext, mime] of Object.entries(AUDIO)) {
    assert.equal(previewMimeForName(`song.${ext.toUpperCase()}`), mime, ext)
    assert.equal(inlineEntryForName(`a.${ext}`).family, 'audio', ext)
    assert.equal(inlineEntryForName(`a.${ext}`).derivative, 'none', ext)
  }
  for (const ext of TEXT_EXTS) {
    assert.equal(previewMimeForName(`file.${ext}`), 'text/plain; charset=utf-8', ext)
    assert.equal(inlineEntryForName(`file.${ext}`).family, 'text', ext)
  }
  assert.equal(previewMimeForName('song.MP3'), 'audio/mpeg')
  assert.equal(previewMimeForName('page.svg'), 'text/plain; charset=utf-8')
  assert.equal(previewMimeForName('page.html'), 'text/plain; charset=utf-8')
  for (const [ext, mime] of Object.entries(DERIVATIVE_9)) assert.equal(previewMimeForName(`x.${ext}`), mime, `${ext} unchanged`)
})

test('FT-3 out of scope / unknown names have no inline entry', () => {
  for (const name of ['a.docx', 'a.pdf', 'x.tar.gz', 'Makefile', 'README', '', 'a.heic', 'a.mov', 'a.exe']) {
    assert.equal(inlineEntryForName(name), null, name)
    assert.equal(previewMimeForName(name), null, name)
  }
})

test('FT-4 every entry names a known FormatId whose client family agrees; entries are frozen; no active MIME', () => {
  assert.ok(Object.isFrozen(FORMAT_TABLE))
  for (const [ext, e] of Object.entries(FORMAT_TABLE)) {
    assert.ok(Object.isFrozen(e), ext)
    assert.ok(FORMAT_IDS.includes(e.formatId), `${ext}: ${e.formatId}`)
    const fam = familyOf(e.formatId)
    if (e.family === 'audio' && ext === 'weba') assert.equal(e.formatId, 'webm') // WebM container holding audio only
    else assert.equal(e.family === 'animated-image' ? 'animated-image' : e.family, fam, ext)
    assert.doesNotMatch(e.inlineMime, /html|svg|xml|javascript/i, `${ext} must never be served with an active MIME`)
  }
})
