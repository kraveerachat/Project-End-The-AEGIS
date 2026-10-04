// tests/zipEntryNames.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 1
//
// spec §5: every ZIP entry name is sanitised (no path, no reserved device name, ≤ 255 UTF-8 bytes)
// and de-duplicated case-insensitively in plan order, so an archive can never zip-slip on
// extraction and two entries can never overwrite each other on Windows/macOS filesystems.
import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeZipEntryName, assignZipEntryNames } from '../src/lib/zipEntryNames.js'

const utf8Bytes = (s) => new TextEncoder().encode(s).length
// TextEncoder silently maps a lone surrogate to U+FFFD, so a split astral code point must be
// caught on the UTF-16 string itself
const noSplitCodePoint = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

/* ── 1a sanitizeZipEntryName ─────────────────────────────────────── */

test('ZN-1 path components and traversal never survive', () => {
  assert.equal(sanitizeZipEntryName('../x'), '.._x')
  assert.equal(sanitizeZipEntryName('..'), '_')
  assert.equal(sanitizeZipEntryName('.'), '_')
  assert.equal(sanitizeZipEntryName('a/b\\c'), 'a_b_c')
  assert.equal(sanitizeZipEntryName('/etc/passwd'), '_etc_passwd')
})

test('ZN-2 Windows-forbidden characters each become _', () => {
  for (const ch of [':', '*', '?', '"', '<', '>', '|']) {
    assert.equal(sanitizeZipEntryName(`a${ch}b`), 'a_b', `char ${ch}`)
  }
})

test('ZN-3 C0 and C1 control characters become _', () => {
  assert.equal(sanitizeZipEntryName('a\u0000b'), 'a_b')
  assert.equal(sanitizeZipEntryName('a\u001fb'), 'a_b')
  assert.equal(sanitizeZipEntryName('a\u007fb'), 'a_b')
  assert.equal(sanitizeZipEntryName('a\u0085b'), 'a_b')
  assert.equal(sanitizeZipEntryName('a\u009fb'), 'a_b')
  assert.equal(sanitizeZipEntryName('a b'), 'a b', 'U+00A0 is not a control character')
})

test('ZN-4 surrounding whitespace and trailing dots are stripped', () => {
  assert.equal(sanitizeZipEntryName('  x  '), 'x')
  assert.equal(sanitizeZipEntryName('name.'), 'name')
  assert.equal(sanitizeZipEntryName('name...'), 'name')
  assert.equal(sanitizeZipEntryName('name. . '), 'name')
})

test('ZN-5 reserved device names get a _ prefix, with or without an extension', () => {
  assert.equal(sanitizeZipEntryName('CON'), '_CON')
  assert.equal(sanitizeZipEntryName('con.txt'), '_con.txt')
  assert.equal(sanitizeZipEntryName('COM¹'), '_COM¹')
  assert.equal(sanitizeZipEntryName('LPT0.log'), '_LPT0.log')
  assert.equal(sanitizeZipEntryName('nul.tar.gz'), '_nul.tar.gz')
  assert.equal(sanitizeZipEntryName('Aux'), '_Aux')
  assert.equal(sanitizeZipEntryName('CONSOLE.txt'), 'CONSOLE.txt')
  assert.equal(sanitizeZipEntryName('COM10'), 'COM10')
})

test('ZN-6 empty results become file', () => {
  assert.equal(sanitizeZipEntryName(''), 'file')
  assert.equal(sanitizeZipEntryName('   '), 'file')
  assert.equal(sanitizeZipEntryName('...'), 'file')
})

test('ZN-7 NFD input is normalised to NFC', () => {
  const out = sanitizeZipEntryName('café.txt')
  assert.equal(out, 'café.txt')
  assert.equal(out, out.normalize('NFC'))
})

test('ZN-8 Thai, CJK and emoji names round-trip unchanged', () => {
  for (const name of ['รายงาน.pdf', '报告 2026.docx', '写真🙂.jpg', '🎉.png']) {
    assert.equal(sanitizeZipEntryName(name), name)
  }
})

