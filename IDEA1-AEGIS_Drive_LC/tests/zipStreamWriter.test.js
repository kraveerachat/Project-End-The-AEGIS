// tests/zipStreamWriter.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Tasks 2a and 3
//
// spec §7.2: ZIP64 end records are written iff N ≥ 0xFFFF, cdSize ≥ 0xFFFFFFFF or cdStart ≥ 0xFFFFFFFF.
// One pure predicate decides it, and both the exact-length formula and the writer use it.
//
// Writer test seams (spec §23, plan C-1/PR-3): a counting sink that keeps only the regions a test asks
// for, one reused ≤ 1 MiB non-zero pattern buffer, a counting CRC hasher, and the test-only startOffset.
// Nothing here allocates more than about 1 MiB, even for the 4 GiB boundary cases.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createCRC32 } from 'hash-wasm'

import { needsZip64End, createZipStreamWriter } from '../src/lib/zipStreamWriter.js'
import { zipLayout } from '../src/lib/bulkDownloadPlan.js'

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

/* ── Task 3 helpers ──────────────────────────────────────────────── */

const MiB = 1 << 20
const WRITER_NOW = new Date(2026, 9, 5, 13, 37, 42)
const SIG = { local: 0x04034b50, desc: 0x08074b50, central: 0x02014b50, eocd: 0x06054b50, z64eocd: 0x06064b50, z64loc: 0x07064b50 }
const enc = new TextEncoder()

/** Counts every physical byte; keeps each write unless `discard` is set (payload streaming). */
function countingSink() {
  const kept = []
  const sink = {
    count: 0, discard: false, closed: false, aborted: false,
    async write(bytes) {
      if (!sink.discard) kept.push({ pos: sink.count, bytes: bytes.slice() })
      sink.count += bytes.length
    },
    close() { sink.closed = true },
    abort() { sink.aborted = true },
    /** bytes at a physical position, assembled from the kept regions */
    at(pos, len) {
      const out = new Uint8Array(len)
      for (const k of kept) {
        const s = Math.max(pos, k.pos)
        const e = Math.min(pos + len, k.pos + k.bytes.length)
        if (s < e) out.set(k.bytes.subarray(s - k.pos, e - k.pos), s - pos)
      }
      return out
    },
    all() { return sink.at(0, sink.count) },
  }
  return sink
}

function countingHasher() {
  const stats = { hashedBytes: 0, updateCalls: 0, inits: 0 }
  const createHasher = async () => {
    const h = await createCRC32()
    return {
      init() { stats.inits += 1; h.init() },
      update(b) { stats.hashedBytes += b.length; stats.updateCalls += 1; h.update(b) },
      digest(f) { return h.digest(f) },
    }
  }
  return { stats, createHasher }
}

// byte(p) = (p * 167 + 13) & 0xFF — period 256 divides 1 MiB, so one reused buffer reproduces it exactly
const PATTERN = (() => {
  const b = new Uint8Array(MiB)
  for (let p = 0; p < MiB; p += 1) b[p] = (p * 167 + 13) & 0xFF
  return b
})()
async function streamPattern(entrySink, n) {
  let left = n
  while (left > 0) {
    const k = Math.min(MiB, left)
    await entrySink.write(k === MiB ? PATTERN : PATTERN.subarray(0, k))
    left -= k
  }
}

const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const u16 = (b, o) => dv(b).getUint16(o, true)
const u32 = (b, o) => dv(b).getUint32(o, true)
const u64 = (b, o) => Number(dv(b).getBigUint64(o, true))

