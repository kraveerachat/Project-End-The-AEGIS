// tests/vaultPreviewSession.test.js — AEGIS Drive (IDEA1) · วงจรชีวิตของเซสชัน preview (LFT-V2-E3)
//
// ⚠️ สิ่งที่ตรึงไว้ที่นี่คือ "กุญแจไปถึงที่ที่ควรไป และถูกถอนออกจริงเมื่อถึงเวลา"
//    การเล่นวิดีโอต้องมีเบราว์เซอร์จริง แต่ **การเก็บกวาดกุญแจ** ทดสอบได้ตรง ๆ และมัน
//    คือส่วนที่ผิดพลาดแล้วอันตรายที่สุด: เซสชันที่ลืมปิด = URL ที่ยังถอดไฟล์ได้ต่อไป
//    ทั้งที่ผู้ใช้กดปิดหรือกดล็อกไปแล้ว
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  supportsLargeVideoPreview, newPreviewToken, previewUrlFor, previewWorkerUrl,
  ensurePreviewWorker, askWorker, openPreviewSession,
  closePreviewSession, closeAllPreviewSessions,
  ensurePreviewWorkerResult, handlePreviewSessionNeeded,
} from '../src/lib/vaultPreviewSession.js'
import { PREVIEW_PATH_SEGMENT } from '../src/lib/vaultPreviewRange.js'
import { PREVIEW_FAILURE_REASON } from '../src/lib/vaultPreviewErrors.js'

/** worker ปลอมที่บันทึกทุกข้อความ และเลือกได้ว่าจะตอบหรือเงียบ */
function fakeWorker({ answer = true } = {}) {
  const posted = []
  const controller = {
    postMessage(message, transfer) {
      posted.push(message)
      if (!answer) return
      const port = transfer?.[0]
      queueMicrotask(() => { try { port?.postMessage({ ok: true }) } catch { /* ปิดแล้ว */ } })
    },
  }
  return { controller, posted: () => [...posted] }
}

const scopeWith = (serviceWorker) => ({
  navigator: { serviceWorker },
  ReadableStream: globalThis.ReadableStream,
  crypto: globalThis.crypto,
  MessageChannel: globalThis.MessageChannel,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
})

// ── การตรวจความสามารถ ─────────────────────────────────────────────────────
test('ไม่มี Service Worker = ตอบว่าทำไม่ได้ ไม่ใช่พยายามแล้วพังทีหลัง', () => {
  assert.equal(supportsLargeVideoPreview({ navigator: {}, ReadableStream: globalThis.ReadableStream }), false)
  assert.equal(supportsLargeVideoPreview({}), false)
  assert.equal(supportsLargeVideoPreview(undefined), false)
})

test('ไม่มี ReadableStream = ทำไม่ได้ เพราะทางเลือกเดียวที่เหลือคือบัฟเฟอร์ทั้งไฟล์', () => {
  assert.equal(supportsLargeVideoPreview({ navigator: { serviceWorker: {} } }), false)
})

test('context ที่ไม่ปลอดภัย = ทำไม่ได้ (Service Worker ลงทะเบียนไม่ได้อยู่แล้ว)', () => {
  const scope = { ...scopeWith({}), isSecureContext: false }
  assert.equal(supportsLargeVideoPreview(scope), false)
})

test('ครบทั้งสามอย่าง = ทำได้', () => {
  assert.equal(supportsLargeVideoPreview(scopeWith({})), true)
})

// ── token และ URL ─────────────────────────────────────────────────────────
test('token เป็นเลขฐานสิบหก 128 บิต และไม่ซ้ำกัน', () => {
  const tokens = new Set()
  for (let i = 0; i < 200; i += 1) {
    const token = newPreviewToken(globalThis)
    assert.match(token, /^[0-9a-f]{32}$/)
    tokens.add(token)
  }
  assert.equal(tokens.size, 200, 'token ที่ชนกันแปลว่าเซสชันหนึ่งอาจเขียนทับอีกเซสชัน')
})

test('URL ของ preview เป็น same-origin ใต้ base ของแอป ไม่ใช่ blob: หรือปลายทางภายนอก', () => {
  const url = previewUrlFor('a'.repeat(32), '/drive/')
  assert.equal(url, `/drive/${PREVIEW_PATH_SEGMENT}/${'a'.repeat(32)}`)
  assert.equal(url.startsWith('blob:'), false)
  assert.equal(url.includes('://'), false, 'ต้องไม่ชี้ออกนอกต้นทาง — media-src \'self\' ครอบคลุมอยู่แล้ว')
})

