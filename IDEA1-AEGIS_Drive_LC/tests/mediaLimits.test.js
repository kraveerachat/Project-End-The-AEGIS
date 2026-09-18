// tests/mediaLimits.test.js — AEGIS Drive (IDEA1) · MEDIA_* configuration contract (media preview pipeline, Task 1)
//
// ⚠️ ชุดนี้ตรึง "ความจริงของการตั้งค่า" ของท่อ derivative: ค่าเริ่มต้นทุกตัวตายตัว, ค่าที่ผิด
//    ต้องทำให้บูตไม่ขึ้น (ไม่ใช่ clamp เงียบ ๆ), และผลลัพธ์ต้องแช่แข็งลึกจนแก้ไม่ได้ระหว่างรัน
//    ไม่มีการบูตแอป ไม่มี FFmpeg ไม่มี Sharp — เป็นการอ่าน env ล้วน ๆ (spec §18, plan Task 1)
import test from 'node:test'
import assert from 'node:assert/strict'

import { mediaLimitsFromEnv, MEDIA_DEFAULTS, MEDIA_PROFILE_VERSION } from '../server/config/mediaLimits.js'

const MIB = 1_048_576
const GIB = 1_073_741_824

test('ML-1 defaults: mediaLimitsFromEnv({}) equals MEDIA_DEFAULTS, is frozen, profile v1, enabled', () => {
  const limits = mediaLimitsFromEnv({})
  assert.deepEqual(limits, MEDIA_DEFAULTS)
  assert.equal(Object.isFrozen(limits), true)
  assert.equal(Object.isFrozen(MEDIA_DEFAULTS), true)
  assert.equal(limits.profile, 'v1')
  assert.equal(MEDIA_PROFILE_VERSION, 'v1')
  assert.equal(limits.enabled, true)
})

test('ML-2 MEDIA_ENABLED=false → enabled false, every other field still validated', () => {
  const limits = mediaLimitsFromEnv({ MEDIA_ENABLED: 'false' })
  assert.equal(limits.enabled, false)
  assert.equal(limits.workers, MEDIA_DEFAULTS.workers)
  assert.equal(limits.cacheDir, MEDIA_DEFAULTS.cacheDir)
  // disabled does not turn off validation of the rest
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_ENABLED: 'false', MEDIA_WORKERS: '9' }), /MEDIA_WORKERS/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_ENABLED: 'maybe' }), /MEDIA_ENABLED/)
})

test('ML-3 MEDIA_WORKERS: 1 and 2 accepted; 3, 0 and non-numeric refused', () => {
  assert.equal(mediaLimitsFromEnv({ MEDIA_WORKERS: '1' }).workers, 1)
  assert.equal(mediaLimitsFromEnv({ MEDIA_WORKERS: '2' }).workers, 2)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_WORKERS: '3' }), /MEDIA_WORKERS must be between 1 and 2/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_WORKERS: '0' }), /MEDIA_WORKERS/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_WORKERS: 'x' }), /MEDIA_WORKERS/)
})

test('ML-4 pixel guards: source pixels 1e6..4e8 with default 40e6; video frame default 35,389,440', () => {
  assert.equal(mediaLimitsFromEnv({}).maxSourcePixels, 40_000_000)
  assert.equal(mediaLimitsFromEnv({}).maxVideoFramePixels, 35_389_440)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_MAX_SOURCE_PIXELS: '999999' }), /MEDIA_MAX_SOURCE_PIXELS/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_MAX_SOURCE_PIXELS: '400000001' }), /MEDIA_MAX_SOURCE_PIXELS/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_MAX_SOURCE_PIXELS: '1000000' }).maxSourcePixels, 1_000_000)
  assert.equal(mediaLimitsFromEnv({ MEDIA_MAX_VIDEO_FRAME_PIXELS: '8294400' }).maxVideoFramePixels, 8_294_400)
})

test('ML-5 cache limits: max bytes default 2 GiB (min 64 MiB); low water 0.8 in (0,1); free reserve 512 MiB', () => {
  const limits = mediaLimitsFromEnv({})
  assert.equal(limits.cacheMaxBytes, 2_147_483_648)
  assert.equal(limits.cacheMaxBytes, 2 * GIB)
  assert.equal(limits.cacheLowWater, 0.8)
  assert.equal(limits.cacheFreeReserveBytes, 536_870_912)
  assert.equal(limits.cacheFreeReserveBytes, 512 * MIB)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_CACHE_MAX_BYTES: String(64 * MIB - 1) }), /MEDIA_CACHE_MAX_BYTES/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_CACHE_MAX_BYTES: String(64 * MIB) }).cacheMaxBytes, 64 * MIB)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_CACHE_LOW_WATER: '0' }), /MEDIA_CACHE_LOW_WATER/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_CACHE_LOW_WATER: '1' }), /MEDIA_CACHE_LOW_WATER/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_CACHE_LOW_WATER: '0.5' }).cacheLowWater, 0.5)
  assert.equal(mediaLimitsFromEnv({ MEDIA_CACHE_FREE_RESERVE_BYTES: '1048576' }).cacheFreeReserveBytes, MIB)
})

test('ML-6 MEDIA_CACHE_POLICY: default immutable; revalidate accepted; anything else refused', () => {
  assert.equal(mediaLimitsFromEnv({}).cachePolicy, 'immutable')
  assert.equal(mediaLimitsFromEnv({ MEDIA_CACHE_POLICY: 'revalidate' }).cachePolicy, 'revalidate')
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_CACHE_POLICY: 'public' }), /immutable|revalidate/)
})

