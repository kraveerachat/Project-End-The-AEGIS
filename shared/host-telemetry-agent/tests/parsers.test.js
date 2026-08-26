// tests/parsers.test.js — AEGIS host telemetry agent · pure parser contracts
//
// Parsers are deliberately separated from filesystem I/O: every case below is a
// string the kernel could actually produce, so no test needs a real /proc.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cpuPercentFromDelta, networkRateFromDelta, parseMemInfo, parseNetworkCounter,
  parseProcStat, parseUptime,
} from '../src/parsers.js'

// ── TELEM-1A · /proc/stat parser ──────────────────────────────────────
test('TELEM-1A parses the aggregate cpu row into idle and total jiffies', () => {
  const text = [
    'cpu  100 20 30 400 50 6 4 0 0 0',
    'cpu0 50 10 15 200 25 3 2 0 0 0',
    'intr 12345',
  ].join('\n')

  const parsed = parseProcStat(text)

  // idle = idle(400) + iowait(50); total sums the first eight fields only —
  // guest/guest_nice are already accounted for inside user/nice.
  assert.deepEqual(parsed, { idleJiffies: 450, totalJiffies: 610 })
})

test('TELEM-1A refuses malformed, non-finite, and negative cpu rows', () => {
  for (const [label, text] of [
    ['no cpu row', 'intr 12345\nctxt 99'],
    ['empty input', ''],
    ['non-numeric field', 'cpu  100 abc 30 400 50 6 4 0'],
    ['Infinity', 'cpu  Infinity 20 30 400 50 6 4 0'],
    ['NaN literal', 'cpu  NaN 20 30 400 50 6 4 0'],
    ['negative jiffies', 'cpu  -100 20 30 400 50 6 4 0'],
    ['truncated before iowait', 'cpu  100 20 30'],
    ['not a string', null],
  ]) {
    assert.equal(parseProcStat(text), null, `${label} must be refused, never coerced to 0`)
  }
})

// ── TELEM-1B · CPU delta calculation ──────────────────────────────────
test('TELEM-1B derives cpu percent from the delta between two samples', () => {
  const previous = { idleJiffies: 400, totalJiffies: 1000 }
  const next = { idleJiffies: 500, totalJiffies: 1200 }
  // 200 jiffies elapsed, 100 of them idle → 50% busy.
  assert.equal(cpuPercentFromDelta(previous, next), 50)
})

test('TELEM-1B clamps a valid result into 0..100', () => {
  // Idle can legitimately regress by a jiffie across a counter update; the
  // window is still real, so clamp rather than discard the whole sample.
  assert.equal(cpuPercentFromDelta({ idleJiffies: 0, totalJiffies: 0 }, { idleJiffies: -5, totalJiffies: 100 }), 100)
  assert.equal(cpuPercentFromDelta({ idleJiffies: 0, totalJiffies: 0 }, { idleJiffies: 150, totalJiffies: 100 }), 0)
})

test('TELEM-1B refuses zero, negative, and non-finite deltas', () => {
  const base = { idleJiffies: 400, totalJiffies: 1000 }
  for (const [label, previous, next] of [
    ['zero total delta', base, { idleJiffies: 400, totalJiffies: 1000 }],
    ['negative total delta (counter reset)', base, { idleJiffies: 100, totalJiffies: 500 }],
    ['non-finite next total', base, { idleJiffies: 500, totalJiffies: Infinity }],
    ['null previous', null, base],
    ['null next', base, null],
  ]) {
    assert.equal(cpuPercentFromDelta(previous, next), null, `${label} must be refused`)
  }
})

// ── TELEM-2A · /proc/meminfo parser ───────────────────────────────────
const MEMINFO = [
  'MemTotal:        8138332 kB',
  'MemFree:          312044 kB',
  'MemAvailable:    5061404 kB',
  'Buffers:          198364 kB',
].join('\n')

