// src/lib/vaultPreviewSession.js — AEGIS Drive (IDEA1) · เซสชัน preview ของวิดีโอ V2 ขนาดใหญ่
//
// ⚠️ สิ่งที่โมดูลนี้ "ส่งออกจากหน้าเว็บ" มีเพียงอย่างเดียว: ข้อความ postMessage ไปยัง
//    Service Worker **ต้นทางเดียวกัน** ที่รันอยู่ในเบราว์เซอร์เครื่องเดียวกัน ไม่มีอะไร
//    ออกไปที่เครือข่ายเลย เซิร์ฟเวอร์ยังไม่เคยเห็น plaintext ชื่อไฟล์ MIME DEK หรือ KEK
//
// ⚠️ DEK ถูกส่งเป็น CryptoKey ที่ **non-extractable** ผ่าน structured clone — ตัว worker
//    ใช้มันถอดรหัสได้ แต่ export ไบต์ของกุญแจออกมาไม่ได้ เหมือนกับในหน้าเว็บทุกประการ
//    และมันอยู่ใน Map ของ page/worker memory เท่านั้น: ไม่มี localStorage ไม่มี
//    sessionStorage ไม่มี IndexedDB ไม่มี Cache API; page copy มีไว้กู้ worker ที่ถูก
//    browser ปิดทิ้ง และถูกลบพร้อม preview/การล็อก
//
// ⚠️ token ไม่ใช่ "ความลับที่ป้องกันผู้อื่น" — มันคือ **ชื่อของช่องในหน่วยความจำ** ที่มี
//    อายุสั้น เพราะขอบเขตของ Service Worker คือ origin นี้อยู่แล้ว การสุ่มมันด้วย CSPRNG
//    มีไว้กันการเดาชนกันเองและกันไม่ให้ URL ของ preview ใบก่อนใช้ซ้ำได้หลังปิด
import { PREVIEW_PATH_SEGMENT } from './vaultPreviewRange.js'
import { PREVIEW_FAILURE_REASON } from './vaultPreviewErrors.js'
import { previewDiagnosticsEnabled } from './vaultPreviewDiagnostics.js'
import { PREVIEW_CLAIM_MESSAGE } from './vaultPreviewClaim.js'

// Page-memory recovery registry. It is intentionally a module Map: a reload or
// tab close destroys it, and no browser storage API is involved.
const activePreviewSessions = new Map()

/** ที่อยู่ของสคริปต์ worker — dev เสิร์ฟจาก source, production จาก entry ที่ build แล้ว */
export function previewWorkerUrl(base = import.meta.env?.BASE_URL ?? '/', dev = Boolean(import.meta.env?.DEV)) {
  return dev ? `${base}src/vaultPreviewServiceWorker.js` : `${base}vault-preview-sw.js`
}

/**
 * เบราว์เซอร์นี้ทำ preview วิดีโอขนาดใหญ่ได้ไหม — ตรวจจากความสามารถจริง ไม่ใช่ user agent
 *
 * ⚠️ ทั้งสามอย่างจำเป็นจริง ไม่ใช่การตรวจเผื่อ:
 *      serviceWorker  — ตัวดักคำขอ ไม่มีตัวนี้ก็ไม่มีเส้นทางนี้เลย
 *      ReadableStream — ถ้าไม่มี จะต้องประกอบคำตอบทั้งก้อนในหน่วยความจำ ซึ่งคือสิ่งที่
 *                       งานนี้มีไว้เพื่อหลีกเลี่ยง
 *      isSecureContext — Service Worker ลงทะเบียนได้เฉพาะ context ที่ปลอดภัย
 */
export function supportsLargeVideoPreview(scope = globalThis) {
  if (!scope?.navigator?.serviceWorker) return false
  if (typeof scope?.ReadableStream !== 'function') return false
  if (scope?.isSecureContext === false) return false
  return true
}

