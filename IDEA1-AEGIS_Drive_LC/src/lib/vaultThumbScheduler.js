// src/lib/vaultThumbScheduler.js — AEGIS Drive (IDEA1) · PR #157 Task 7.1 · bounded client-only thumbnail scheduler
//
// ตัวคุมงานพรีวิวฝั่ง client ทั้งหมด: งานถอดรหัสรันพร้อมกันไม่เกิน limits.maxConcurrentJobs, ที่เหลือเข้าคิว,
// เพดานหน่วยความจำประมาณการ (estimateBytes ก่อนถอด → ไบต์จริง + พิกเซลหลังถอด), LRU ของ Object URL
// ไม่เกิน limits.maxRetainedObjectUrls, หน้าจอถูกซ่อน = abort งานที่วิ่ง + หยุดคิว, เปลี่ยนโฟลเดอร์ =
// คืนของนอกโฟลเดอร์, ล็อก (purge) = releaseAll ทั้งหมด และ decode ล้ม (integrity) = retry ได้ครั้งเดียว
// ไม่มี URL เกิด
//
// ── กติกาที่ไม่มีข้อยกเว้น ────────────────────────────────────────────────────
//   • โมดูลนี้ไม่แตะ storage ใด ๆ (Cache API/IndexedDB/localStorage/sessionStorage) เด็ดขาด — SA-1/SA-SW-1
//   • ทุก AbortController ลงทะเบียนกับ unlockedState (ให้ตัว) — purge เรียก releaseAll ผ่าน disposer ของจอ
//   • ทุก Object URL เกิดผ่าน createObjectUrl (ฉีดได้เพื่อเทสต์) และถูก revoke ตาม LRU/ปล่อย/ล็อก
//   • estimateBytes มาจาก manifest node (plainSize) — ไม่มีการเดาขนาดเอง
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

const defaultCreate = (bytes) => URL.createObjectURL(new Blob([bytes]))
const defaultRevoke = (url) => { try { URL.revokeObjectURL(url) } catch { /* already gone */ } }

/**
 * @param {{
 *   limits?: object,
 *   load: (key: string, opts: { signal?: AbortSignal, folderId?: string }) => Promise<{ width: number, height: number, bytes: Uint8Array, mime?: string }>,
 *   createObjectUrl?: (bytes: Uint8Array) => string,
 *   revokeObjectUrl?: (url: string) => void,
 *   unlockedState?: object | null,
 *   visibility?: () => boolean,
 *   onVisibilityChange?: (fn: () => void) => void,
 * }} p
 */
