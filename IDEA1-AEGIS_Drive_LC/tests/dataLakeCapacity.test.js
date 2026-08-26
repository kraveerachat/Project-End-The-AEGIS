// tests/dataLakeCapacity.test.js — AEGIS Drive (IDEA1) · Data Lake disk
//
// The disk half of Server Telemetry is measured inside Drive, not by the host
// agent: Drive already has the Data Lake mounted, so statfs on STORAGE_ROOT is
// the least-privilege source available. No /proc, no /sys, no host mount.
//
// These tests exist mainly to PIN semantics that already ship. `/api/storage`
// and `/api/dashboard` have been publishing these numbers, and the dashboard
// derives "free" from them. Restating them here means a future change to
// filesystemCapacity() breaks a test instead of quietly moving what the KPI
// tile means.
import test from 'node:test'
import assert from 'node:assert/strict'

import { filesystemCapacity } from '../server/storage/fileStore.js'
import { dataLakeTelemetry } from '../server/telemetry/disk.js'

// The production Data Lake as measured during preflight inside the Drive
// container: STORAGE_ROOT=/datalake, statfs PASS.
const BSIZE = 4096
const BLOCKS = 61_075_263_488 / BSIZE
const BAVAIL = 45_604_417_536 / BSIZE
const BFREE = BAVAIL + 500_000 // root-reserved blocks live between bfree and bavail

const statfsReturning = (result) => async () => result

test('documented semantics: total comes from blocks, free comes from bavail', async () => {
  const capacity = await filesystemCapacity({
    statfs: statfsReturning({ bsize: BSIZE, blocks: BLOCKS, bfree: BFREE, bavail: BAVAIL }),
  })

  assert.equal(capacity.totalBytes, 61_075_263_488)
  // bavail, deliberately, not bfree: Drive runs as uid 1000 (node), so the
  // root-reserved blocks are not space this process could ever write into.
  assert.equal(capacity.freeBytes, 45_604_417_536)
  assert.notEqual(capacity.freeBytes, BFREE * BSIZE, 'bfree would overstate what Drive can use')
})

test('documented semantics: used is total - bavail, so reserved blocks count as used', async () => {
  const capacity = await filesystemCapacity({
    statfs: statfsReturning({ bsize: BSIZE, blocks: BLOCKS, bfree: BFREE, bavail: BAVAIL }),
  })

  assert.equal(capacity.usedBytes, 61_075_263_488 - 45_604_417_536)
  // The consequence, stated so nobody has to rediscover it: `used` includes the
  // root reserve, so used + free == total exactly, and `used` is slightly
  // larger than the bytes actually occupied by files.
  assert.equal(capacity.usedBytes + capacity.freeBytes, capacity.totalBytes)
})

test('documented semantics: the dashboard derivation of free round-trips to bavail', async () => {
  const capacity = await filesystemCapacity({
    statfs: statfsReturning({ bsize: BSIZE, blocks: BLOCKS, bfree: BFREE, bavail: BAVAIL }),
  })
  // Dashboard.jsx renders free as (storageTotalBytes - storageBytes). That must
  // stay equal to freeBytes, or the KPI tile and the Storage screen disagree.
  assert.equal(capacity.totalBytes - capacity.usedBytes, capacity.freeBytes)
})

test('an unreadable or nonsensical filesystem yields null, never zero', async () => {
  const unreadable = await filesystemCapacity({
    statfs: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
  })
  assert.equal(unreadable, null)

  for (const [label, result] of [
    ['zero-sized filesystem', { bsize: BSIZE, blocks: 0, bfree: 0, bavail: 0 }],
    ['zero block size', { bsize: 0, blocks: BLOCKS, bfree: 0, bavail: 0 }],
    ['non-finite blocks', { bsize: BSIZE, blocks: Infinity, bfree: 0, bavail: 0 }],
    ['NaN bavail', { bsize: BSIZE, blocks: BLOCKS, bfree: 0, bavail: NaN }],
  ]) {
    assert.equal(await filesystemCapacity({ statfs: statfsReturning(result) }), null, label)
  }
})

// ── telemetry projection ──────────────────────────────────────────────
test('the telemetry disk metric reuses the existing capacity semantics unchanged', async () => {
  const disk = await dataLakeTelemetry({
    capacity: async () => ({
      totalBytes: 61_075_263_488,
      freeBytes: 45_604_417_536,
      usedBytes: 61_075_263_488 - 45_604_417_536,
    }),
  })

  assert.equal(disk.available, true)
  assert.equal(disk.scope, 'datalake')
  assert.equal(disk.totalBytes, 61_075_263_488)
  assert.equal(disk.freeBytes, 45_604_417_536)
  assert.equal(disk.usedBytes, 61_075_263_488 - 45_604_417_536)
  // percent is derived from the same used/total the Dashboard KPI already uses.
  assert.equal(disk.percent, ((61_075_263_488 - 45_604_417_536) / 61_075_263_488) * 100)
  assert.ok(disk.percent > 0 && disk.percent < 100)
})

test('an unreadable Data Lake is truthfully unavailable and carries no numbers', async () => {
  const disk = await dataLakeTelemetry({ capacity: async () => null })
  assert.equal(disk.available, false)
  assert.equal(disk.reason, 'capacity-unreadable')
  for (const key of ['totalBytes', 'usedBytes', 'freeBytes', 'percent']) {
    assert.equal(disk[key], undefined, `${key} must be absent, not 0`)
  }
})

test('a capacity read that throws does not propagate into the request', async () => {
  const disk = await dataLakeTelemetry({ capacity: async () => { throw new Error('boom') } })
  assert.equal(disk.available, false)
  assert.equal(disk.reason, 'capacity-unreadable')
})

test('physical drive health stays explicitly unobservable', async () => {
  // smartctl needs raw device access and CAP_SYS_RAWIO. Drive has neither, and
  // this task does not add them, so no claim about the physical disk is made.
  for (const disk of [
    await dataLakeTelemetry({ capacity: async () => ({ totalBytes: 10, freeBytes: 4, usedBytes: 6 }) }),
    await dataLakeTelemetry({ capacity: async () => null }),
  ]) {
    assert.deepEqual(disk.health, { available: false, reason: 'smart-not-observable' })
  }
})
