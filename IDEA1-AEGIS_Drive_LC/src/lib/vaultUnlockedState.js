// src/lib/vaultUnlockedState.js — AEGIS Drive (IDEA1) · PR #157 Task 5.4 · the one unlocked-state registry + purgeUnlockedVaultState(reason)
//
// ทุกสิ่งที่ "มีอยู่ได้เฉพาะตอนปลดล็อก" ลงทะเบียนที่นี่ — AbortController ของงานถอดรหัส/โอน, Object URL, token
// ของ preview session, reference ของกุญแจ (KEK/TRK), บัฟเฟอร์ที่ถอดแล้ว, และ disposer ของ state ฝั่งจอ (manifest,
// ชื่อ, breadcrumb, selection, intent/rebase ที่ค้าง) — แล้ว purge(reason) เดียวเก็บกวาดทั้งหมดตามลำดับที่กำหนด:
//
//   1. abort ทุก controller        (งานที่กำลังใช้กุญแจหยุดก่อนอย่างอื่น)
//   2. invalidateMutations         (intent/rebase/CAS ที่ค้าง "ตาย": token เก่าไม่ผ่านอีก)
//   3. disposers                   (จอทิ้ง manifest/ชื่อ/hierarchy index/breadcrumb/selection)
//   4. revoke Object URL ทุกอัน
//   5. closeAllPreviewSessions     (เรียกครั้งเดียว — worker ทิ้งทุก token)
//   6. drop key references         (ทุก property ของ ref ที่ลงทะเบียน = null)
//   7. drop buffers                (Uint8Array.fill(0) แล้ว ref.bytes = null)
//
// ── ขอบเขตของคำว่า "ล้าง" (ต้องพูดตามจริง) ──────────────────────────────────
// ⚠️ นี่คือ best-effort ในภาษาที่มี garbage collector: fill(0) เขียนทับไบต์ของ ArrayBuffer ที่เรายังถือ reference
//    อยู่ และการตั้ง null ปล่อยให้ GC เก็บ — แต่ไม่รับประกันว่า physical RAM, สำเนาที่ engine/เบราว์เซอร์/worker
//    ทำไว้ภายใน หรือหน่วยความจำของ CryptoKey (non-extractable) ถูกลบจริง ณ เวลานั้น รายงานจึงบอกแค่ "droppedBuffers"
//    ไม่ใช่ "erased" และไม่มีที่ใดในผลิตภัณฑ์อ้างการล้างหน่วยความจำจริง (physical zeroization)
// ⚠️ idempotent: purge ครั้งที่สองไม่ทำอะไรและรายงาน alreadyPurged=true; การลงทะเบียนหลัง purge โยน — เพื่อไม่ให้
//    plaintext ใดถูกผูกเข้ากับ state ที่ตายแล้ว (เช่น promise ที่ค้างอยู่มาถึงหลังล็อก)
// ⚠️ ไม่มี storage ใดในไฟล์นี้ (ไม่มี localStorage/sessionStorage/IndexedDB/Cache API) — ทุกอย่างอยู่ในหน่วยความจำ

import { closeAllPreviewSessions as defaultCloseAllPreviewSessions } from './vaultPreviewSession.js'

export const PURGE_REASONS = Object.freeze({
  MANUAL_LOCK: 'MANUAL_LOCK',
  AUTO_LOCK: 'AUTO_LOCK',
  LOGOUT: 'LOGOUT',
  SESSION_INVALIDATED: 'SESSION_INVALIDATED',
  UNMOUNT: 'UNMOUNT',
  NAVIGATION: 'NAVIGATION',
  PAGE_HIDE: 'PAGE_HIDE',
})
const REASONS = new Set(Object.values(PURGE_REASONS))

export class UnlockedStateError extends Error {
  constructor(code, message = code) { super(message); this.name = 'UnlockedStateError'; this.code = code }
}

const defaultRevoke = (url) => { try { globalThis.URL?.revokeObjectURL?.(url) } catch { /* URL อาจถูก revoke ไปแล้ว */ } }

/**
 * @returns {{ registerAbort, registerObjectUrl, registerPreviewToken, registerKey, registerBuffer, registerDisposer,
 *             invalidateMutations, mutationToken, isMutationValid, purge, isPurged }}
 */