test('ที่อยู่สคริปต์ worker ต่างกันระหว่าง dev กับ production และอยู่ใต้ base เสมอ', () => {
  assert.equal(previewWorkerUrl('/drive/', false), '/drive/vault-preview-sw.js')
  assert.equal(previewWorkerUrl('/drive/', true), '/drive/src/vaultPreviewServiceWorker.js')
  // ⚠️ ต้องอยู่ที่รากของ base: ขอบเขตของ Service Worker คือไดเรกทอรีของสคริปต์มันเอง
  assert.equal(previewWorkerUrl('/drive/', false).endsWith('/vault-preview-sw.js'), true)
})

// ── การสื่อสารกับ worker ──────────────────────────────────────────────────
test('askWorker คืนคำตอบจริงของ worker', async () => {
  const w = fakeWorker()
  const res = await askWorker(w.controller, { type: 'ping' }, { scope: scopeWith(null) })
  assert.deepEqual(res, { ok: true })
})

test('worker ที่ไม่ตอบไม่ทำให้ค้างตลอดกาล — มีเพดานเวลาเสมอ', async () => {
  const w = fakeWorker({ answer: false })
  const res = await askWorker(w.controller, { type: 'ping' }, { scope: scopeWith(null), timeoutMs: 30 })
  assert.equal(res, null, 'หมดเวลาแล้วต้องคืน null ไม่ใช่ค้างรอ')
})

test('ไม่มี controller = คืน null ไม่ใช่โยน error ให้จอจัดการเอง', async () => {
  assert.equal(await ensurePreviewWorker({ scope: { navigator: {} } }), null)
})

test('มี controller อยู่แล้ว = ใช้เลย ไม่ต้องรอ controllerchange', async () => {
  const w = fakeWorker()
  const scope = scopeWith({ controller: w.controller, register: async () => ({}) })
  assert.equal(await ensurePreviewWorker({ scope }), w.controller)
})

test('registration failure และ controller timeout ถูกจำแนก ไม่ถูกเรียกว่า browser unsupported', async () => {
  const registration = await ensurePreviewWorkerResult({
    scope: scopeWith({ register: async () => { throw new Error('registration denied') } }),
  })
  assert.deepEqual(registration, { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_REGISTRATION_FAILED })

  const timeout = await ensurePreviewWorkerResult({
    scope: scopeWith({
      controller: null,
      register: async () => ({}),
      addEventListener() {},
      removeEventListener() {},
    }),
    timeoutMs: 5,
  })
  assert.deepEqual(timeout, { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_CONTROLLER_TIMEOUT })
})

// ── เปิด / ปิดเซสชัน ──────────────────────────────────────────────────────
const blob = { id: 'b'.repeat(48), contentIdB64: 'Y29udGVudA==', chunkSize: 1040, chunkCount: 4 }

test('เปิดเซสชันส่ง DEK และ metadata ที่จำเป็น — และไม่ส่งอะไรเกินนั้น', async () => {
  const w = fakeWorker()
  const dek = { fake: 'CryptoKey' }
  const scope = scopeWith({ controller: w.controller, register: async () => ({}) })

  const session = await openPreviewSession({
    dek, blob, contentType: 'video/mp4', plainSize: 4096, scope, base: '/drive/',
  })

  assert.ok(session)
  assert.equal(session.ok, true)
  assert.match(session.token, /^[0-9a-f]{32}$/)
  assert.equal(session.url, `/drive/${PREVIEW_PATH_SEGMENT}/${session.token}`)

  const [msg] = w.posted()
  assert.equal(msg.type, 'vault-preview-open')
  assert.equal(msg.dek, dek, 'DEK ต้องถูกส่งเป็นตัวมันเอง (structured clone) ไม่ใช่ไบต์ที่ export ออกมา')
  assert.equal(msg.plainSize, 4096)
  assert.equal(msg.contentType, 'video/mp4')

  // ★ worker ไม่มีเหตุต้องรู้ชื่อไฟล์ ซองที่ห่อ DEK หรือ metadata ที่เข้ารหัสไว้
  assert.deepEqual(Object.keys(msg.blob).sort(), ['chunkCount', 'chunkSize', 'contentIdB64', 'id'])
  const serialised = JSON.stringify({ ...msg, dek: undefined })
  for (const forbidden of ['wrappedDek', 'wrapIv', 'metaB64', 'metaIv', 'name']) {
    assert.equal(serialised.includes(forbidden), false, `ต้องไม่ส่ง ${forbidden} ไปให้ worker`)
  }
})