/** Parses the end records, then every central entry with its local header and data descriptor. */
function parseZip(sink, { startOffset = 0 } = {}) {
  const phys = (logical) => logical - startOffset
  const eocd = sink.at(sink.count - 22, 22)
  assert.equal(u32(eocd, 0), SIG.eocd)
  const res = {
    eocd: { entriesDisk: u16(eocd, 8), entries: u16(eocd, 10), cdSize: u32(eocd, 12), cdOffset: u32(eocd, 16), commentLen: u16(eocd, 20) },
    z64: null,
    entries: [],
  }
  let cdOffset = res.eocd.cdOffset
  let cdSize = res.eocd.cdSize
  let count = res.eocd.entries
  const loc = sink.count >= 42 ? sink.at(sink.count - 42, 20) : new Uint8Array(20)
  if (u32(loc, 0) === SIG.z64loc) {
    const z64Offset = u64(loc, 8)
    const r = sink.at(phys(z64Offset), 56)
    assert.equal(u32(r, 0), SIG.z64eocd)
    res.z64 = {
      offset: z64Offset, locDisk: u32(loc, 4), totalDisks: u32(loc, 16), recordSize: u64(r, 4),
      madeBy: u16(r, 12), needed: u16(r, 14), entriesDisk: u64(r, 24), entries: u64(r, 32), cdSize: u64(r, 40), cdOffset: u64(r, 48),
    }
    cdOffset = res.z64.cdOffset
    cdSize = res.z64.cdSize
    count = res.z64.entries
  }
  res.cdOffset = cdOffset
  res.cdSize = cdSize
  const cd = sink.at(phys(cdOffset), cdSize)
  let p = 0
  for (let i = 0; i < count; i += 1) {
    assert.equal(u32(cd, p), SIG.central)
    const n = u16(cd, p + 28)
    const x = u16(cd, p + 30)
    const c = {
      madeBy: u16(cd, p + 4), needed: u16(cd, p + 6), flags: u16(cd, p + 8), method: u16(cd, p + 10),
      time: u16(cd, p + 12), date: u16(cd, p + 14), crc: u32(cd, p + 16), comp: u32(cd, p + 20), uncomp: u32(cd, p + 24),
      nameLen: n, extraLen: x, commentLen: u16(cd, p + 32), disk: u16(cd, p + 34), internal: u16(cd, p + 36),
      external: u32(cd, p + 38), offsetField: u32(cd, p + 42),
      name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + n)),
      extra: cd.slice(p + 46 + n, p + 46 + n + x),
    }
    // ZIP64 fields in APPNOTE order (uncompressed, compressed, offset), only for the fields that overflowed
    let q = 4
    c.size = c.uncomp
    c.offset = c.offsetField
    if (x > 0) {
      assert.equal(u16(c.extra, 0), 0x0001)
      c.z64DataSize = u16(c.extra, 2)
      if (c.uncomp === 0xFFFFFFFF) { c.size = u64(c.extra, q); q += 8 }
      if (c.comp === 0xFFFFFFFF) { c.compSize = u64(c.extra, q); q += 8 }
      if (c.offsetField === 0xFFFFFFFF) { c.offset = u64(c.extra, q); q += 8 }
      assert.equal(q - 4, c.z64DataSize, 'the central ZIP64 extra holds exactly the overflowed fields')
    }
    const lh = sink.at(phys(c.offset), 30)
    assert.equal(u32(lh, 0), SIG.local, `local header of ${c.name} at ${c.offset}`)
    c.local = {
      needed: u16(lh, 4), flags: u16(lh, 6), method: u16(lh, 8), time: u16(lh, 10), date: u16(lh, 12),
      crc: u32(lh, 14), comp: u32(lh, 18), uncomp: u32(lh, 22), nameLen: u16(lh, 26), extraLen: u16(lh, 28),
    }
    c.local.extra = sink.at(phys(c.offset) + 30 + c.local.nameLen, c.local.extraLen)
    c.dataStart = c.offset + 30 + c.local.nameLen + c.local.extraLen
    const wide = c.local.extraLen > 0
    const d = sink.at(phys(c.dataStart + c.size), wide ? 24 : 16)
    assert.equal(u32(d, 0), SIG.desc, 'signed data descriptor')
    c.desc = wide
      ? { len: 24, crc: u32(d, 4), comp: u64(d, 8), uncomp: u64(d, 16) }
      : { len: 16, crc: u32(d, 4), comp: u32(d, 8), uncomp: u32(d, 12) }
    res.entries.push(c)
    p += 46 + n + x + c.commentLen
  }
  return res
}

async function writeArchive(files, opts = {}) {
  const sink = countingSink()
  const { stats, createHasher } = countingHasher()
  const writer = createZipStreamWriter({ sink, createHasher, now: WRITER_NOW, ...opts })
  await writer.begin()
  for (const f of files) {
    const es = await writer.addEntry({ name: f.name, size: f.bytes.length })
    // uneven writes, including a zero-length one
    await es.write(f.bytes.subarray(0, 1))
    await es.write(new Uint8Array(0))
    await es.write(f.bytes.subarray(1))
    await es.close()
  }
  await writer.finish()
  return { sink, stats }
}

const sampleFiles = () => [
  { name: 'hello.txt', bytes: enc.encode('hello, archive') },
  { name: 'empty.bin', bytes: new Uint8Array(0) },
  { name: 'รายงาน 报告 🙂.txt', bytes: PATTERN.subarray(0, 4096) },
]

