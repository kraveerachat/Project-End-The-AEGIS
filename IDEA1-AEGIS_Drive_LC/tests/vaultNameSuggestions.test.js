// tests/vaultNameSuggestions.test.js — AEGIS Drive (IDEA1) · PR220-R1 · migration collision suggestions
//
// Human Acceptance: the collision step pre-filled two identical names, so "Continue" looked
// dead. Suggestions are editable proposals only — nothing is written until the Human presses
// Continue — and they must use the SAME collision semantics as TREE (NFC + case fold).
import test from 'node:test'
import assert from 'node:assert/strict'

import { suggestCollisionNames, suggestRecoveryName } from '../src/lib/vaultNameSuggestions.js'
import { collisionKey } from '../src/lib/vaultTreeManifest.js'

const entry = (name, id) => ({ name, blobRef: { formatVersion: 1, id } })
function planOf(names) {
  const entries = names.map((n, i) => entry(n, `id${i}`))
  const groups = new Map()
  for (const e of entries) {
    const k = collisionKey(e.name)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e)
  }
  const collisions = [...groups.entries()].filter(([, m]) => m.length > 1).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, m]) => ({ key, entries: m }))
  return { entries, collisions }
}
const suggested = (plan) => { const m = suggestCollisionNames(plan); return plan.entries.map((e) => m.get(e) ?? e.name) }

test('SUGGEST-1 exact duplicates get deterministic unique names; extension preserved; first keeps its name', () => {
  assert.deepEqual(suggested(planOf(['photo.jpg', 'photo.jpg', 'photo.jpg'])), ['photo.jpg', 'photo (2).jpg', 'photo (3).jpg'])
  assert.deepEqual(suggested(planOf(['photo.jpg', 'photo.jpg', 'photo.jpg'])), suggested(planOf(['photo.jpg', 'photo.jpg', 'photo.jpg'])), 'deterministic')
})

test('SUGGEST-2 case-only and NFC/NFD names collide exactly like TREE and get suggestions', () => {
  assert.deepEqual(suggested(planOf(['notes.txt', 'NOTES.TXT'])), ['notes.txt', 'NOTES (2).TXT'])
  const nfc = 'café.txt'
  const nfd = 'café.txt'
  const out = suggested(planOf([nfc, nfd]))
  assert.equal(out[0], nfc)
  assert.notEqual(collisionKey(out[1]), collisionKey(out[0]), 'the NFD twin is renamed')
})

test('SUGGEST-3 suggestions never collide with any other name in the plan (case-folded)', () => {
  const out = suggested(planOf(['photo.jpg', 'PHOTO.jpg', 'Photo (2).JPG', 'readme']))
  assert.equal(new Set(out.map(collisionKey)).size, out.length, `all unique: ${out}`)
  assert.equal(out[1], 'PHOTO (3).jpg', 'skips a suffix already used by another item, case-insensitively')
  assert.deepEqual(suggested(planOf(['readme', 'README'])), ['readme', 'README (2)'], 'no extension → suffix at the end')
  assert.deepEqual(suggested(planOf(['.env', '.ENV'])), ['.env', '.ENV (2)'], 'a leading dot is not an extension')
})

test('SUGGEST-4 a plan without collisions suggests nothing', () => {
  assert.equal(suggestCollisionNames(planOf(['a.txt', 'b.txt'])).size, 0)
})

/* ── PR220-R2 B3: recovery "Recover with a new name" suggestion ─────────────── */
test('SUGGEST-5 recovery suggestion: TREE collision semantics, extension preserved, deterministic', () => {
  assert.equal(suggestRecoveryName('IMG_3107.JPG', ['img_3107.jpg']), 'IMG_3107 (2).JPG', 'case-fold collision → (2), extension kept')
  assert.equal(suggestRecoveryName('IMG_3107.JPG', ['IMG_3107.JPG', 'img_3107 (2).JPG']), 'IMG_3107 (3).JPG', 'skips a used suffix case-insensitively')
  assert.equal(suggestRecoveryName('IMG_3107.JPG', ['IMG_3107.JPG']), suggestRecoveryName('IMG_3107.JPG', ['IMG_3107.JPG']), 'deterministic')
  const nfd = 'CAFÉ.JPG'
  const out = suggestRecoveryName(nfd, ['café.jpg'])
  assert.notEqual(collisionKey(out), collisionKey('café.jpg'), 'NFC/NFD twin is renamed')
  assert.ok(out.endsWith('.JPG'))
  assert.equal(suggestRecoveryName('new.jpg', ['other.jpg']), 'new.jpg', 'no collision → keep the original name')
})