test('worker ปฏิเสธการเปิด = เหตุผล session-open ชัดเจน ไม่คืน URL ที่ใช้ไม่ได้', async () => {
  const controller = {
    postMessage(_message, transfer) {
      queueMicrotask(() => transfer?.[0]?.postMessage({ ok: false }))
    },
  }
  const scope = scopeWith({ controller, register: async () => ({}) })
  const session = await openPreviewSession({
    dek: {}, blob, contentType: 'video/mp4', plainSize: 10, scope,
  })
  assert.deepEqual(session, { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_SESSION_OPEN_FAILED })
})

test('session is not recoverable from page memory until the worker acknowledges open', async () => {
  let posted
  let replyPort
  const controller = {
    postMessage(message, transfer) {
      if (message.type !== 'vault-preview-open') {
        queueMicrotask(() => transfer?.[0]?.postMessage({ ok: true }))
        return
      }
      posted = message
      replyPort = transfer?.[0]
    },
  }
  const scope = scopeWith({ controller, register: async () => ({}) })
  const pending = openPreviewSession({
    dek: { fake: 'CryptoKey' }, blob, contentType: 'video/mp4', plainSize: 4096, scope,
  })
  while (!posted) await Promise.resolve()

  const replies = []
  handlePreviewSessionNeeded({
    data: { type: 'vault-preview-session-needed', token: posted.token },
    ports: [{ postMessage: (message) => replies.push(message) }],
  }, { isUnlocked: () => true })
  assert.deepEqual(replies, [{ ok: false, token: posted.token }])

  replyPort.postMessage({ ok: true })
  const opened = await pending
  assert.equal(opened.ok, true)
  await closePreviewSession(opened.token, { scope })
})

test('หน้าเว็บ rehydrate ได้เฉพาะ token ที่ยัง active และ Vault ยังปลดล็อกอยู่', async () => {
  const w = fakeWorker()
  const dek = { fake: 'non-extractable CryptoKey' }
  const scope = scopeWith({ controller: w.controller, register: async () => ({}) })
  const opened = await openPreviewSession({
    dek, blob, contentType: 'video/mp4', plainSize: 4096, scope, base: '/drive/',
  })

  const replies = []
  const event = {
    data: { type: 'vault-preview-session-needed', token: opened.token },
    ports: [{ postMessage: (message) => replies.push(message) }],
  }
  assert.equal(handlePreviewSessionNeeded(event, { isUnlocked: () => true }), true)
  assert.equal(replies[0].ok, true)
  assert.equal(replies[0].token, opened.token)
  assert.equal(replies[0].session.dek, dek)
  assert.equal(replies[0].session.blob.id, blob.id)
  assert.equal(JSON.stringify({ ...replies[0], session: { ...replies[0].session, dek: undefined } }).includes('name'), false)

  const lockedReplies = []
  handlePreviewSessionNeeded({ ...event, ports: [{ postMessage: (message) => lockedReplies.push(message) }] }, {
    isUnlocked: () => false,
  })
  assert.deepEqual(lockedReplies, [{ ok: false, token: opened.token }])

  await closePreviewSession(opened.token, { scope })
  const closedReplies = []
  handlePreviewSessionNeeded({ ...event, ports: [{ postMessage: (message) => closedReplies.push(message) }] })
  assert.deepEqual(closedReplies, [{ ok: false, token: opened.token }])
})

test('ปิดเซสชันสั่ง worker ลบ token ใบนั้นโดยเฉพาะ', async () => {
  const w = fakeWorker()
  const scope = scopeWith({ controller: w.controller })
  assert.equal(await closePreviewSession('c'.repeat(32), { scope }), true)

  assert.deepEqual(w.posted(), [{ type: 'vault-preview-close', token: 'c'.repeat(32) }])
})

