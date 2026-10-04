// tests/zipStreamWriter.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Tasks 2a and 3
//
// spec §7.2: ZIP64 end records are written iff N ≥ 0xFFFF, cdSize ≥ 0xFFFFFFFF or cdStart ≥ 0xFFFFFFFF.
// One pure predicate decides it, and both the exact-length formula and the writer use it.
import test from 'node:test'
import assert from 'node:assert/strict'

import { needsZip64End } from '../src/lib/zipStreamWriter.js'

/* ── 2a needsZip64End ────────────────────────────────────────────── */

test('Z64END-1 each trigger flips exactly at its boundary with the other inputs at 0', () => {
  const cases = [
    [{ entryCount: 0xFFFE, cdSize: 0, cdStart: 0 }, false],
    [{ entryCount: 0xFFFF, cdSize: 0, cdStart: 0 }, true],
    [{ entryCount: 0, cdSize: 0xFFFFFFFE, cdStart: 0 }, false],
    [{ entryCount: 0, cdSize: 0xFFFFFFFF, cdStart: 0 }, true],
    [{ entryCount: 0, cdSize: 0, cdStart: 0xFFFFFFFE }, false],
    [{ entryCount: 0, cdSize: 0, cdStart: 0xFFFFFFFF }, true],
  ]
  for (const [input, expected] of cases) {
    assert.equal(needsZip64End(input), expected, JSON.stringify(input))
  }
})

test('Z64END-2 all-small inputs need no ZIP64 end records', () => {
  assert.equal(needsZip64End({ entryCount: 1000, cdSize: 330_000, cdStart: 1024 }), false)
})
