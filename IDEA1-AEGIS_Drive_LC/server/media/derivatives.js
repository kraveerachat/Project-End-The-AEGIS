// server/media/derivatives.js — AEGIS Drive (IDEA1) · media derivative service (state machine + orchestration)
//
// ⚠️ ขอบเขต (spec §12–§14, §17, §19, §22): โมดูลนี้รู้จัก "แถวไฟล์" ที่ถูกส่งเข้ามา (ไม่แตะ DB เอง), ตัดสินตัวตน
//    derivative = files.sha256 + profile + ชนิด, ประกอบงาน probe → poster → motion ผ่านคิวที่ dedup, บันทึกสถานะลง
//    cache (สร้างใหม่ได้เสมอ), และคืนคำอธิบายให้ route เสิร์ฟ — ไม่มี HTTP ที่นี่
// ⚠️ ความปลอดภัย: vault/โฟลเดอร์ = NOT_FOUND และไม่มีวันถึง probe; ต้นฉบับผ่าน resolveStorageKey/keyExists ที่ inject
//    เท่านั้น (ไม่ import storage/fileStore, ไม่ import route); allowlist จาก config/previewMedia.js
// ⚠️ retry (spec §13.5): MAX_TRANSIENT_RETRIES=3, MAX_TOTAL_ATTEMPTS=4, backoff 1→5→30 นาที; PERMANENT ไม่วนซ้ำ
//    จนกว่าจะ invalidate/evict/bump profile; ไม่มี attempt ก่อน nextRetryAt

import fsp from 'node:fs/promises'
import path from 'node:path'
import { PRIORITY, QueueFullError } from './queue.js'
import { MediaJobError } from './poster.js'
import { probeMedia } from './probe.js'
import { generatePoster } from './poster.js'
import { generateMotion } from './motion.js'
import { previewExtForName, isPreviewableExtension } from '../config/previewMedia.js'

export const MEDIA_STATE = Object.freeze({ PENDING: 'PENDING', READY: 'READY', UNSUPPORTED: 'UNSUPPORTED', GENERATION_FAILED: 'GENERATION_FAILED', RETRYABLE: 'RETRYABLE' })
export const MAX_TRANSIENT_RETRIES = 3
export const MAX_TOTAL_ATTEMPTS = 4
export const RETRY_BACKOFF_MS = Object.freeze([60_000, 300_000, 1_800_000])
const EVICTION_INTERVAL_MS = 600_000
const DISK_RETRY_MS = 60_000
const QUEUE_FULL_RETRY_MS = 15_000
const TYPES = Object.freeze(['poster', 'motion'])

const freshSub = () => ({ state: MEDIA_STATE.PENDING, attempts: 0, nextRetryAt: null, reason: null })
const hidden = (row) => !row || row.vault === true || row.kind === 'folder'

/**
 * @param {{ limits: object, capabilities: object, cache: object, queue: object, evictor: object, runner: object,
 *           resolveStorageKey: (key: string) => string|null, keyExists: (key: string) => Promise<boolean>,
 *           sharp?: Function|null, now?: () => number, log?: Function, statfs?: (dir: string) => Promise<{ bavail: number, bsize: number }>,
 *           mountState?: 'volume'|'ephemeral'|'unknown', generators?: { probe?: Function, poster?: Function, motion?: Function },
 *           onAudit?: (event: object) => void, ffmpegBin?: string, ffprobeBin?: string }} o
 */