export function createUnlockedVaultState({ revokeObjectUrl = defaultRevoke, closeAllPreviewSessions = defaultCloseAllPreviewSessions } = {}) {
  const hooks = { revokeObjectUrl, closeAllPreviewSessions }
  const aborts = new Set()
  const urls = new Set()
  const tokens = new Set()
  const keys = new Set()
  const buffers = new Set()
  const disposers = []
  let purged = false
  let mutationEpoch = 1

  const alive = () => { if (purged) throw new UnlockedStateError('PURGED', 'unlocked vault state was purged; nothing may be registered on it') }

  function registerAbort(controller) { alive(); if (controller && typeof controller.abort === 'function') aborts.add(controller); return controller }
  function registerObjectUrl(url) { alive(); if (typeof url === 'string' && url) urls.add(url); return url }
  function registerPreviewToken(token) { alive(); if (typeof token === 'string' && token) tokens.add(token); return token }
  function registerKey(ref) { alive(); if (ref && typeof ref === 'object') keys.add(ref); return ref }
  function registerBuffer(ref) { alive(); if (ref && typeof ref === 'object') buffers.add(ref); return ref }
  function registerDisposer(fn) { alive(); if (typeof fn === 'function') disposers.push(fn); return fn }

  /** ทำให้ intent/rebase/CAS ที่ค้างอยู่ทั้งหมด "ตาย": token ที่ออกก่อนหน้านี้ไม่ผ่าน isMutationValid อีก */
  function invalidateMutations() { mutationEpoch += 1; return mutationEpoch }
  function mutationToken() { return purged ? 0 : mutationEpoch }
  function isMutationValid(token) { return !purged && token === mutationEpoch }

  function purge(reason) {
    if (!REASONS.has(reason)) throw new UnlockedStateError('BAD_REASON', `purgeUnlockedVaultState: unknown reason ${String(reason)}`)
    const report = { reason, abortedFetches: 0, revokedUrls: 0, closedTokens: 0, droppedKeys: 0, droppedBuffers: 0, disposers: 0, alreadyPurged: purged }
    if (purged) return report
    purged = true
    // 1. abort
    for (const c of aborts) { try { c.abort(); report.abortedFetches += 1 } catch { /* controller เสีย ≠ หยุดการ purge */ } }
    aborts.clear()
    // 2. invalidate mutations
    invalidateMutations()
    // 3. disposers (ลำดับที่ลงทะเบียน; ตัวใดพังไม่กันตัวอื่น)
    for (const fn of disposers.splice(0)) { try { fn(reason); report.disposers += 1 } catch { /* best-effort */ } }
    // 4. Object URLs
    for (const u of urls) { try { hooks.revokeObjectUrl(u); report.revokedUrls += 1 } catch { /* best-effort */ } }
    urls.clear()
    // 5. preview sessions — ครั้งเดียว ครอบทุก token (fire-and-forget; worker อาจไม่มีในสภาพแวดล้อมนี้)
    report.closedTokens = tokens.size
    tokens.clear()
    try { Promise.resolve(hooks.closeAllPreviewSessions()).catch(() => {}) } catch { /* best-effort */ }
    // 6. key references — ทุก property = null (CryptoKey non-extractable ไม่มีไบต์ให้เขียนทับ)
    for (const ref of keys) { for (const k of Object.keys(ref)) ref[k] = null; report.droppedKeys += 1 }
    keys.clear()
    // 7. buffers — fill(0) best-effort แล้วปล่อย reference
    for (const ref of buffers) {
      for (const k of Object.keys(ref)) {
        const v = ref[k]
        if (v && typeof v === 'object' && typeof v.fill === 'function' && Number.isInteger(v.byteLength)) { try { v.fill(0) } catch { /* buffer ถูก detach แล้ว */ } }
        ref[k] = null
      }
      report.droppedBuffers += 1
    }
    buffers.clear()
    return report
  }

  return {
    registerAbort, registerObjectUrl, registerPreviewToken, registerKey, registerBuffer, registerDisposer,
    invalidateMutations, mutationToken, isMutationValid, purge, isPurged: () => purged,
    /** ทดสอบเท่านั้น: ให้ชุดทดสอบสังเกตลำดับการเรียก hook */
    __hooks: hooks,
  }
}

/** ชื่อตามแผน — purgeUnlockedVaultState(state, reason) ≡ state.purge(reason) */
export const purgeUnlockedVaultState = (state, reason) => state.purge(reason)
