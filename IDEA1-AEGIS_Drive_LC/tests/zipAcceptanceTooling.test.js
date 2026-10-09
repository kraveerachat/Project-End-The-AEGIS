// tests/zipAcceptanceTooling.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 14a
//
// The reader/memory acceptance itself is a SEPARATE later gate (spec §24, plan C-2). This suite only proves
// the tooling that gate will use: deterministic source sets (R1 small/zero/names, R2 size-ZIP64, R3 real
// offset-only ZIP64), and a Python verifier for archives and for folders extracted by OS readers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createZipStreamWriter } from '../src/lib/zipStreamWriter.js'
import { assignZipEntryNames } from '../src/lib/zipEntryNames.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const toolDir = path.join(root, 'scripts', 'zip-acceptance')
const makeSources = path.join(toolDir, 'make-sources.mjs')
const verifyZip = path.join(toolDir, 'verify_zip.py')
const GiB = 1024 ** 3
const python = (() => {
  const r = spawnSync('python', ['--version'], { encoding: 'utf8' })
  return r.error || r.status !== 0 ? null : 'python'
})()
const runNode = (args) => spawnSync(process.execPath, [makeSources, ...args], { encoding: 'utf8' })
const runPy = (args) => spawnSync(python, [verifyZip, ...args], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
const sha = (b) => createHash('sha256').update(b).digest('hex')

function withTmp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aegis-zipacc-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

async function zipFromManifest(dir, manifest) {
  const chunks = []
  const writer = createZipStreamWriter({ sink: { async write(b) { chunks.push(b.slice()) } }, now: new Date(2026, 9, 5) })
  await writer.begin()
  const names = assignZipEntryNames(manifest.files.map((f) => f.name))
  for (let i = 0; i < manifest.files.length; i += 1) {
    const bytes = readFileSync(path.join(dir, manifest.files[i].path))
    const es = await writer.addEntry({ name: names[i], size: bytes.length })
    await es.write(new Uint8Array(bytes))
    await es.close()
  }
  await writer.finish()
  return { buf: Buffer.concat(chunks), names }
}

test('ZACC-1 R1 writes deterministic pattern files plus a manifest (0-byte, Thai, CJK, emoji, duplicate, reserved)', async () => {
  await withTmp(async (dir) => {
    const r = runNode(['--set', 'R1', '--out', dir])
    assert.equal(r.status, 0, r.stderr)
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.set, 'R1')
    const names = manifest.files.map((f) => f.name)
    assert.ok(manifest.files.some((f) => f.size === 0), 'a zero-byte file')
    assert.ok(names.some((n) => /[ก-๙]/u.test(n)), 'Thai')
    assert.ok(names.some((n) => /[一-龥]/u.test(n)), 'CJK')
    assert.ok(names.some((n) => /\p{Extended_Pictographic}/u.test(n)), 'emoji')
    assert.ok(names.some((n) => /^CON\b/i.test(n)), 'reserved name')
    const lower = names.map((n) => n.toLowerCase())
    assert.ok(lower.some((n, i) => lower.indexOf(n) !== i), 'a case-insensitive duplicate')
    for (const f of manifest.files) {
      const bytes = readFileSync(path.join(dir, f.path))
      assert.equal(bytes.length, f.size)
      assert.equal(sha(bytes), f.sha256)
    }
    // deterministic: a second run produces identical hashes
    await withTmp(async (dir2) => {
      runNode(['--set', 'R1', '--out', dir2])
      const m2 = JSON.parse(readFileSync(path.join(dir2, 'manifest.json'), 'utf8'))
      assert.deepEqual(m2.files.map((f) => f.sha256), manifest.files.map((f) => f.sha256))
    })
  })
})

