// tests/vaultVideoPreview.test.js — AEGIS Drive (IDEA1) · PR #157 Task 7.4 · video poster/hover/range preview (VP-*)
//
//   VP-1  videoPreviewCapability: V2+SW = RANGE_V2; V1 = V1_DOWNLOAD_ONLY (bounded fallback);
//         unsupported MIME = UNSUPPORTED
//   VP-2  openVideoPoster: session เปิดครั้งเดียว, <video muted preload=metadata>, seek เฟรมแรก,
//         วาดโปสเตอร์หนึ่งใบ, ปิด session หลังโปสเตอร์ (worker cache = เพดานเดิม ไม่มีของใหม่)
//   VP-3  hover motion: session ค้าง; leave → ปิด session + ลบ element
//   VP-4  seek ใด ๆ → Range ที่ map เฉพาะ chunk ที่ต้องใช้ (ตัวช่วย planChunkReads เดิม)
//   VP-5  worker รายงาน PREVIEW_FAILURE → ความผิดพลาดจริง + session ปิด
//   VP-6  ล็อก/unmount/นำทาง → ปิดทุก session + revoke ทุก URL (unlockedState)
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  videoPreviewCapability, chunkReadsForSeek, openVideoPoster, openVideoMotion, VIDEO_CAPABILITY,
} from '../src/lib/vaultVideoPreview.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'

const supportsLarge = () => true

test('VP-1 the capability maps V2+SW to the range session and V1 to the truthful bounded fallback', () => {
  assert.equal(videoPreviewCapability({ variant: 2, mediaType: 'video/mp4', supportsLarge: true }).capability, VIDEO_CAPABILITY.RANGE_V2)
  const v1 = videoPreviewCapability({ variant: 1, mediaType: 'video/webm', plainSize: 1024, maxPreviewBytes: 64 * 1024 * 1024 })
  assert.equal(v1.capability, VIDEO_CAPABILITY.V1_DOWNLOAD_ONLY)
  assert.equal(v1.fullPreviewAllowed, true, 'a small V1 file may still preview in full')
  const v1big = videoPreviewCapability({ variant: 1, mediaType: 'video/webm', plainSize: 1 << 30, maxPreviewBytes: 64 * 1024 * 1024 })
  assert.equal(v1big.fullPreviewAllowed, false, 'a huge V1 file is download-only')
  assert.equal(videoPreviewCapability({ variant: 2, mediaType: 'application/pdf' }).capability, VIDEO_CAPABILITY.UNSUPPORTED)
})

test('VP-2 the poster opens exactly one session, renders muted+metadata, seeks, draws once, and closes the session', async () => {
  let opened = 0
  let closed = 0
  const attached = []
  let drawn = 0
  const res = await openVideoPoster({
    variant: 2, plainSize: 1 << 20, mediaType: 'video/mp4', supportsLarge: true,
    openSession: async () => { opened += 1; return { token: 'T1', url: 'virtual://T1' } },
    closeSession: async () => { closed += 1 },
    attachVideo: async ({ url, muted, preload }) => {
      attached.push({ url, muted, preload })
      return { element: {}, seekTo: async (t) => { attached.at(-1).seekTo = t }, cleanup: () => { attached.at(-1).cleaned = true } }
    },
    drawFrame: () => { drawn += 1; return new Uint8Array([1, 2, 3]) },
  })
  assert.equal(res.ok, true)
  assert.equal(opened, 1, 'one preview session for the poster')
  assert.equal(closed, 1, 'the session closed after the poster')
  assert.equal(attached[0].muted, true, 'the poster video is muted')
  assert.equal(attached[0].preload, 'metadata', 'preload stays at metadata (no whole-file buffering)')
  assert.equal(attached[0].seekTo, 0, 'the poster seeks to the first frame')
  assert.equal(drawn, 1, 'exactly one frame drawn')
  assert.equal(attached[0].cleaned, true, 'the video element was cleaned up')
})