export function createThumbScheduler({
  limits = VAULT_TREE_CLIENT_LIMITS,
  load,
  createObjectUrl = defaultCreate,
  revokeObjectUrl = defaultRevoke,
  unlockedState = null,
  visibility = null,
  onVisibilityChange = null,
  onChange = null,
}) {
  if (typeof load !== 'function') throw new TypeError('createThumbScheduler: load is required')

  const entries = new Map()   // key → { state: 'queued'|'running'|'ready'|'failed', folderId, estimateBytes, ctrl, url, estBytes, attempts, width, height }
  let urlsRetained = 0
  const urlOrder = []         // LRU order of retained keys (oldest first)
  let failures = 0
  let pausedByVisibility = false

  const estOf = (e) => (e.state === 'ready'
    ? (e.width * e.height * 4 + (e.decodedBytes?.length ?? 0))
    : (e.estimateBytes ?? 0))
  const estTotal = () => { let t = 0; for (const e of entries.values()) if (e.state === 'running' || e.state === 'ready') t += estOf(e); return t }

  function revokeKey(key) {
    const e = entries.get(key)
    if (!e?.url) return
    try { revokeObjectUrl(e.url) } catch { /* best effort */ }
    e.url = null
    urlsRetained -= 1
    const i = urlOrder.indexOf(key)
    if (i !== -1) urlOrder.splice(i, 1)
  }

  /** LRU: เกินเพดาน = revoke ตัวเก่าสุด (เฉพาะ ready) */
  function enforceUrlBound() {
    while (urlOrder.length > limits.maxRetainedObjectUrls) revokeKey(urlOrder[0])
  }

  function completeJob(key, result) {
    const e = entries.get(key)
    if (!e || e.state !== 'running') return
    e.state = 'ready'
    e.width = result.width
    e.height = result.height
    e.decodedBytes = result.bytes ?? new Uint8Array(0)
    e.url = createObjectUrl(e.decodedBytes)
    unlockedState?.registerObjectUrl?.(e.url)
    urlsRetained += 1
    urlOrder.push(key)
    enforceUrlBound()
    onChange?.()
    pump()
  }

  function failJob(key, { permanent = false, reason = null, waitForEligibility = false } = {}) {
    const e = entries.get(key)
    if (!e || e.state !== 'running') return
    e.attempts = (e.attempts ?? 0) + 1
    e.reason = reason
    if (waitForEligibility) {
      e.state = 'failed'
      e.ctrl = null
      failures += 1
      onChange?.()
      pump()
      return
    }
    if (!permanent && e.attempts <= 1 && !e.ctrl?.signal?.aborted) {
      // หนึ่งครั้งพอ — ไม่มี retry storm (TSC-3)
      e.state = 'queued'
      e.ctrl = null
      pump()
      return
    }
    e.state = 'failed'
    failures += 1
    onChange?.()
    pump()
  }

  function startNext(key) {
    const e = entries.get(key)
    if (!e || e.state !== 'queued') return false
    const estimate = Math.max(0, e.estimateBytes ?? 0)
    if (estimate > limits.memoryCeilingBytes) {
      e.state = 'failed'
      e.reason = 'MEMORY_LIMIT'
      failures += 1
      onChange?.()
      return false
    }
    if (estTotal() + estimate > limits.memoryCeilingBytes) return false
    if (visibility?.()) { pausedByVisibility = true; return false }
    const ctrl = new AbortController()
    e.ctrl = ctrl
    e.state = 'running'
    unlockedState?.registerAbort?.(ctrl)
    const promise = load(key, { signal: ctrl.signal, folderId: e.folderId })
    Promise.resolve(promise).then(
      (result) => {
        if (e.ctrl !== ctrl) return
        completeJob(key, result ?? {})
      },
      (err) => {
        if (e.ctrl !== ctrl) return
        e.ctrl = null
        const reason = String(err?.code ?? err?.message ?? 'THUMB_FAILED')
        failJob(key, {
          permanent: err?.name === 'AbortError' || /abort/i.test(reason),
          reason,
          waitForEligibility: reason === 'BLOB_NOT_READY',
        })
      },
    )
    return true
  }

  /** เติมคิวตามเพดาน concurrency + memory + visibility */
  function pump() {
    if (pausedByVisibility && !visibility?.()) pausedByVisibility = false
    if (pausedByVisibility) return
    let running = 0
    for (const e of entries.values()) if (e.state === 'running') running += 1
    for (const [key, e] of entries) {
      if (running >= limits.maxConcurrentJobs) break
      if (e.state !== 'queued') continue
      if (startNext(key)) running += 1
      // A large or temporarily over-budget item must not head-of-line block a
      // later smaller preview that still fits the same bounded scheduler.
    }
  }

  /** ขอพรีวิวสำหรับโหนดหนึ่ง (dedupe ตาม key) */
  function observe(key, { folderId = null, estimateBytes = 0, eligible = true } = {}) {
    const existing = entries.get(key)
    if (existing) {
      const becameEligible = existing.eligible === false && eligible === true
      existing.eligible = eligible
      existing.folderId = folderId
      existing.estimateBytes = estimateBytes
      if (existing.state === 'failed' && existing.reason === 'BLOB_NOT_READY' && becameEligible) {
        existing.state = 'queued'
        existing.reason = null
        existing.attempts = 0
        failures = Math.max(0, failures - 1)
        onChange?.()
        pump()
      }
      return
    }
    entries.set(key, { state: 'queued', folderId, estimateBytes, eligible, attempts: 0, reason: null, url: null, ctrl: null })
    pump()
  }

  /** scroll-out/ปล่อยเฉพาะรายการ */
  function cancel(key) {
    const e = entries.get(key)
    if (!e) return
    if (e.state === 'running') { e.ctrl?.abort(); e.ctrl = null }
    if (e.url) revokeKey(key)
    entries.delete(key)
    onChange?.()
  }

  /** เปลี่ยนโฟลเดอร์/นำทาง (TSC-4) — ปล่อยทุกรายการที่อยู่ในโฟลเดอร์ที่ถูกทิ้งไป */
  function releaseFolder(folderId) {
    for (const [key, e] of [...entries]) {
      if (e.folderId === folderId) cancel(key)
    }
  }

  /** purge/ล็อก/ทำลาย (TSC-2) — abort ทุกงาน + revoke ทุก URL + ศูนย์ทุกตัวนับ */
  async function releaseAll() {
    for (const [key, e] of [...entries]) {
      if (e.state === 'running') e.ctrl?.abort()
      if (e.url) revokeKey(key)
    }
    for (const [key] of [...entries]) {
      const e = entries.get(key)
      if (e?.url) revokeKey(key)
    }
    entries.clear()
    urlsRetained = 0
    urlOrder.length = 0
    failures = 0
    pausedByVisibility = false
  }

  /** ภาพรวมต่อรายการสำหรับจอ: state/url/เหตุผล — onChange แจ้งทุกครั้งที่เปลี่ยน */
  function snapshot() {
    const out = new Map()
    for (const [key, e] of entries) out.set(key, { state: e.state, url: e.url ?? null, failed: e.state === 'failed', reason: e.reason ?? null, folderId: e.folderId })
    return out
  }

  function stats() {
    let running = 0, queued = 0
    for (const e of entries.values()) {
      if (e.state === 'running') running += 1
      else if (e.state === 'queued') queued += 1
    }
    return { running, queued, urlsRetained, estMemBytes: estTotal(), failures }
  }

  /** เทสต์เท่านั้น: บังคับงานหนึ่งให้เสร็จด้วยผลที่กำหนด (ผ่านทางเดียวกับ completeJob จริง) */
  function resolveForTest(key, { width = 8, height = 8, urlBytes = new Uint8Array(0) } = {}) {
    const e = entries.get(key)
    if (!e || e.state !== 'running') return
    e.ctrl = null
    completeJob(key, { width, height, bytes: urlBytes })
  }

  // หน้าซ่อน/เห็น (TSC-1) — จอ/ผู้เรียกผูก visibility ผ่านพารามิเตอร์ (jsdom เทสต์ฉีดตรง ๆ,
  // โปรดักต์ใช้ document.visibilityState + visibilitychange)
  onVisibilityChange?.(() => {
    if (visibility?.()) {
      // ซ่อน: abort ทุกงานที่วิ่ง คิวคงไว้
      for (const e of entries.values()) {
        if (e.state === 'running') { e.ctrl?.abort(); e.ctrl = null; e.state = 'queued' }
      }
      pausedByVisibility = true
    } else {
      pausedByVisibility = false
      pump()
    }
  })

  return { observe, cancel, releaseFolder, releaseAll, stats, resolveForTest, snapshot }
}