test('ML-7 MEDIA_STILL_ENGINE: default sharp; ffmpeg accepted; magick refused', () => {
  assert.equal(mediaLimitsFromEnv({}).stillEngine, 'sharp')
  assert.equal(mediaLimitsFromEnv({ MEDIA_STILL_ENGINE: 'ffmpeg' }).stillEngine, 'ffmpeg')
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_STILL_ENGINE: 'magick' }), /MEDIA_STILL_ENGINE/)
})

test('ML-8 boxes and motion: 640x360 poster, 480x270 motion, 12 fps (1..30), 6 s (1..15), probesize 32 MiB, output caps', () => {
  const limits = mediaLimitsFromEnv({})
  assert.deepEqual(limits.posterBox, { width: 640, height: 360 })
  assert.deepEqual(limits.motionBox, { width: 480, height: 270 })
  assert.equal(limits.motionFps, 12)
  assert.equal(limits.motionMaxSeconds, 6)
  assert.equal(limits.probesizeBytes, 32 * MIB)
  assert.equal(limits.posterMaxBytes, 512 * 1024)
  assert.equal(limits.motionMaxBytes, 4 * MIB)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_MOTION_FPS: '0' }), /MEDIA_MOTION_FPS/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_MOTION_FPS: '31' }), /MEDIA_MOTION_FPS/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_MOTION_FPS: '30' }).motionFps, 30)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_MOTION_MAX_SECONDS: '0' }), /MEDIA_MOTION_MAX_SECONDS/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_MOTION_MAX_SECONDS: '16' }), /MEDIA_MOTION_MAX_SECONDS/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_MOTION_MAX_SECONDS: '15' }).motionMaxSeconds, 15)
})

test('ML-9 timeouts: probe 20000 / poster 60000 / motion 120000; each within 1000..600000', () => {
  const limits = mediaLimitsFromEnv({})
  assert.equal(limits.probeTimeoutMs, 20_000)
  assert.equal(limits.posterTimeoutMs, 60_000)
  assert.equal(limits.motionTimeoutMs, 120_000)
  for (const name of ['MEDIA_PROBE_TIMEOUT_MS', 'MEDIA_POSTER_TIMEOUT_MS', 'MEDIA_MOTION_TIMEOUT_MS']) {
    assert.throws(() => mediaLimitsFromEnv({ [name]: '999' }), new RegExp(name))
    assert.throws(() => mediaLimitsFromEnv({ [name]: '600001' }), new RegExp(name))
    assert.doesNotThrow(() => mediaLimitsFromEnv({ [name]: '1000' }))
    assert.doesNotThrow(() => mediaLimitsFromEnv({ [name]: '600000' }))
  }
})

test('ML-10 threads 1/1/2 (1..8), queueMax 500 (1..10000), batchMaxIds fixed 64', () => {
  const limits = mediaLimitsFromEnv({})
  assert.equal(limits.decoderThreads, 1)
  assert.equal(limits.filterThreads, 1)
  assert.equal(limits.encoderThreads, 2)
  assert.equal(limits.queueMax, 500)
  assert.equal(limits.batchMaxIds, 64)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_FFMPEG_ENCODER_THREADS: '9' }), /MEDIA_FFMPEG_ENCODER_THREADS/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_FFMPEG_DECODER_THREADS: '0' }), /MEDIA_FFMPEG_DECODER_THREADS/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_FFMPEG_FILTER_THREADS: '9' }), /MEDIA_FFMPEG_FILTER_THREADS/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_FFMPEG_ENCODER_THREADS: '8' }).encoderThreads, 8)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_QUEUE_MAX: '0' }), /MEDIA_QUEUE_MAX/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_QUEUE_MAX: '10001' }), /MEDIA_QUEUE_MAX/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_QUEUE_MAX: '10000' }).queueMax, 10_000)
  // batchMaxIds is a wire contract, not an operator knob
  assert.equal(mediaLimitsFromEnv({ MEDIA_BATCH_MAX_IDS: '10' }).batchMaxIds, 64)
})

test('ML-11 cacheDir: default /var/cache/aegis-media; must be absolute; trailing slash normalised', () => {
  assert.equal(mediaLimitsFromEnv({}).cacheDir, '/var/cache/aegis-media')
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_CACHE_DIR: 'relative/cache' }), /MEDIA_CACHE_DIR/)
  assert.throws(() => mediaLimitsFromEnv({ MEDIA_CACHE_DIR: '' }), /MEDIA_CACHE_DIR/)
  assert.equal(mediaLimitsFromEnv({ MEDIA_CACHE_DIR: '/srv/media-cache/' }).cacheDir, '/srv/media-cache')
  assert.equal(mediaLimitsFromEnv({ MEDIA_CACHE_DIR: '/srv/media-cache' }).cacheDir, '/srv/media-cache')
})

test('ML-12 the limits object is deep-frozen (nested boxes cannot be mutated)', () => {
  const limits = mediaLimitsFromEnv({ MEDIA_WORKERS: '2' })
  assert.equal(Object.isFrozen(limits.posterBox), true)
  assert.equal(Object.isFrozen(limits.motionBox), true)
  assert.throws(() => { 'use strict'; limits.posterBox.width = 1 }, TypeError)
  assert.throws(() => { 'use strict'; limits.workers = 9 }, TypeError)
  assert.equal(limits.posterBox.width, 640)
  assert.equal(limits.workers, 2)
})