/** ชื่อช่องในหน่วยความจำของ worker — 128 บิตจาก CSPRNG */
export function newPreviewToken(scope = globalThis) {
  const bytes = scope.crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** URL เสมือนที่ <video> จะชี้ไป — same-origin จึงอยู่ใต้ media-src 'self' ที่มีอยู่แล้ว */
export function previewUrlFor(token, base = import.meta.env?.BASE_URL ?? '/') {
  return `${base}${PREVIEW_PATH_SEGMENT}/${token}`
}

/**
 * ลงทะเบียน worker แล้วรอจนกว่ามันจะ "คุม" หน้านี้จริง ๆ
 *
 * ⚠️ ต้องรอ controller จริง ไม่ใช่แค่ registration: worker ที่ลงทะเบียนแล้วแต่ยังไม่ได้
 *    claim หน้านี้จะ **ไม่เห็น** คำขอของ <video> เลย ผลคือเบราว์เซอร์ยิงไปที่เซิร์ฟเวอร์
 *    จริงแล้วได้ 404 ซึ่งบนหน้าจอจะดูเหมือน "preview พัง" โดยไม่มีสาเหตุที่อธิบายได้
 */
export async function ensurePreviewWorkerResult({
  scope = globalThis,
  scriptUrl = previewWorkerUrl(),
  timeoutMs = 10_000,
  claimTimeoutMs = 5_000,
  isUnlocked = () => true,
} = {}) {
  if (!supportsLargeVideoPreview(scope)) {
    return { ok: false, reason: PREVIEW_FAILURE_REASON.UNSUPPORTED_BROWSER }
  }
  const container = scope.navigator.serviceWorker

  let registration = null
  try {
    registration = await container.register(scriptUrl, { type: 'module' })
  } catch {
    return { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_REGISTRATION_FAILED }
  }

  // ── Fast path: this page is already controlled ──────────────────────────
  // Nothing is sent and nothing is awaited. An existing controller *is* the
  // whole contract, and a claim request here would be pure noise on the path
  // that every second and subsequent preview takes.
  if (container.controller) return { ok: true, controller: container.controller }

  // ── Bounded claim-on-demand recovery (LFT-V2-E3.2) ─────────────────────
  //
  // Production shape being repaired: registration.active is activated, yet
  // navigator.serviceWorker.controller is null, so <video> requests bypass the
  // worker entirely and the preview reports worker-controller-timeout. The
  // page previously recovered only when the user reloaded by hand.
  //
  // ⚠️ Recovery is a single message, never a reload. An automatic reload here
  //    would be a reload loop waiting to happen: the same uncontrolled state
  //    reproduces on the next load and reloads again, and every in-memory DEK
  //    and unlocked-Vault state is destroyed on each pass.
  //
  // The listener is attached *before* the claim is requested: a controllerchange
  // that landed in between would otherwise be missed and read as a false timeout.
  const controlled = waitForController(container, scope, timeoutMs)

  const active = registration?.active ?? null
  if (active?.postMessage) {
    askWorker(active, { type: PREVIEW_CLAIM_MESSAGE }, { scope, timeoutMs: claimTimeoutMs })
      ?.catch?.(() => { /* the controllerchange deadline is the real answer */ })
  }

  const controller = await controlled
  // A claim that never produced a controller is still truthfully a timeout —
  // this path must not invent a healthier-sounding reason than it earned.
  if (!controller) return { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_CONTROLLER_TIMEOUT }
  // ⚠️ The Vault can be locked while the claim is in flight. Opening a session
  //    with a key from a now-locked page would resurrect exactly what the lock
  //    was for, so a lock always wins the race.
  if (!isUnlocked()) return { ok: false, reason: PREVIEW_FAILURE_REASON.VAULT_LOCKED }
  return { ok: true, controller }
}

/**
 * Resolve with the controller that takes over this page, or null at the deadline.
 * ⚠️ A controllerchange whose controller is still null is not the takeover being
 *    waited for; keep listening until the deadline instead of reporting an early,
 *    untrue timeout.
 */
function waitForController(container, scope, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (controller) => {
      if (settled) return
      settled = true
      // ⚠️ ต้องเก็บกวาดทั้ง listener และ timer — ตัวจับเวลาที่ยังเดินอยู่หลังงานจบแล้ว
      //    ทำให้โปรเซส/แท็บถือทรัพยากรค้างไว้โดยไม่มีใครรอผลของมัน
      if (timer !== null) scope.clearTimeout?.(timer)
      container.removeEventListener?.('controllerchange', onChange)
      resolve(controller)
    }
    const onChange = () => { if (container.controller) finish(container.controller) }
    container.addEventListener?.('controllerchange', onChange)
    timer = scope.setTimeout(() => finish(container.controller ?? null), timeoutMs)
    if (container.controller) finish(container.controller)
  })
}

/** Backwards-compatible controller helper used by existing callers/tests. */
export async function ensurePreviewWorker(options = {}) {
  const result = await ensurePreviewWorkerResult(options)
  return result.ok ? result.controller : null
}

/** ส่งข้อความแล้วรอคำตอบผ่าน MessageChannel — ไม่ใช่ "ส่งแล้วหวังว่าจะถึง" */
export function askWorker(controller, message, { scope = globalThis, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    const channel = new scope.MessageChannel()
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      // ⚠️ ปิดพอร์ตและยกเลิกตัวจับเวลาเสมอ: MessagePort ที่เปิดค้างเป็นทรัพยากรที่ยังมี
      //    ชีวิตอยู่ ไม่ใช่แค่ object ที่รอ GC — ลืมปิดแล้วโปรเซสไม่ยอมจบ (ชุดทดสอบจับได้)
      if (timer !== null) scope.clearTimeout?.(timer)
      try { channel.port1.close() } catch { /* ปิดไปแล้ว */ }
      resolve(value)
    }
    channel.port1.onmessage = (event) => finish(event.data ?? null)
    timer = scope.setTimeout(() => finish(null), timeoutMs)
    controller.postMessage(message, [channel.port2])
  })
}