/* ── 3a core records ─────────────────────────────────────────────── */

test('ZW-1 CRC vectors: "123456789" = 0xCBF43926, empty = 0, 256 pattern bytes = 0xD20B5F2B', async () => {
  const { sink } = await writeArchive([
    { name: 'v.txt', bytes: enc.encode('123456789') },
    { name: 'e', bytes: new Uint8Array(0) },
    { name: 'p', bytes: PATTERN.subarray(0, 256) },
  ])
  const z = parseZip(sink)
  assert.deepEqual(z.entries.map((e) => e.crc), [0xCBF43926, 0, 0xD20B5F2B])
  assert.deepEqual(z.entries.map((e) => e.desc.crc), [0xCBF43926, 0, 0xD20B5F2B])
})

test('ZW-2 round trip: record fields, zero-byte entry, identical DOS time, exact bytes', async () => {
  const files = sampleFiles()
  const { sink, stats } = await writeArchive(files)
  const z = parseZip(sink)
  assert.equal(z.entries.length, 3)
  assert.equal(z.z64, null)
  assert.equal(z.eocd.commentLen, 0)
  assert.equal(z.eocd.entries, 3)
  assert.equal(z.eocd.entriesDisk, 3)
  const dosTime = (13 << 11) | (37 << 5) | (42 >> 1)
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 5
  z.entries.forEach((e, i) => {
    assert.equal(e.name, files[i].name)
    assert.equal(e.flags, 0x0808)
    assert.equal(e.local.flags, 0x0808)
    assert.equal(e.method, 0)
    assert.equal(e.local.method, 0)
    assert.equal(e.madeBy, 45)
    assert.equal(e.needed, 20)
    assert.equal(e.local.needed, 20)
    assert.equal(e.local.crc, 0)
    assert.equal(e.local.comp, 0)
    assert.equal(e.local.uncomp, 0)
    assert.equal(e.local.extraLen, 0)
    assert.equal(e.extraLen, 0)
    assert.equal(e.commentLen, 0)
    assert.equal(e.disk, 0)
    assert.equal(e.internal, 0)
    assert.equal(e.external, 0)
    assert.equal(e.time, dosTime)
    assert.equal(e.local.time, dosTime)
    assert.equal(e.date, dosDate)
    assert.equal(e.local.date, dosDate)
    assert.equal(e.desc.len, 16)
    assert.equal(e.desc.comp, files[i].bytes.length)
    assert.equal(e.desc.uncomp, files[i].bytes.length)
    assert.equal(e.size, files[i].bytes.length)
    assert.equal(e.comp, files[i].bytes.length)
    assert.deepEqual(sink.at(e.dataStart, e.size), files[i].bytes)
  })
  assert.equal(z.entries[1].crc, 0)
  assert.equal(z.entries[1].size, 0)
  assert.equal(stats.inits, 3, 'hasher init per entry')
  assert.equal(stats.hashedBytes, files.reduce((s, f) => s + f.bytes.length, 0))
})

test('ZW-3 UTF-8 names are stored as UTF-8 bytes with bit 11 set', async () => {
  const name = 'ไทย-中文-🙂.txt'
  const { sink } = await writeArchive([{ name, bytes: enc.encode('x') }])
  const z = parseZip(sink)
  assert.equal(z.entries[0].nameLen, enc.encode(name).length)
  assert.equal(z.entries[0].name, name)
  assert.ok(z.entries[0].flags & 0x0800)
})

