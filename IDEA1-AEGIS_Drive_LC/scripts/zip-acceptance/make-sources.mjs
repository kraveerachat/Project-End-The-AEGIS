#!/usr/bin/env node
// scripts/zip-acceptance/make-sources.mjs — AEGIS Drive (IDEA1) · multi-file streaming ZIP acceptance sources
//
// Builds the deterministic source files the SEPARATE reader/memory acceptance gate uploads to a
// non-Production instance, then downloads back as one ZIP (spec §24). This script never talks to AEGIS.
//
//   node scripts/zip-acceptance/make-sources.mjs --set R1 --out <dir>      small set: 0-byte, Thai/CJK/emoji,
//                                                                         duplicate and reserved names
//   node scripts/zip-acceptance/make-sources.mjs --set R2 --out <dir>      size-ZIP64: one ≥ 4.1 GiB file + 3 small
//   node scripts/zip-acceptance/make-sources.mjs --set R3 --out <dir>      offset-only ZIP64: 4 × ~1.1 GiB, then 1 KiB
//   add --dry-run to print the plan as JSON without writing anything
//
// Every file is a deterministic byte pattern streamed through one reused 1 MiB buffer — multi-GiB sets are
// never held in memory. manifest.json records path, name (the name to give the file in AEGIS), size and SHA-256.
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'

import { zipLayout } from '../../src/lib/bulkDownloadPlan.js'

const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB

const SETS = {
  R1: () => [
    { path: 'hello.txt', name: 'hello.txt', size: 13, seed: 1 },
    { path: 'empty.bin', name: 'empty.bin', size: 0, seed: 2 },
    { path: 'thai.pdf', name: 'รายงานประจำปี.pdf', size: 2000, seed: 3 },
    { path: 'cjk.docx', name: '年度报告.docx', size: 3000, seed: 4 },
    { path: 'emoji.jpg', name: '🙂 photo.jpg', size: 1500, seed: 5 },
    { path: 'dup-a/Report.txt', name: 'Report.txt', size: 100, seed: 6 },
    { path: 'dup-b/report.txt', name: 'report.txt', size: 120, seed: 7 },
    // Windows cannot create CON.txt on disk: the file is stored under a safe path and renamed in AEGIS
    { path: 'reserved/con-device-name.txt', name: 'CON.txt', size: 50, seed: 8 },
    { path: 'spaces.txt', name: '  name with spaces .txt', size: 64, seed: 9 },
  ],
  R2: () => [
    { path: 'r2-big.bin', name: 'r2-big.bin', size: Math.ceil(4.1 * GiB), seed: 21 },
    { path: 'r2-a.txt', name: 'r2-a.txt', size: 10 * KiB, seed: 22 },
    { path: 'r2-b.txt', name: 'r2-b.txt', size: 0, seed: 23 },
    { path: 'r2-c.txt', name: 'r2-c.txt', size: 333, seed: 24 },
  ],
  R3: () => [
    ...[1, 2, 3, 4].map((i) => ({ path: `r3-${i}.bin`, name: `r3-${i}.bin`, size: Math.floor(1.1 * GiB), seed: 30 + i })),
    { path: 'r3-final.bin', name: 'r3-final.bin', size: KiB, seed: 39 },
  ],
}

function parseArgs(argv) {
  const args = { set: null, out: null, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--set') args.set = argv[++i]
    else if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
  }
  if (!SETS[args.set]) throw new Error('--set must be R1, R2 or R3')
  if (!args.dryRun && !args.out) throw new Error('--out <dir> is required unless --dry-run')
  return args
}

/** byte(p) = (p * 167 + seed) & 0xFF over one reused 1 MiB buffer (period 256 divides 1 MiB) */
function patternBuffer(seed) {
  const b = new Uint8Array(MiB)
  for (let p = 0; p < MiB; p += 1) b[p] = (p * 167 + seed) & 0xFF
  return b
}

async function writePatternFile(file, size, seed) {
  const buf = patternBuffer(seed)
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  let left = size
  while (left > 0) {
    const chunk = left >= MiB ? buf : buf.subarray(0, left)
    hash.update(chunk)
    if (!out.write(chunk)) await once(out, 'drain')
    left -= chunk.length
  }
  out.end()
  await once(out, 'finish')
  return hash.digest('hex')
}

function dryRunPlan(set, files) {
  const plan = { set, files: files.map(({ name, size }) => ({ name, size })) }
  if (set === 'R3') {
    const layout = zipLayout(files.map((f) => ({ name: f.name, size: f.size })))
    plan.finalEntry = files.at(-1).name
    plan.finalEntryOffset = layout.entries.at(-1).offset
    if (!(plan.finalEntryOffset >= 0xFFFFFFFF)) throw new Error('R3 final entry would not start at or beyond 0xFFFFFFFF')
    if (files.slice(0, -1).some((f) => f.size >= 0xFFFFFFFF)) throw new Error('R3 preceding entries must not be size-ZIP64')
  }
  return plan
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const files = SETS[args.set]()
  const plan = dryRunPlan(args.set, files)
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }
  const manifest = { set: args.set, files: [] }
  for (const f of files) {
    const target = path.join(args.out, f.path)
    mkdirSync(path.dirname(target), { recursive: true })
    const sha256 = await writePatternFile(target, f.size, f.seed)
    manifest.files.push({ path: f.path, name: f.name, size: f.size, sha256 })
  }
  if (plan.finalEntryOffset !== undefined) manifest.finalEntry = plan.finalEntry
  writeFileSync(path.join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`wrote ${manifest.files.length} files and manifest.json to ${args.out}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