test('ปิดทั้งหมด (ตอนล็อกตู้) ไม่ต้องรู้ token ใด ๆ', async () => {
  const w = fakeWorker()
  const scope = scopeWith({ controller: w.controller })
  assert.equal(await closeAllPreviewSessions({ scope }), true)
  assert.deepEqual(w.posted(), [{ type: 'vault-preview-close-all' }])
})

test('การเก็บกวาดต้องไม่โยน error แม้ไม่มี worker เลย — มันถูกเรียกจากเส้นทางการล็อก', async () => {
  // ⚠️ ถ้าฟังก์ชันนี้โยน การล็อกตู้จะล้มกลางคัน = ตู้เปิดค้างไว้ ซึ่งแย่กว่าการเก็บกวาดไม่สำเร็จ
  assert.equal(await closePreviewSession('x'.repeat(32), { scope: { navigator: {} } }), false)
  assert.equal(await closeAllPreviewSessions({ scope: { navigator: {} } }), false)
  assert.equal(await closePreviewSession(null, { scope: scopeWith({ controller: {} }) }), false)
})

// ── LFT-V2-E3.2 · claim-on-demand controller recovery ───────────────────────
//
// ⚠️ Production shape being repaired: registration.active existed and was
//    activated, navigator.serviceWorker.controller was null, so the <video>
//    element's requests never reached the worker and the preview reported
//    worker-controller-timeout. Only a manual page reload recovered it.
//
//    The recovery must stay bounded and must never reload: an automatic reload
//    reproduces the same uncontrolled state on the next load — a reload loop —
//    and it destroys the in-memory DEK and the unlocked Vault on every pass.

/** A container that is registered and activated but does not control the page. */
function uncontrolledContainer({ claims = true, claimReplies = true } = {}) {
  const listeners = new Set()
  const claimMessages = []
  const controllerMessages = []
  let controller = null
  const activeWorker = {
    postMessage(message, transfer) {
      claimMessages.push(message)
      if (!claimReplies) return
      queueMicrotask(() => { try { transfer?.[0]?.postMessage({ ok: claims }) } catch { /* closed */ } })
      if (!claims) return
      // A real clients.claim() takes control and then fires controllerchange.
      queueMicrotask(() => {
        controller = {
          postMessage(message, transfer) {
            controllerMessages.push(message)
            queueMicrotask(() => { try { transfer?.[0]?.postMessage({ ok: true }) } catch { /* closed */ } })
          },
        }
        for (const fn of listeners) fn({ type: 'controllerchange' })
      })
    },
  }
  return {
    container: {
      get controller() { return controller },
      async register() { return { active: activeWorker, waiting: null, installing: null } },
      addEventListener(type, fn) { if (type === 'controllerchange') listeners.add(fn) },
      removeEventListener(type, fn) { listeners.delete(fn) },
    },
    claimMessages: () => [...claimMessages],
    controllerMessages: () => [...controllerMessages],
    controller: () => controller,
  }
}

test('active worker with a null controller is recovered by one claim request, not a reload', async () => {
  const c = uncontrolledContainer()
  let reloads = 0
  const scope = { ...scopeWith(c.container), location: { reload: () => { reloads += 1 } } }

  const result = await ensurePreviewWorkerResult({ scope, timeoutMs: 500 })

  assert.equal(result.ok, true, 'an activated worker must take control without user action')
  assert.equal(result.controller, c.controller())
  assert.deepEqual(c.claimMessages(), [{ type: 'vault-preview-claim' }],
    'exactly one claim request — never a stream of them')
  assert.equal(reloads, 0, 'recovery must never reload: that is how a reload loop starts')
})

test('an already-controlled page takes the fast path and sends no claim at all', async () => {
  const w = fakeWorker()
  const claims = []
  const scope = scopeWith({
    controller: w.controller,
    async register() { return { active: { postMessage: (m) => claims.push(m) } } },
    addEventListener() { assert.fail('a controlled page must not wait for controllerchange') },
    removeEventListener() {},
  })

  const result = await ensurePreviewWorkerResult({ scope })
  assert.deepEqual(result, { ok: true, controller: w.controller })
  assert.deepEqual(claims, [], 'no claim message on the path every later preview takes')
})

