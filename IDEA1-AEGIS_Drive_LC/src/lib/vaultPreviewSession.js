// src/lib/vaultPreviewSession.js — AEGIS Drive (IDEA1) · เซสชัน preview ของวิดีโอ V2 ขนาดใหญ่
//
// ⚠️ สิ่งที่โมดูลนี้ "ส่งออกจากหน้าเว็บ" มีเพียงอย่างเดียว: ข้อความ postMessage ไปยัง
//    Service Worker **ต้นทางเดียวกัน** ที่รันอยู่ในเบราว์เซอร์เครื่องเดียวกัน ไม่มีอะไร
//    ออกไปที่เครือข่ายเลย เซิร์ฟเวอร์ยังไม่เคยเห็น plaintext ชื่อไฟล์ MIME DEK หรือ KEK
//
// ⚠️ DEK ถูกส่งเป็น CryptoKey ที่ **non-extractable** ผ่าน structured clone — ตัว worker
//    ใช้มันถอดรหัสได้ แต่ export ไบต์ของกุญแจออกมาไม่ได้ เหมือนกับในหน้าเว็บทุกประการ
//    และมันอยู่ใน Map ในหน่วยความจำของ worker เท่านั้น: ไม่มี localStorage ไม่มี
//    sessionStorage ไม่มี IndexedDB ไม่มี Cache API
//
// ⚠️ token ไม่ใช่ "ความลับที่ป้องกันผู้อื่น" — มันคือ **ชื่อของช่องในหน่วยความจำ** ที่มี
//    อายุสั้น เพราะขอบเขตของ Service Worker คือ origin นี้อยู่แล้ว การสุ่มมันด้วย CSPRNG
//    มีไว้กันการเดาชนกันเองและกันไม่ให้ URL ของ preview ใบก่อนใช้ซ้ำได้หลังปิด
import { PREVIEW_PATH_SEGMENT } from './vaultPreviewRange.js'

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
export async function ensurePreviewWorker({
  scope = globalThis,
  scriptUrl = previewWorkerUrl(),
  timeoutMs = 10_000,
} = {}) {
  if (!supportsLargeVideoPreview(scope)) return null
  const container = scope.navigator.serviceWorker

  await container.register(scriptUrl, { type: 'module' })
  if (container.controller) return container.controller

  // worker ตัวใหม่ต้องรอ activate + claim — มีเพดานเวลาเสมอ ไม่รอไม่มีที่สิ้นสุด
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      // ⚠️ ต้องเก็บกวาดทั้ง listener และ timer — ตัวจับเวลาที่ยังเดินอยู่หลังงานจบแล้ว
      //    ทำให้โปรเซส/แท็บถือทรัพยากรค้างไว้โดยไม่มีใครรอผลของมัน
      if (timer !== null) scope.clearTimeout?.(timer)
      container.removeEventListener?.('controllerchange', onChange)
      resolve(value)
    }
    const onChange = () => finish(container.controller ?? null)
    container.addEventListener?.('controllerchange', onChange)
    timer = scope.setTimeout(() => finish(container.controller ?? null), timeoutMs)
  })
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
 * @returns {Promise<{ token: string, url: string }|null>} null = เบราว์เซอร์นี้ทำไม่ได้
 */
export async function openPreviewSession({
  dek, blob, contentType, plainSize,
  scope = globalThis,
  base = import.meta.env?.BASE_URL ?? '/',
  controller: providedController,
}) {
  const controller = providedController ?? await ensurePreviewWorker({ scope })
  if (!controller) return null

  const token = newPreviewToken(scope)
  // ★ ส่ง "เฉพาะสิ่งที่จำเป็นต่อการถอดหนึ่งก้อน" ไม่ใช่ทั้ง entry — ยิ่งส่งน้อย ยิ่งมี
  //   ของให้ลืมลบน้อย และ worker ไม่มีเหตุต้องรู้ชื่อไฟล์เลย จึงไม่ถูกส่งไป
  const ok = await askWorker(controller, {
    type: 'vault-preview-open',
    token,
    dek,
    contentType,
    plainSize,
    blob: {
      id: blob.id,
      contentIdB64: blob.contentIdB64,
      chunkSize: blob.chunkSize,
      chunkCount: blob.chunkCount,
    },
  }, { scope })

  if (!ok?.ok) return null
  return { token, url: previewUrlFor(token, base) }
}

/**
 * ปิดเซสชัน — เรียกทุกครั้งที่ปิดกล่อง ล็อกตู้ ล็อกอัตโนมัติ หรือ component ถูกถอด
 * ⚠️ ต้องไม่โยน error ไม่ว่าอะไรจะเกิดขึ้น: มันถูกเรียกจากเส้นทางการล็อก และการล็อก
 *    ที่ล้มเหลวเพราะการเก็บกวาดล้มเหลว คือการปล่อยให้ตู้เปิดค้างไว้
 */
export async function closePreviewSession(token, { scope = globalThis, controller } = {}) {
  try {
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
    const target = controller ?? scope?.navigator?.serviceWorker?.controller
    if (!target) return false
    const res = await askWorker(target, { type: 'vault-preview-close-all' }, { scope })
    return Boolean(res?.ok)
  } catch {
    return false
  }
}