test('ZACC-2 R2 --dry-run: one file of at least 4.1 GiB plus 3 small files', () => {
  const r = runNode(['--set', 'R2', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  const plan = JSON.parse(r.stdout)
  const big = plan.files.filter((f) => f.size >= 4.1 * GiB)
  assert.equal(big.length, 1)
  assert.equal(plan.files.filter((f) => f.size < 1024 * 1024).length, 3)
  assert.equal(plan.files.length, 4)
})

test('ZACC-3 R3 --dry-run: 4 × ~1.1 GiB below 0xFFFFFFFF, then 1 KiB whose local header is at ≥ 0xFFFFFFFF', () => {
  const r = runNode(['--set', 'R3', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  const plan = JSON.parse(r.stdout)
  assert.equal(plan.files.length, 5)
  for (const f of plan.files.slice(0, 4)) {
    assert.ok(f.size < 0xFFFFFFFF)
    assert.ok(f.size > 1.05 * GiB)
  }
  assert.equal(plan.files[4].size, 1024)
  assert.ok(plan.finalEntryOffset >= 0xFFFFFFFF, `final local header at ${plan.finalEntryOffset}`)
  assert.equal(plan.finalEntry, plan.files[4].name)
})

test('ZACC-4 verify_zip.py: testzip None + extractall + SHA-256 vs manifest; --inspect-offset-only rejects a classic entry', async (t) => {
  if (!python) { t.skip('python is not available on this machine'); return }
  await withTmp(async (dir) => {
    assert.equal(runNode(['--set', 'R1', '--out', dir]).status, 0)
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    const { buf, names } = await zipFromManifest(dir, manifest)
    const zipPath = path.join(dir, 'r1.zip')
    writeFileSync(zipPath, buf)
    const ok = runPy([zipPath, '--manifest', path.join(dir, 'manifest.json')])
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /PASS/)
    const offsetOnly = runPy([zipPath, '--inspect-offset-only', names[0]])
    assert.notEqual(offsetOnly.status, 0, 'a classic entry is not offset-only ZIP64')
    // a corrupted archive fails
    const bad = Buffer.from(buf)
    bad[40] ^= 0xff
    const badPath = path.join(dir, 'bad.zip')
    writeFileSync(badPath, bad)
    assert.notEqual(runPy([badPath, '--manifest', path.join(dir, 'manifest.json')]).status, 0)
  })
})

test('ZACC-5 verify_zip.py --extracted checks a folder extracted by an OS reader against the manifest', async (t) => {
  if (!python) { t.skip('python is not available on this machine'); return }
  await withTmp(async (dir) => {
    assert.equal(runNode(['--set', 'R1', '--out', dir]).status, 0)
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    const { names } = await zipFromManifest(dir, manifest)
    const out = path.join(dir, 'extracted')
    mkdirSync(out)
    manifest.files.forEach((f, i) => writeFileSync(path.join(out, names[i]), readFileSync(path.join(dir, f.path))))
    const ok = runPy(['--extracted', out, path.join(dir, 'manifest.json')])
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    writeFileSync(path.join(out, names[1]), 'tampered')
    assert.notEqual(runPy(['--extracted', out, path.join(dir, 'manifest.json')]).status, 0)
  })
})

test('ZACC-6 README: R1–R3 and A1–A12 all NOT RUN, plus the memory procedure (section L)', () => {
  const readme = readFileSync(path.join(toolDir, 'README.md'), 'utf8')
  for (const id of ['R1', 'R2', 'R3', ...Array.from({ length: 12 }, (_, i) => `A${i + 1}`)]) {
    const row = readme.split('\n').find((l) => l.startsWith(`| ${id} `))
    assert.ok(row, `${id} row`)
    assert.ok(row.includes('NOT RUN'), `${id} is NOT RUN`)
    assert.ok(!/\bPASS\b/.test(row), `${id} claims nothing`)
  }
  assert.match(readme, /Memory acceptance/i)
  assert.match(readme, /1 GiB/)
  assert.match(readme, /5 GiB/)
  assert.ok(existsSync(verifyZip))
})