test('a claim that never yields a controller stays a truthful worker-controller-timeout', async () => {
  const c = uncontrolledContainer({ claims: false })
  let reloads = 0
  const scope = { ...scopeWith(c.container), location: { reload: () => { reloads += 1 } } }

  const result = await ensurePreviewWorkerResult({ scope, timeoutMs: 40, claimTimeoutMs: 20 })

  // ⚠️ The reason must not be softened into something healthier-sounding than
  //    it earned. The page genuinely never got controlled.
  assert.deepEqual(result, { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_CONTROLLER_TIMEOUT })
  assert.deepEqual(c.claimMessages(), [{ type: 'vault-preview-claim' }])
  assert.equal(reloads, 0)
})

test('a silent worker still times out truthfully instead of hanging on the claim reply', async () => {
  const c = uncontrolledContainer({ claims: false, claimReplies: false })
  const result = await ensurePreviewWorkerResult({ scope: scopeWith(c.container), timeoutMs: 40, claimTimeoutMs: 20 })
  assert.deepEqual(result, { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_CONTROLLER_TIMEOUT })
})

test('a controllerchange that arrives with no controller is not mistaken for a takeover', async () => {
  // Some Chromium builds fire controllerchange before the controller is
  // readable. Settling on the first event would report a false timeout while
  // control was in fact one turn away.
  const listeners = new Set()
  let controller = null
  const container = {
    get controller() { return controller },
    async register() {
      return {
        active: {
          postMessage(_m, transfer) {
            queueMicrotask(() => { try { transfer?.[0]?.postMessage({ ok: true }) } catch { /* closed */ } })
            queueMicrotask(() => { for (const fn of listeners) fn({}) })            // null controller
            queueMicrotask(() => {
              controller = { postMessage() {} }
              for (const fn of listeners) fn({})                                    // real takeover
            })
          },
        },
      }
    },
    addEventListener(type, fn) { if (type === 'controllerchange') listeners.add(fn) },
    removeEventListener(_type, fn) { listeners.delete(fn) },
  }

  const result = await ensurePreviewWorkerResult({ scope: scopeWith(container), timeoutMs: 500 })
  assert.equal(result.ok, true)
  assert.equal(result.controller, controller)
})

test('a Vault locked while the claim is in flight never receives a session or a key', async () => {
  const c = uncontrolledContainer()
  let locked = false
  const scope = scopeWith(c.container)

  const result = await ensurePreviewWorkerResult({
    scope,
    timeoutMs: 500,
    isUnlocked: () => !locked,
  })
  assert.equal(result.ok, true, 'sanity: this container does recover when unlocked')

  const c2 = uncontrolledContainer()
  locked = true
  const denied = await ensurePreviewWorkerResult({
    scope: scopeWith(c2.container),
    timeoutMs: 500,
    isUnlocked: () => !locked,
  })
  assert.deepEqual(denied, { ok: false, reason: PREVIEW_FAILURE_REASON.VAULT_LOCKED })
})

test('openPreviewSession refuses to hand a DEK to a Vault that locked during recovery', async () => {
  const c = uncontrolledContainer()
  const scope = scopeWith(c.container)
  let unlocked = true

  const session = await openPreviewSession({
    dek: { fake: 'CryptoKey' },
    blob,
    contentType: 'video/mp4',
    plainSize: 4096,
    scope,
    isUnlocked: () => {
      // The Vault locks exactly once the controller is available — the window
      // this guard exists for.
      const now = unlocked
      unlocked = false
      return now
    },
  })

  assert.deepEqual(session, { ok: false, reason: PREVIEW_FAILURE_REASON.VAULT_LOCKED })
  assert.deepEqual(c.controllerMessages(), [],
    'no vault-preview-open — and therefore no DEK — may be sent after the lock')

  // Sanity: the very same container does deliver a session while unlocked, so
  // the assertion above is proving the lock guard rather than a dead container.
  const c2 = uncontrolledContainer()
  const opened = await openPreviewSession({
    dek: { fake: 'CryptoKey' }, blob, contentType: 'video/mp4', plainSize: 4096,
    scope: scopeWith(c2.container),
  })
  assert.equal(opened.ok, true)
  assert.deepEqual(c2.controllerMessages().map((m) => m.type), ['vault-preview-open'])
  await closePreviewSession(opened.token, { scope: scopeWith(c2.container), controller: c2.controller() })
})
