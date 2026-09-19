// server/media/runtime.js — AEGIS Drive (IDEA1) · ประกอบ media subsystem ของ Production จากโมดูลที่ทดสอบแล้ว
//
// ⚠️ ที่เดียวที่เดินสายของจริงเข้าด้วยกัน (spec §10.4): limits → runner → (MEDIA_ENABLED ? detectCapabilities : ไม่
//    spawn อะไรเลย) → sharp (ตั้ง concurrency(1) "ครั้งเดียว" ที่นี่) → mountState → cache/queue/evictor/service จริง →
//    service.init() — index.js เรียก createApp({ mediaService }) แล้ว listen แล้ว service.start()
// ⚠️ ไม่มี service "ตัวแทน" ที่รอถูกอัปเกรด: ปิด (MEDIA_ENABLED=false) หรือเครื่องมือหาย = disabledMediaService พร้อม
//    reason ที่ตรวจสอบได้ (MEDIA_DISABLED / TOOLS_MISSING) และ Drive บูตต่อได้เสมอ

import fsp from 'node:fs/promises'
import { mediaLimitsFromEnv } from '../config/mediaLimits.js'
import { detectCapabilities, CAPABILITIES_NONE } from './capabilities.js'
import { createProcessRunner } from './processRunner.js'
import { createMediaCache } from './cache.js'
import { createJobQueue } from './queue.js'
import { createEvictor } from './eviction.js'
import { createDerivativeService } from './derivatives.js'
import { disabledMediaService } from './disabledService.js'
import { detectMountState } from './mountInfo.js'

const defaultStatfs = async (dir) => {
  const st = await fsp.statfs(dir)
  return { bavail: Number(st.bavail), bsize: Number(st.bsize) }
}

/**
 * ประกอบ service จริง (cache/queue/evictor จริง) — ใช้ทั้งใน bootMedia และชุดทดสอบที่ inject generator ปลอม
 * @param {{ limits: object, capabilities: object, runner: object, resolveStorageKey: Function, keyExists: Function,
 *           storageRoot: string, sharp?: Function|null, log?: Function, now?: () => number, statfs?: Function,
 *           mountState?: string, generators?: object, onAudit?: Function }} o
 */
export function createMediaRuntime({
  limits, capabilities, runner, resolveStorageKey, keyExists, storageRoot, sharp = null,
  log = console.log, now = Date.now, statfs = defaultStatfs, mountState = 'unknown', generators = {}, onAudit = () => {},
}) {
  const cache = createMediaCache({ root: limits.cacheDir, profile: limits.profile, storageRoot, now })
  const cacheForProfile = (profile) => createMediaCache({ root: limits.cacheDir, profile, storageRoot, now })
  const queue = createJobQueue({ concurrency: limits.workers, maxDepth: limits.queueMax, now })
  let service = null
  const evictor = createEvictor({ cache, cacheForProfile, limits, now, log, isPinned: (sha) => (service ? service.isPinned(sha) : false) })
  service = createDerivativeService({
    limits, capabilities, cache, queue, evictor, runner, resolveStorageKey, keyExists, sharp, now, log, statfs, mountState, generators, onAudit,
  })
  return service
}

/**
 * ลำดับบูตตามสัญญา — คืน { limits, capabilities, service, queue, trace, started:false }
 * @param {{ env?: object, limits?: object, runner?: object, detect?: Function, resolveStorageKey: Function, keyExists: Function,
 *           storageRoot: string, loadSharp?: () => Promise<any>, log?: Function, mountInfoPath?: string, now?: () => number,
 *           statfs?: Function, generators?: object, onAudit?: Function }} o
 */
export async function bootMedia({
  env = process.env, limits = mediaLimitsFromEnv(env), runner = createProcessRunner(), detect = detectCapabilities,
  resolveStorageKey, keyExists, storageRoot, loadSharp = () => import('sharp').then((m) => m.default ?? m),
  log = console.log, mountInfoPath = '/proc/self/mountinfo', now = Date.now, statfs = defaultStatfs, generators = {}, onAudit = () => {},
}) {
  const trace = ['limits', 'runner']
  if (!limits.enabled) {
    trace.push('disabled')
    return { limits, capabilities: CAPABILITIES_NONE, service: disabledMediaService(limits, 'MEDIA_DISABLED'), queue: null, trace, started: false }
  }
  const capabilities = await detect({ runner, loadSharp })
  trace.push('detect')
  if (!capabilities.enabled) {
    log(`[media] toolchain unavailable — media derivatives disabled (${capabilities.reasons.join(', ')})`)
    trace.push('disabled')
    return { limits, capabilities, service: disabledMediaService(limits, 'TOOLS_MISSING'), queue: null, trace, started: false }
  }
  let sharp = null
  if (capabilities.sharp.ok) {
    try {
      sharp = await loadSharp()
      // ⚠️ ตั้ง thread pool ของ libvips ครั้งเดียวที่นี่ — ไม่ใช่ต่อคำขอ poster (spec §13.2)
      if (typeof sharp?.concurrency === 'function') sharp.concurrency(1)
      trace.push('sharp')
    } catch (err) {
      log(`[media] sharp failed to load at runtime assembly: ${err?.message ?? err} — still images fall back to ffmpeg`)
      sharp = null
      trace.push('sharp-unavailable')
    }
  } else {
    trace.push('sharp-unavailable')
  }
  const mountState = await detectMountState({ target: limits.cacheDir, mountInfoPath })
  trace.push('mount')
  const service = createMediaRuntime({ limits, capabilities, runner, resolveStorageKey, keyExists, storageRoot, sharp, log, now, statfs, mountState, generators, onAudit })
  trace.push('runtime')
  await service.init()
  trace.push('init')
  return { limits, capabilities, service, queue: service.queue ?? undefined, trace, started: false }
}
