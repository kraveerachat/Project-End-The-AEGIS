// tests/previewFilesWiring.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 · Task 4 (Files wiring)
//
// Normal Files asks the shared capability resolver instead of its own extension list, with the
// previewable set unchanged: exactly the server /preview allowlist, case-insensitive.
import test from 'node:test'
import assert from 'node:assert/strict'
import { previewKindFor } from '../src/lib/filesView.js'

const file = (over) => ({ id: 'f1', kind: 'file', vault: false, ...over })

test('FW-1 the previewable set is unchanged and case-insensitive', () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']) {
    assert.equal(previewKindFor(file({ name: `a.${ext}`, ext })), 'image', ext)
    assert.equal(previewKindFor(file({ name: `a.${ext.toUpperCase()}`, ext })), 'image', `${ext} upper`)
  }
  for (const ext of ['mp4', 'webm']) assert.equal(previewKindFor(file({ name: `a.${ext}`, ext })), 'video', ext)
  for (const ext of ['mov', 'mkv', 'm4v', 'svg', 'pdf', 'mp3', 'heic', 'tar.gz', '']) {
    assert.equal(previewKindFor(file({ name: `a.${ext}`, ext })), null, ext || '(none)')
  }
})

test('FW-2 folders and Vault rows never get a Files preview', () => {
  assert.equal(previewKindFor(file({ name: 'pics.jpg', ext: 'jpg', kind: 'folder' })), null)
  assert.equal(previewKindFor(file({ name: 'secret.jpg', ext: 'jpg', vault: true })), null)
  assert.equal(previewKindFor(null), null)
})

test('FW-3 the decision comes from the shared resolver: a row carrying only its name resolves like a full row', () => {
  assert.equal(previewKindFor(file({ name: 'Holiday.JPG' })), 'image', 'name-only rows resolve through detectFormat')
  assert.equal(previewKindFor(file({ name: 'clip.WEBM' })), 'video')
  assert.equal(previewKindFor(file({ name: 'README' })), null)
})