test('VP-2b the scheduler can request poster bytes without creating a second object URL', async () => {
  let created = 0
  const res = await openVideoPoster({
    variant: 2, plainSize: 1 << 20, mediaType: 'video/mp4', supportsLarge: true,
    openSession: async () => ({ token: 'T-bytes', url: 'virtual://T-bytes' }),
    closeSession: async () => {},
    attachVideo: async () => ({ element: {}, seekTo: async () => {}, cleanup: () => {} }),
    drawFrame: async () => new Uint8Array([4, 5, 6]),
    createObjectUrl: () => { created += 1; return 'blob:unexpected' },
    returnBytes: true,
  })
  assert.equal(res.ok, true)
  assert.deepEqual(res.posterBytes, new Uint8Array([4, 5, 6]))
  assert.equal(created, 0)
})

test('VP-3 hover motion keeps its session open; release closes it and removes the element', async () => {
  let closed = 0
  let cleaned = false
  const res = await openVideoMotion({
    variant: 2, mediaType: 'video/mp4',
    openSession: async () => ({ token: 'T2', url: 'virtual://T2' }),
    closeSession: async () => { closed += 1 },
    attachVideo: async () => ({ element: { tag: 'video' }, cleanup: () => { cleaned = true }, seekTo: async () => {} }),
  })
  assert.equal(res.ok, true)
  assert.equal(closed, 0, 'the motion session stays open while hovering')
  await res.release()
  assert.equal(closed, 1, 'release closes the session')
  assert.equal(cleaned, true, 'release removes the element')
})

test('VP-3b a failed motion attachment still closes the opened preview session', async () => {
  let closed = 0
  const res = await openVideoMotion({
    variant: 2, mediaType: 'video/mp4',
    openSession: async () => ({ token: 'T-motion-failed', url: 'virtual://T-motion-failed' }),
    closeSession: async () => { closed += 1 },
    attachVideo: async () => { throw new Error('PREVIEW_FAILURE: attach') },
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'INTEGRITY')
  assert.equal(closed, 1, 'the failed motion session cannot survive off-screen')
})

test('VP-4 any seek maps to exactly the chunks that cover it (one-chunk-bounded re-assert)', () => {
  const plaintextChunkSize = 1024
  const totalBytes = 10 * plaintextChunkSize
  for (const position of [0, 512, 1023, 1024, 4096, totalBytes - 1]) {
    const reads = chunkReadsForSeek({ position, totalBytes, plaintextChunkSize })
    assert.equal(reads.length, 1, `seek at ${position} reads exactly one chunk`)
    const plan = reads[0]
    const coverStart = plan.index * plaintextChunkSize
    assert.ok(coverStart <= position && position < coverStart + plaintextChunkSize, `the chunk at ${position} covers the byte`)
  }
})

test('VP-5 an integrity failure surfaces truthfully and closes the session', async () => {
  let closed = 0
  const res = await openVideoPoster({
    variant: 2, plainSize: 1 << 20, mediaType: 'video/mp4', supportsLarge: true,
    openSession: async () => ({ token: 'T3', url: 'virtual://T3' }),
    closeSession: async () => { closed += 1 },
    attachVideo: async () => { throw new Error('PREVIEW_FAILURE: integrity') },
    drawFrame: () => new Uint8Array(1),
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'INTEGRITY')
  assert.equal(closed, 1, 'the failed poster session was still closed')
})

test('VP-6 lock revokes the poster URL through the unlocked-state registration', async () => {
  const revoked = []
  const us = createUnlockedVaultState({ revokeObjectUrl: (u) => revoked.push(u) })
  const res = await openVideoPoster({
    variant: 2, plainSize: 1 << 20, mediaType: 'video/mp4', supportsLarge: true,
    openSession: async () => ({ token: 'T4', url: 'virtual://T4' }),
    closeSession: async () => {},
    attachVideo: async () => ({ element: {}, seekTo: async () => {}, cleanup: () => {} }),
    drawFrame: () => new Uint8Array([9]),
    registerObjectUrl: (u) => us.registerObjectUrl(u),
  })
  assert.equal(res.ok, true)
  await us.purge('MANUAL_LOCK')
  assert.deepEqual(revoked, [res.url], 'the lock revoked the poster URL')
})