test('TELEM-2A parses MemTotal and MemAvailable into bytes and derived usage', () => {
  const parsed = parseMemInfo(MEMINFO)
  assert.equal(parsed.totalBytes, 8138332 * 1024)
  assert.equal(parsed.availableBytes, 5061404 * 1024)
  // used is what the host cannot hand out, i.e. total - available.
  assert.equal(parsed.usedBytes, (8138332 - 5061404) * 1024)
  assert.equal(parsed.percent, ((8138332 - 5061404) / 8138332) * 100)
  assert.ok(parsed.usedBytes >= 0 && parsed.usedBytes <= parsed.totalBytes)
})

test('TELEM-2A refuses input missing a required key or violating 0 <= used <= total', () => {
  for (const [label, text] of [
    ['no MemAvailable', 'MemTotal:        8138332 kB\nMemFree:  312044 kB'],
    ['no MemTotal', 'MemAvailable:    5061404 kB'],
    ['zero MemTotal', 'MemTotal:              0 kB\nMemAvailable:          0 kB'],
    ['available exceeds total', 'MemTotal:        100 kB\nMemAvailable:     200 kB'],
    ['non-numeric', 'MemTotal:        abc kB\nMemAvailable:    5061404 kB'],
    ['negative', 'MemTotal:        -8 kB\nMemAvailable:    4 kB'],
    ['not a string', undefined],
  ]) {
    assert.equal(parseMemInfo(text), null, `${label} must be refused`)
  }
})

// ── TELEM-4A · network counter parser ─────────────────────────────────
test('TELEM-4A parses a /sys/class/net statistics counter', () => {
  assert.equal(parseNetworkCounter('123456789\n'), 123456789)
  assert.equal(parseNetworkCounter('0'), 0)
})

test('TELEM-4A refuses malformed counters', () => {
  for (const [label, text] of [
    ['empty', ''],
    ['whitespace only', '   \n'],
    ['non-numeric', 'not-a-number'],
    ['negative', '-1'],
    ['Infinity', 'Infinity'],
    ['float garbage', '12.3.4'],
    ['not a string', null],
  ]) {
    assert.equal(parseNetworkCounter(text), null, `${label} must be refused`)
  }
})

// ── TELEM-4B · network delta rate calculation ─────────────────────────
test('TELEM-4B derives per-second throughput from two counter samples', () => {
  const rate = networkRateFromDelta(
    { rxBytes: 1_000, txBytes: 2_000, atMs: 10_000 },
    { rxBytes: 6_000, txBytes: 4_500, atMs: 15_000 },
  )
  assert.deepEqual(rate, { rxBytesPerSec: 1000, txBytesPerSec: 500, windowSeconds: 5 })
})

test('TELEM-4B refuses counter resets and non-advancing clocks', () => {
  const base = { rxBytes: 1_000, txBytes: 2_000, atMs: 10_000 }
  for (const [label, previous, next] of [
    ['negative rx delta', base, { rxBytes: 10, txBytes: 3_000, atMs: 15_000 }],
    ['negative tx delta', base, { rxBytes: 2_000, txBytes: 10, atMs: 15_000 }],
    ['zero time delta', base, { rxBytes: 2_000, txBytes: 3_000, atMs: 10_000 }],
    ['negative time delta', base, { rxBytes: 2_000, txBytes: 3_000, atMs: 9_000 }],
    ['non-finite counter', base, { rxBytes: Infinity, txBytes: 3_000, atMs: 15_000 }],
    ['null previous', null, base],
    ['null next', base, null],
  ]) {
    assert.equal(networkRateFromDelta(previous, next), null, `${label} must be refused`)
  }
})

// ── TELEM-6A · /proc/uptime parser ────────────────────────────────────
test('TELEM-6A parses host uptime seconds', () => {
  assert.equal(parseUptime('12345.67 98765.43\n'), 12345.67)
  assert.equal(parseUptime('0.00 0.00'), 0)
})

test('TELEM-6A refuses non-finite or negative uptime', () => {
  for (const [label, text] of [
    ['empty', ''],
    ['non-numeric', 'up 3 days'],
    ['negative', '-1.0 2.0'],
    ['Infinity', 'Infinity 2.0'],
    ['not a string', 42],
  ]) {
    assert.equal(parseUptime(text), null, `${label} must be refused`)
  }
})
