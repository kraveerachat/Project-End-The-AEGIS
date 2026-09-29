// tests/vaultGifPreview.test.js — AEGIS Drive (IDEA1) · PR #157 Task 7.3 · GIF poster + bounded hover/touch (GF-*)
//
//   GF-1            โปสเตอร์นิ่ง = decode เฟรมแรกใต้ gifPosterDecodeBudget; เกินงบ → โปสเตอร์ไม่ได้ + จอโชว์เหตุผลจริง
//   GF-LIMIT-PLAY   plainSize > gifMaxFullPlayBytes → openGifMotion → unsupported 'GIF_TOO_LARGE';
//                   จอโชว์โปสเตอร์ + "ดาวน์โหลดไปดูแอนิเมชัน"; ไม่มีการถอดทั้งไฟล์เพื่อ hover (fetch spy = 0)
//   GF-2            ใต้ขีดจำกัด: hover/กดค้าง → ถอดทั้ง GIF → URL → <img> สลับ; ปล่อย → revoke ในหนึ่ง tick
//   GF-3            เพดานหน่วยความจำของ scheduler ถึงแล้ว → ปฏิเสธ motion ด้วย MEMORY_CEILING แม้ไฟล์จะเล็ก
//   GF-4            ล็อกขณะเล่น → URL revoke + img src ถูกล้าง
import test from 'node:test'
import assert from 'node:assert/strict'

import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { gifMotionCapability, openGifMotion } from '../src/lib/vaultGifPreview.js'
import { syntheticGif } from './helpers/vaultTreeFixtures.mjs'

const limits = treeLimitsFrom({ gifMaxFullPlayBytes: 1000, imageMaxInputBytes: 2000, imageMaxDecodedPixels: 100_000, posterMaxEdge: 64 })

test('GF-1 the static poster is a first-frame decode within the poster budget; over budget → truthful refusal', async () => {
  // โปสเตอร์ GIF = พรีวิวภาพของไบต์ GIF (Task 7.2 module) — เกิน imageMaxInputBytes = ปฏิเสธ
  const { makeImageThumb } = await import('../src/lib/vaultImageThumb.js')
  const res = await makeImageThumb({
    plainSize: limits.imageMaxInputBytes + 1,
    limits,
    readWhole: async () => syntheticGif({ width: 32, height: 32 }),
    decode: async () => ({ width: 32, height: 32, close: () => {} }),
    poster: () => ({ bytes: new Uint8Array(8), width: 32, height: 32 }),
    variant: 1,
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'IMAGE_TOO_LARGE', 'over the poster budget the tile falls back to the icon with the truthful reason')
})

test('GF-LIMIT-PLAY an oversized GIF refuses motion before a single byte is fetched', async () => {
  let fetches = 0
  const cap = gifMotionCapability({ plainSize: limits.gifMaxFullPlayBytes + 1, limits, schedulerMemBytes: 0 })
  assert.deepEqual(cap, { ok: false, unsupported: 'GIF_TOO_LARGE' })
  const res = await openGifMotion({
    plainSize: limits.gifMaxFullPlayBytes + 1,
    limits,
    readWhole: async () => { fetches += 1; return syntheticGif() },
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'GIF_TOO_LARGE')
  assert.equal(fetches, 0, 'no whole-file buffering happens for hover')
})

test('GF-2 under the limit: motion decrypts whole and produces a URL; the capability gate passes', async () => {
  const created = []
  const res = await openGifMotion({
    plainSize: 500,
    limits,
    readWhole: async () => syntheticGif({ width: 40, height: 40 }),
    createObjectUrl: (b) => { const u = `blob:mock/${created.length}`; created.push(u); return u },
  })
  assert.equal(res.ok, true)
  assert.deepEqual(created, [res.url], 'exactly one motion URL was created')
  assert.equal(gifMotionCapability({ plainSize: 500, limits, schedulerMemBytes: 0 }).ok, true)
})

test('GF-3 a reached scheduler memory ceiling refuses motion even under the byte limit', async () => {
  const res = await openGifMotion({
    plainSize: 500,
    limits,
    schedulerMemBytes: limits.memoryCeilingBytes,
    readWhole: async () => syntheticGif(),
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'MEMORY_CEILING')
})

test('GF-4 lock during playback revokes the URL through the unlocked-state registration', async () => {
  const revoked = []
  const { createUnlockedVaultState } = await import('../src/lib/vaultUnlockedState.js')
  const us = createUnlockedVaultState({ revokeObjectUrl: (u) => revoked.push(u) })
  const res = await openGifMotion({
    plainSize: 500,
    limits,
    readWhole: async () => syntheticGif({ width: 40, height: 40 }),
    unlockedState: us,
  })
  assert.equal(res.ok, true)
  await us.purge('MANUAL_LOCK')
  assert.deepEqual(revoked, [res.url], 'the lock revoked the motion URL')
})