test('ZN-9 a 300-byte Thai name keeps .pdf, fits 255 bytes and is cut on a code-point boundary', () => {
  const stem = 'ก'.repeat(100) // 3 bytes each = 300 bytes
  const out = sanitizeZipEntryName(`${stem}.pdf`)
  assert.ok(utf8Bytes(out) <= 255, `got ${utf8Bytes(out)} bytes`)
  assert.ok(out.endsWith('.pdf'))
  assert.ok(out.startsWith('ก'))
  assert.equal(utf8Bytes(out.slice(0, -4)) % 3, 0, 'no partial Thai character')
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(out)))
})

test('ZN-10 an extension longer than 32 bytes is not preserved; the result still fits', () => {
  const longExt = 'b'.repeat(40)
  const out = sanitizeZipEntryName(`${'a'.repeat(250)}.${longExt}`)
  assert.ok(utf8Bytes(out) <= 255)
  assert.ok(!out.endsWith(`.${longExt}`))
})

test('ZN-11 emoji at the truncation boundary is never split', () => {
  const out = sanitizeZipEntryName(`${'a'.repeat(250)}${'🙂'.repeat(5)}`)
  assert.ok(utf8Bytes(out) <= 255)
  assert.ok(noSplitCodePoint(out))
  assert.equal(out, `${'a'.repeat(250)}🙂`)
})

test('ZN-12 a non-string input is converted with String()', () => {
  assert.equal(sanitizeZipEntryName(42), '42')
  assert.equal(sanitizeZipEntryName(null), 'null')
})

/* ── 1b assignZipEntryNames ──────────────────────────────────────── */

test('ZD-1 case-insensitive duplicates get (2) before the extension', () => {
  assert.deepEqual(assignZipEntryNames(['A.txt', 'a.txt']), ['A.txt', 'a (2).txt'])
})

test('ZD-2 three copies number (2) and (3)', () => {
  assert.deepEqual(assignZipEntryNames(['x.txt', 'x.txt', 'x.txt']), ['x.txt', 'x (2).txt', 'x (3).txt'])
})

test('ZD-3 a suffixed candidate is checked against names that already look suffixed', () => {
  assert.deepEqual(assignZipEntryNames(['x.txt', 'x (2).txt', 'x.txt']), ['x.txt', 'x (2).txt', 'x (3).txt'])
})

test('ZD-4 dotfiles have no extension; the suffix goes before the last extension only', () => {
  assert.deepEqual(assignZipEntryNames(['.env', '.env']), ['.env', '.env (2)'])
  assert.deepEqual(assignZipEntryNames(['archive.tar.gz', 'archive.tar.gz']), ['archive.tar.gz', 'archive.tar (2).gz'])
  assert.deepEqual(assignZipEntryNames(['README', 'readme']), ['README', 'readme (2)'])
})

test('ZD-5 NFC and NFD forms of one name collide', () => {
  assert.deepEqual(assignZipEntryNames(['café.txt', 'café.txt']), ['café.txt', 'café (2).txt'])
})

test('ZD-6 a 255-byte name plus a suffix is re-truncated to 255 bytes and stays unique', () => {
  const name = `${'a'.repeat(251)}.txt`
  assert.equal(utf8Bytes(name), 255)
  const out = assignZipEntryNames([name, name, name])
  for (const n of out) assert.ok(utf8Bytes(n) <= 255, `${utf8Bytes(n)} bytes`)
  assert.equal(new Set(out.map((n) => n.toLowerCase())).size, 3)
  assert.ok(out[1].endsWith(' (2).txt'))
  assert.ok(out[2].endsWith(' (3).txt'))
})

test('ZD-7 output is sanitised, deterministic and in plan order', () => {
  const input = ['b.txt', '../b.txt', 'B.TXT', 'CON', 'con', '']
  const a = assignZipEntryNames(input)
  assert.deepEqual(assignZipEntryNames([...input]), a)
  assert.deepEqual(a, ['b.txt', '.._b.txt', 'B (2).TXT', '_CON', '_con (2)', 'file'])
})