export function createDerivativeService({
  limits, capabilities, cache, queue, evictor, runner, resolveStorageKey, keyExists, sharp = null,
  now = Date.now, log = () => {}, statfs = null, mountState = 'unknown', generators = {}, onAudit = () => {}, ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe',
}) {
  if (typeof resolveStorageKey !== 'function' || typeof keyExists !== 'function') throw new TypeError('resolveStorageKey and keyExists must be injected')
  const gen = { probe: generators.probe ?? probeMedia, poster: generators.poster ?? generatePoster, motion: generators.motion ?? generateMotion }
  const profile = limits.profile
  const isValidSha256 = (v) => cache.isValidSha256(v)
  const inflight = new Set()
  const failures = [] // { at, sha, type, reason }
  let cacheWritable = false
  let started = false
  let stopEviction = null
  const key = (sha, type) => `${profile}/${sha}/${type}`

  /* ── state persistence ────────────────────────────────────────────────── */
  async function loadState(sha) {
    const st = await cache.readState(sha)
    if (st && st.profile === profile) return { ...st, poster: { ...freshSub(), ...(st.poster ?? {}) }, motion: { ...freshSub(), ...(st.motion ?? {}) } }
    return { profile, sha256: sha, poster: freshSub(), motion: freshSub(), lastAccess: new Date(now()).toISOString() }
  }
  async function saveSub(sha, type, patch) {
    const st = await loadState(sha)
    st[type] = { ...st[type], ...patch }
    await cache.writeState(sha, st)
    return st
  }

  /* ── gates shared by info/ensure/serve ────────────────────────────────── */
  function classify(row) {
    if (hidden(row)) return { kind: 'hidden' }
    const ext = previewExtForName(row.name)
    if (!ext || !isPreviewableExtension(ext)) return { kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' }
    if (!isValidSha256(row.sha256)) return { kind: 'unsupported', reason: 'NO_CONTENT_IDENTITY' }
    return { kind: 'ok', ext, sha: row.sha256 }
  }
  async function sourceAbs(row) {
    const abs = typeof row.path === 'string' && row.path ? resolveStorageKey(row.path) : null
    if (!abs) return null
    return (await keyExists(row.path)) ? abs : null
  }
  async function diskReserveOk() {
    if (!statfs) return true
    try {
      const st = await statfs(cache.root)
      return Number(st.bavail) * Number(st.bsize) >= limits.cacheFreeReserveBytes
    } catch {
      return true // ไม่รู้ = ไม่ปฏิเสธ (การเขียนล้มเหลวจริงจะเป็น DISK ของงานเอง)
    }
  }

  /* ── jobs ─────────────────────────────────────────────────────────────── */
  async function ensureProbe(sha, abs, ext) {
    const cached = await cache.readProbe(sha)
    if (cached && cached.probeVersion) return cached
    const result = await gen.probe({ absPath: abs, ext, limits, capabilities, runner, metadataProvider: sharp ? { metadataFor: (p) => sharp(p).metadata() } : null, ffprobeBin })
    await cache.writeProbe(sha, result)
    if (result.unsupported) {
      const st = await loadState(sha)
      st.poster = { ...st.poster, state: MEDIA_STATE.UNSUPPORTED, reason: result.reason }
      st.motion = { ...st.motion, state: MEDIA_STATE.UNSUPPORTED, reason: result.reason }
      await cache.writeState(sha, st)
    }
    return result
  }

  function recordFailure(sub, err, sha, type) {
    const attempts = (sub.attempts ?? 0) + 1
    const cls = err instanceof MediaJobError ? err.class : 'TRANSIENT'
    const reason = err instanceof MediaJobError ? err.reason : 'INTERNAL'
    failures.push({ at: now(), sha, type, reason })
    if (cls === 'PERMANENT' || attempts >= MAX_TOTAL_ATTEMPTS) {
      return { state: MEDIA_STATE.GENERATION_FAILED, attempts, reason, nextRetryAt: null, failedAt: new Date(now()).toISOString() }
    }
    const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]
    return { state: MEDIA_STATE.RETRYABLE, attempts, reason, nextRetryAt: new Date(now() + backoff).toISOString() }
  }

  async function runGeneration(sha, type, abs, probe) {
    const paths = cache.paths(sha)
    const generate = gen[type]
    let result = null
    let finalPath = null
    await cache.writeAtomic(type === 'motion' ? paths.motion : paths.poster('webp'), async (tmpPath) => {
      result = await generate({ absPath: abs, probe, tmpPath, limits, capabilities, runner, sharp, ffmpegBin })
      finalPath = type === 'motion' ? paths.motion : paths.poster(result.file.split('.').pop())
    })
    // PNG fallback ของ FFmpeg (ไม่มี libwebp): ผลถูก rename ไปที่ชื่อ webp ก่อน จึงย้ายไปชื่อจริงตามที่ generator รายงาน
    if (type === 'poster' && result.file !== 'poster.webp') await fsp.rename(paths.poster('webp'), finalPath)
    return result
  }

  function runJob(sha, type, row, abs, ext, priority) {
    const promise = (async () => {
      const probe = await ensureProbe(sha, abs, ext)
      if (probe.unsupported) return false
      if (type === 'motion' && probe.animated !== true) {
        await saveSub(sha, 'motion', { state: MEDIA_STATE.UNSUPPORTED, reason: probe.animated === false ? 'NOT_ANIMATED' : 'ANIMATION_UNKNOWN' })
        return false
      }
      const before = (await loadState(sha))[type]
      try {
        const result = await runGeneration(sha, type, abs, probe)
        await saveSub(sha, type, {
          state: MEDIA_STATE.READY, file: result.file, mime: result.mime, width: result.width, height: result.height, bytes: result.bytes,
          attempts: (before.attempts ?? 0) + 1, generatedAt: new Date(now()).toISOString(), reason: null, nextRetryAt: null, engine: result.engine,
          ...(type === 'motion' ? { fps: result.fps, seconds: result.seconds } : {}),
        })
        evictor.record(sha, (await entryBytes(sha)), now())
        evictor.runIfNeeded().catch((err) => log(`[media] eviction failed: ${err?.message ?? err}`))
        if (type === 'poster' && probe.animated === true) tryEnqueue(sha, 'motion', row, abs, ext, priority)
        return true
      } catch (err) {
        await saveSub(sha, type, recordFailure(before, err, sha, type))
        if (!(err instanceof MediaJobError)) log(`[media] ${type} job ${sha.slice(0, 12)} failed unexpectedly: ${err?.message ?? err}`)
        return false
      }
    })()
    return promise
  }

  async function entryBytes(sha) {
    let bytes = 0
    for (const type of TYPES) { const st = await cache.statDerivative(sha, type); if (st) bytes += st.bytes }
    return bytes
  }

  /** enqueue แบบ dedup โดยไม่รอให้งานจบ — คิวเต็มตรวจได้ทันทีเพราะ enqueue ไม่รับ key ใหม่ */
  function tryEnqueue(sha, type, row, abs, ext, priority) {
    const k = key(sha, type)
    if (queue.has(k)) { queue.promote(k, priority); return { enqueued: true, deduplicated: true } }
    const { promise } = queue.enqueue(k, priority, () => runJob(sha, type, row, abs, ext, priority))
    let full = false
    const tracked = promise.then(() => {}, (err) => { if (err instanceof QueueFullError) full = true })
    inflight.add(tracked); tracked.finally(() => inflight.delete(tracked))
    return queue.has(k) ? { enqueued: true, deduplicated: false } : { enqueued: false, reason: full || !queue.has(k) ? 'QUEUE_FULL' : 'ENQUEUE_FAILED' }
  }

  /** ตัดสินใจว่าต้อง enqueue หรือไม่ และคืน sub-state ที่รายงานได้ (ไม่รอให้งานจบ) */
  async function ensureType(row, gate, type, priority, { probe, state }) {
    const sha = gate.sha
    const sub = state[type]
    if (sub.state === MEDIA_STATE.READY && (await cache.statDerivative(sha, type))) return { ...sub, state: MEDIA_STATE.READY }
    if (sub.state === MEDIA_STATE.UNSUPPORTED) return sub
    if (sub.state === MEDIA_STATE.GENERATION_FAILED) return sub
    if (type === 'motion' && probe && !probe.unsupported && probe.animated !== true) {
      return { ...sub, state: MEDIA_STATE.UNSUPPORTED, reason: probe.animated === false ? 'NOT_ANIMATED' : 'ANIMATION_UNKNOWN' }
    }
    if (sub.state === MEDIA_STATE.RETRYABLE && sub.nextRetryAt && Date.parse(sub.nextRetryAt) > now()) {
      return { ...sub, retryAfterMs: Math.max(1000, Date.parse(sub.nextRetryAt) - now()) }
    }
    if (queue.has(key(sha, type))) return { ...sub, state: MEDIA_STATE.PENDING, retryAfterMs: pendingRetryMs() }
    if (type === 'motion' && !queue.has(key(sha, 'poster')) && (!probe || probe.unsupported)) return { ...sub, state: MEDIA_STATE.PENDING, retryAfterMs: pendingRetryMs() }
    const abs = await sourceAbs(row)
    if (!abs) return { ...sub, state: MEDIA_STATE.UNSUPPORTED, reason: 'SOURCE_MISSING' }
    if (!(await diskReserveOk())) return { ...sub, state: MEDIA_STATE.RETRYABLE, reason: 'DISK', retryAfterMs: DISK_RETRY_MS }
    const r = tryEnqueue(sha, type, row, abs, gate.ext, priority)
    if (!r.enqueued) return { ...sub, state: MEDIA_STATE.RETRYABLE, reason: r.reason, retryAfterMs: QUEUE_FULL_RETRY_MS }
    return { ...sub, state: MEDIA_STATE.PENDING, retryAfterMs: pendingRetryMs() }
  }
  const pendingRetryMs = () => Math.min(15_000, 1000 + 1000 * Math.min(14, queue.stats().depth))

  /* ── public: info / infoBatch ─────────────────────────────────────────── */
  async function info(row, priority = PRIORITY.INTERACTIVE) {
    const gate = classify(row)
    if (gate.kind === 'hidden') return { status: 'NOT_FOUND' }
    if (gate.kind === 'unsupported') return { status: 'UNSUPPORTED', reason: gate.reason }
    const sha = gate.sha
    const [state, probe] = await Promise.all([loadState(sha), cache.readProbe(sha)])
    if (probe && probe.unsupported) {
      return { id: String(row.id), sourceVersion: sha, profile, family: probe.family ?? null, animated: null, status: 'UNSUPPORTED', reason: probe.reason, poster: { state: 'UNSUPPORTED', reason: probe.reason, url: null }, motion: { state: 'UNSUPPORTED', reason: probe.reason, url: null } }
    }
    const poster = await ensureType(row, gate, 'poster', priority, { probe, state })
    const motion = await ensureType(row, gate, 'motion', priority, { probe, state })
    const view = (type, sub) => {
      const base = { state: sub.state, reason: sub.reason ?? null, url: null }
      if (sub.state === MEDIA_STATE.READY) {
        base.url = `/api/files/${encodeURIComponent(String(row.id))}/${type === 'poster' ? 'poster' : 'motion-preview'}?v=${sha}&p=${profile}`
        base.etag = `"${sha}-${profile}-${type}"`
        base.mime = sub.mime; base.width = sub.width ?? null; base.height = sub.height ?? null
        if (type === 'motion') { base.fps = sub.fps ?? null; base.seconds = sub.seconds ?? null }
      }
      if (sub.retryAfterMs) base.retryAfterMs = sub.retryAfterMs
      return base
    }
    const posterView = view('poster', poster), motionView = view('motion', motion)
    let status
    if (poster.state === MEDIA_STATE.UNSUPPORTED) status = 'UNSUPPORTED'
    else if (poster.state === MEDIA_STATE.GENERATION_FAILED) status = 'GENERATION_FAILED'
    else if (poster.state === MEDIA_STATE.RETRYABLE) status = 'RETRYABLE'
    else if (poster.state === MEDIA_STATE.PENDING) status = 'PENDING'
    else status = motion.state === MEDIA_STATE.READY || motion.state === MEDIA_STATE.UNSUPPORTED ? 'READY' : 'PARTIAL'
    const out = {
      id: String(row.id), sourceVersion: sha, profile,
      family: probe?.family ?? null, animated: probe ? (probe.animated ?? null) : null,
      width: probe?.width ?? null, height: probe?.height ?? null, durationSeconds: probe?.durationSeconds ?? null,
      poster: posterView, motion: motionView, status,
    }
    if (status === 'UNSUPPORTED') out.reason = poster.reason
    if (status === 'GENERATION_FAILED') out.reason = poster.reason
    if (status === 'RETRYABLE') { out.reason = poster.reason; out.retryAfterMs = poster.retryAfterMs }
    return out
  }
  async function infoBatch(rows, priority = PRIORITY.INTERACTIVE) {
    const map = new Map()
    for (const row of rows) map.set(String(row?.id), await info(row, priority))
    return map
  }

  /* ── public: ensure / scheduleForFile ─────────────────────────────────── */
  async function ensure(row, type, priority = PRIORITY.INTERACTIVE) {
    const gate = classify(row)
    if (gate.kind !== 'ok' || !TYPES.includes(type)) return false
    const state = await loadState(gate.sha)
    const probe = await cache.readProbe(gate.sha)
    const sub = await ensureType(row, gate, type, priority, { probe, state })
    return sub.state === MEDIA_STATE.PENDING || sub.state === MEDIA_STATE.READY
  }
  async function scheduleForFile(row, priority = PRIORITY.UPLOAD) {
    const gate = classify(row)
    if (gate.kind !== 'ok') return false
    const state = await loadState(gate.sha)
    const probe = await cache.readProbe(gate.sha)
    if (probe && probe.unsupported) return false
    const sub = await ensureType(row, gate, 'poster', priority, { probe, state })
    return sub.state === MEDIA_STATE.PENDING
  }

  /* ── public: serve ────────────────────────────────────────────────────── */
  async function serve(row, type, { v, p } = {}) {
    if (!isValidSha256(v) || typeof p !== 'string' || !p) return { kind: 'bad-request' }
    const gate = classify(row)
    if (gate.kind === 'hidden') return { kind: 'stale' }
    if (gate.kind === 'unsupported') return { kind: 'unsupported', reason: gate.reason }
    if (p !== profile || v !== gate.sha) return { kind: 'stale' }
    if (!TYPES.includes(type)) return { kind: 'bad-request' }
    const sha = gate.sha
    const state = await loadState(sha)
    if (state[type].state === MEDIA_STATE.READY) {
      const st = await cache.statDerivative(sha, type)
      if (st) {
        await cache.touch(sha, now()); evictor.touch(sha, now())
        return { kind: 'ready', path: st.path, mime: st.mime, bytes: st.bytes, etag: `"${sha}-${profile}-${type}"` }
      }
    }
    const probe = await cache.readProbe(sha)
    if (probe && probe.unsupported) return { kind: 'unsupported', reason: probe.reason }
    const sub = await ensureType(row, gate, type, PRIORITY.INTERACTIVE, { probe, state })
    switch (sub.state) {
      case MEDIA_STATE.UNSUPPORTED: return { kind: 'unsupported', reason: sub.reason }
      case MEDIA_STATE.GENERATION_FAILED: return { kind: 'failed', reason: sub.reason }
      case MEDIA_STATE.RETRYABLE: return { kind: 'retryable', reason: sub.reason ?? null, retryAfterSeconds: Math.max(1, Math.ceil((sub.retryAfterMs ?? 1000) / 1000)) }
      default: return { kind: 'pending', retryAfterSeconds: Math.max(1, Math.ceil((sub.retryAfterMs ?? 1000) / 1000)) }
    }
  }

  /* ── public: admin / lifecycle ────────────────────────────────────────── */
  async function invalidate(sha, { actor = null } = {}) {
    if (!isValidSha256(sha)) return false
    await cache.removeEntry(sha)
    evictor.remove(sha)
    onAudit({ action: 'MEDIA_CACHE_INVALIDATE', target: sha, actor })
    return true
  }
  async function adminStatus() {
    const dayAgo = now() - 24 * 3_600_000
    return {
      enabled: true,
      capabilities,
      cache: {
        dir: cache.root, bytes: evictor.totalBytes(), entries: evictor.entries().length,
        highWater: limits.cacheMaxBytes, lowWater: Math.floor(limits.cacheMaxBytes * limits.cacheLowWater),
        lastEvictionAt: evictor.lastEvictionAt(), staleProfiles: await cache.staleProfileDirs(), volume: mountState,
      },
      queue: queue.stats(),
      failures: { last24h: failures.filter((f) => f.at >= dayAgo).length },
    }
  }
  function health() {
    return { enabled: true, reason: null, ffmpeg: { ok: capabilities.ffmpeg.ok, version: capabilities.ffmpeg.version }, sharp: { ok: capabilities.sharp.ok, version: capabilities.sharp.version }, cacheWritable, cacheVolume: mountState }
  }
  const isPinned = (sha) => TYPES.some((t) => queue.has(key(sha, t)))
  async function init() {
    try {
      await fsp.mkdir(path.join(cache.root, 'tmp'), { recursive: true })
      await fsp.mkdir(path.join(cache.root, profile), { recursive: true })
      const probeFile = path.join(cache.root, 'tmp', `.write-probe-${process.pid}-${now()}`)
      await fsp.writeFile(probeFile, 'ok'); await fsp.rm(probeFile, { force: true })
      cacheWritable = true
    } catch (err) {
      cacheWritable = false
      log(`[media] cache directory not writable: ${err?.message ?? err}`)
    }
  }
  async function start() {
    await cache.cleanupTmp({ olderThanMs: limits.motionTimeoutMs })
    await evictor.buildIndex()
    stopEviction = evictor.schedule(EVICTION_INTERVAL_MS)
    started = true
  }
  async function stop() {
    if (stopEviction) { stopEviction(); stopEviction = null }
    await queue.shutdown({ reason: 'stop' })
    started = false
  }
  const drain = () => Promise.all([...inflight]).then(() => (inflight.size ? drain() : undefined))

  return Object.freeze({
    limits, profile, reason: null,
    init, start, stop, drain, isStarted: () => started,
    info, infoBatch, ensure, serve, scheduleForFile, invalidate, adminStatus, health, isPinned,
  })
}