/**
 * เปิดเซสชัน preview หนึ่งใบ
 *
 * @param {{ dek: CryptoKey, blob: object, contentType: string, plainSize: number,
 *           scope?: object, base?: string }} options
 * @returns {Promise<{ ok: true, token: string, url: string }
 *          | { ok: false, reason: string }>}
 */
export async function openPreviewSession({
  dek, blob, contentType, plainSize,
  scope = globalThis,
  base = import.meta.env?.BASE_URL ?? '/',
  controller: providedController,
  isUnlocked = () => true,
}) {
  const worker = providedController
    ? { ok: true, controller: providedController }
    : await ensurePreviewWorkerResult({ scope, isUnlocked })
  if (!worker.ok) return worker
  // ⚠️ Re-checked after every await on this path: claim recovery can take
  //    seconds, and a Vault locked in that window must not receive a DEK.
  if (!isUnlocked()) return { ok: false, reason: PREVIEW_FAILURE_REASON.VAULT_LOCKED }
  const controller = worker.controller

  const token = newPreviewToken(scope)
  const sessionPayload = {
    dek,
    contentType,
    plainSize: Number(plainSize) || 0,
    blob: {
      id: blob.id,
      contentIdB64: blob.contentIdB64,
      chunkSize: blob.chunkSize,
      chunkCount: blob.chunkCount,
    },
  }
  // ★ ส่ง "เฉพาะสิ่งที่จำเป็นต่อการถอดหนึ่งก้อน" ไม่ใช่ทั้ง entry — ยิ่งส่งน้อย ยิ่งมี
  //   ของให้ลืมลบน้อย และ worker ไม่มีเหตุต้องรู้ชื่อไฟล์เลย จึงไม่ถูกส่งไป
  let ok
  try {
    ok = await askWorker(controller, {
      type: 'vault-preview-open',
      token,
      diagnostics: previewDiagnosticsEnabled(scope),
      ...sessionPayload,
    }, { scope })
  } catch {
    ok = null
  }

  if (!ok?.ok) {
    return { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_SESSION_OPEN_FAILED }
  }
  // Recovery becomes possible only after the worker confirms the open. Until
  // then the screen cannot know/revoke this provisional token, so exposing it
  // through the page registry would leave a close/replacement race.
  activePreviewSessions.set(token, sessionPayload)
  return { ok: true, token, url: previewUrlFor(token, base) }
}

/**
 * Reply to a worker restart using only the exact active token. The caller
 * supplies the live React unlock predicate; a stale or locked page cannot
 * return a key even if a delayed message arrives.
 */
export function handlePreviewSessionNeeded(event, { isUnlocked = () => true } = {}) {
  const msg = event?.data
  if (msg?.type !== 'vault-preview-session-needed' || !msg.token) return false
  const port = event.ports?.[0]
  if (!port?.postMessage) return false
  const session = activePreviewSessions.get(msg.token)
  if (!session || !isUnlocked()) {
    port.postMessage({ ok: false, token: msg.token })
    return true
  }
  port.postMessage({
    ok: true,
    type: 'vault-preview-session-rehydrate',
    token: msg.token,
    session,
  })
  return true
}

export function installPreviewSessionRecovery({ scope = globalThis, isUnlocked = () => true } = {}) {
  const container = scope?.navigator?.serviceWorker
  if (!container?.addEventListener) return () => {}
  const listener = (event) => { handlePreviewSessionNeeded(event, { isUnlocked }) }
  container.addEventListener('message', listener)
  return () => container.removeEventListener?.('message', listener)
}

/**
 * ปิดเซสชัน — เรียกทุกครั้งที่ปิดกล่อง ล็อกตู้ ล็อกอัตโนมัติ หรือ component ถูกถอด
 * ⚠️ ต้องไม่โยน error ไม่ว่าอะไรจะเกิดขึ้น: มันถูกเรียกจากเส้นทางการล็อก และการล็อก
 *    ที่ล้มเหลวเพราะการเก็บกวาดล้มเหลว คือการปล่อยให้ตู้เปิดค้างไว้
 */
export async function closePreviewSession(token, { scope = globalThis, controller } = {}) {
  try {
    if (token) activePreviewSessions.delete(token)
    const target = controller ?? scope?.navigator?.serviceWorker?.controller
    if (!target || !token) return false
    const res = await askWorker(target, { type: 'vault-preview-close', token }, { scope })
    return Boolean(res?.ok)
  } catch {
    return false
  }
}

/** ล้างทุกเซสชันใน worker — ใช้ตอนล็อกตู้ ไม่ใช่ตอนปิดกล่อง preview ใบเดียว */
export async function closeAllPreviewSessions({ scope = globalThis, controller } = {}) {
  try {
    activePreviewSessions.clear()
    const target = controller ?? scope?.navigator?.serviceWorker?.controller
    if (!target) return false
    const res = await askWorker(target, { type: 'vault-preview-close-all' }, { scope })
    return Boolean(res?.ok)
  } catch {
    return false
  }
}