test('ZW-4 production offset 0: first signature at byte 0, central offset 0, length = zipLayout total', async () => {
  const files = sampleFiles()
  const { sink } = await writeArchive(files)
  assert.deepEqual([...sink.at(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  const z = parseZip(sink)
  assert.equal(z.entries[0].offset, 0)
  assert.equal(sink.count, zipLayout(files.map((f) => ({ name: f.name, size: f.bytes.length }))).total)
})

test('ZW-5 Python zipfile cross-check (testzip() is None, bytes extract exactly)', async (t) => {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) { t.skip('python is not available on this machine'); return }
  const files = sampleFiles()
  const { sink } = await writeArchive(files)
  const dir = mkdtempSync(path.join(tmpdir(), 'aegis-zip-'))
  try {
    const zipPath = path.join(dir, 'a.zip')
    writeFileSync(zipPath, sink.all())
    const script = [
      'import sys, zipfile, hashlib, json',
      'z = zipfile.ZipFile(sys.argv[1])',
      'print(json.dumps({"bad": z.testzip(), "files": {i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}}))',
    ].join('\n')
    const r = spawnSync('python', ['-c', script, zipPath], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.bad, null)
    for (const f of files) assert.equal(out.files[f.name], createHash('sha256').update(f.bytes).digest('hex'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── 3b size-ZIP64 (PR-3: full-length synthetic streaming, real CRC, ≤ 1 MiB) ── */

async function streamOneLarge(size, { startOffset } = {}) {
  const sink = countingSink()
  const { stats, createHasher } = countingHasher()
  const writer = createZipStreamWriter({ sink, createHasher, now: WRITER_NOW, ...(startOffset === undefined ? {} : { startOffset }) })
  await writer.begin()
  const es = await writer.addEntry({ name: 'big.bin', size })
  sink.discard = true
  await streamPattern(es, size)
  sink.discard = false
  await es.close()
  await writer.finish()
  return { sink, stats }
}

test('ZW-6 Case A size-ZIP64 at 0xFFFFFFFF: real CRC 0xBA5A5BB3 over the streamed non-zero pattern', { timeout: 30_000 }, async () => {
  const size = 0xFFFFFFFF
  const { sink, stats } = await streamOneLarge(size)
  assert.equal(stats.hashedBytes, size, 'every declared byte was hashed')
  assert.ok(stats.updateCalls > 0)
  const z = parseZip(sink)
  const e = z.entries[0]
  assert.equal(e.desc.crc, 0xBA5A5BB3)
  assert.equal(e.crc, 0xBA5A5BB3)
  assert.equal(e.local.comp, 0xFFFFFFFF)
  assert.equal(e.local.uncomp, 0xFFFFFFFF)
  assert.equal(e.local.extraLen, 20)
  assert.equal(u16(e.local.extra, 0), 0x0001)
  assert.equal(u16(e.local.extra, 2), 16)
  assert.equal(u64(e.local.extra, 4), 0)
  assert.equal(u64(e.local.extra, 12), 0)
  assert.equal(e.local.needed, 45)
  assert.equal(e.desc.len, 24)
  assert.equal(e.desc.comp, size)
  assert.equal(e.desc.uncomp, size)
  assert.equal(e.comp, 0xFFFFFFFF)
  assert.equal(e.uncomp, 0xFFFFFFFF)
  assert.equal(e.size, size)
  assert.equal(e.compSize, size)
  assert.equal(e.z64DataSize, 16, 'uncompressed then compressed, no offset')
  assert.equal(e.offsetField, 0)
  assert.equal(e.needed, 45)
  assert.ok(z.z64, 'ZIP64 EOCD + locator present')
  assert.equal(z.z64.recordSize, 44)
  assert.equal(z.z64.madeBy, 45)
  assert.equal(z.z64.needed, 45)
  assert.equal(z.z64.entries, 1)
  assert.equal(z.z64.entriesDisk, 1)
  assert.equal(z.z64.locDisk, 0)
  assert.equal(z.z64.totalDisks, 1)
  assert.equal(z.z64.offset, z.cdOffset + z.cdSize)
  assert.equal(z.eocd.cdOffset, 0xFFFFFFFF)
  assert.equal(z.eocd.entries, 1, 'counts did not overflow')
  assert.equal(z.eocd.cdSize, z.cdSize, 'cdSize did not overflow')
  assert.equal(sink.count, zipLayout([{ name: 'big.bin', size }]).total)
})

test('ZW-7 boundary 0xFFFFFFFE: classic entry, CRC 0x8507C66D, end records exactly per needsZip64End', { timeout: 30_000 }, async () => {
  const size = 0xFFFFFFFE
  const { sink, stats } = await streamOneLarge(size)
  assert.equal(stats.hashedBytes, size)
  const z = parseZip(sink)
  const e = z.entries[0]
  assert.equal(e.crc, 0x8507C66D)
  assert.equal(e.desc.crc, 0x8507C66D)
  assert.equal(e.desc.len, 16)
  assert.equal(e.local.extraLen, 0)
  assert.equal(e.extraLen, 0)
  assert.equal(e.needed, 20)
  assert.equal(e.local.needed, 20)
  assert.equal(e.uncomp, size)
  const l = zipLayout([{ name: 'big.bin', size }])
  assert.equal(Boolean(z.z64), needsZip64End({ entryCount: 1, cdSize: l.cdSize, cdStart: l.cdStart }))
  assert.equal(sink.count, l.total)
})

/* ── 3c offset-only ZIP64, predicate wiring, misuse ─────────────────── */

test('ZW-8 Case B offset-only ZIP64: a small entry whose local header is at logical 0xFFFFFFFF', async () => {
  const S = 0xFFFFFFFF
  const { sink } = await streamOneLarge(5, { startOffset: S })
  const z = parseZip(sink, { startOffset: S })
  const e = z.entries[0]
  assert.equal(e.local.comp, 0)
  assert.equal(e.local.extraLen, 0)
  assert.equal(e.local.needed, 45)
  assert.equal(e.desc.len, 16)
  assert.equal(e.desc.uncomp, 5)
  assert.equal(e.uncomp, 5)
  assert.equal(e.comp, 5)
  assert.equal(e.offsetField, 0xFFFFFFFF)
  assert.equal(e.z64DataSize, 8)
  assert.equal(e.offset, S, 'the 64-bit offset is the true logical offset including S')
  assert.equal(e.needed, 45)
  assert.ok(z.z64)
  assert.equal(S + sink.count, zipLayout([{ name: 'big.bin', size: 5 }], { startOffset: S }).total)

  const S2 = 0xFFFFFFFE
  const { sink: s2 } = await streamOneLarge(5, { startOffset: S2 })
  const z2 = parseZip(s2, { startOffset: S2 })
  assert.equal(z2.entries[0].offsetField, S2)
  assert.equal(z2.entries[0].extraLen, 0)
  assert.equal(z2.entries[0].needed, 20)
  assert.equal(z2.entries[0].local.needed, 20)
  assert.equal(S2 + s2.count, zipLayout([{ name: 'big.bin', size: 5 }], { startOffset: S2 }).total)
})

test('ZW-9 cdStart-triggered end records follow needsZip64End at 0xFFFFFFFE vs 0xFFFFFFFF', async () => {
  for (const cdStart of [0xFFFFFFFE, 0xFFFFFFFF]) {
    const S = cdStart - (30 + 1 + 16)
    const sink = countingSink()
    const writer = createZipStreamWriter({ sink, createHasher: countingHasher().createHasher, now: WRITER_NOW, startOffset: S })
    await writer.begin()
    const es = await writer.addEntry({ name: 'z', size: 0 })
    await es.close()
    await writer.finish()
    const l = zipLayout([{ name: 'z', size: 0 }], { startOffset: S })
    assert.equal(l.cdStart, cdStart)
    const z = parseZip(sink, { startOffset: S })
    assert.equal(Boolean(z.z64), needsZip64End({ entryCount: 1, cdSize: l.cdSize, cdStart }))
    assert.equal(z.eocd.cdOffset, cdStart >= 0xFFFFFFFF ? 0xFFFFFFFF : cdStart, 'sentinel only on the overflowed field')
    assert.equal(z.eocd.cdSize, l.cdSize)
    assert.equal(S + sink.count, l.total)
  }
})

test('ZW-10 misuse: overflow write, second open entry, unclosed finish, short close, idempotent close', async () => {
  const sink = countingSink()
  const writer = createZipStreamWriter({ sink, createHasher: countingHasher().createHasher, now: WRITER_NOW })
  await writer.begin()
  const es = await writer.addEntry({ name: 'a', size: 3 })
  const before = sink.count
  await assert.rejects(es.write(new Uint8Array(4)), /exceeds/)
  assert.equal(sink.count, before, 'none of the overflowing bytes were written')
  await assert.rejects(writer.addEntry({ name: 'b', size: 1 }), /open/)
  await assert.rejects(writer.finish(), /open/)
  await es.write(new Uint8Array(2))
  await assert.rejects(es.close(), /size/)
  await es.write(new Uint8Array(1))
  await es.close()
  const afterClose = sink.count
  await es.close()
  assert.equal(sink.count, afterClose, 'a second close writes nothing')
  await es.abort()
  await writer.finish()
  assert.equal(sink.closed, false, 'the writer never closes the sink')
  assert.equal(sink.aborted, false, 'the writer never aborts the sink')
})

test('ZW-11 a hasher failure propagates out of write', async () => {
  const sink = countingSink()
  const writer = createZipStreamWriter({
    sink, now: WRITER_NOW,
    createHasher: async () => ({ init() {}, update() { throw new Error('hasher boom') }, digest() { return '00000000' } }),
  })
  await writer.begin()
  const es = await writer.addEntry({ name: 'a', size: 1 })
  await assert.rejects(es.write(new Uint8Array(1)), /hasher boom/)
})
