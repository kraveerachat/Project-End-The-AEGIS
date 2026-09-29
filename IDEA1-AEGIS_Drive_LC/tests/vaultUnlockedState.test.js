// tests/vaultUnlockedState.test.js — AEGIS Drive (IDEA1) · PR #157 Task 5.4 · unlocked-state registry + purgeUnlockedVaultState(reason) (US-1..US-7)
//
// US-1..US-4 = โมดูลล้วน; US-5..US-7 = จอ Vault จริงผ่าน vaultScreenHarness (jsdom + vite) พร้อม storage guards
// ⚠️ ไม่มีที่ใดในชุดนี้อ้างว่า "ล้าง RAM จริง": droppedBuffers = fill(0) + ปล่อย reference เท่านั้น (ดูหัวไฟล์ของโมดูล)
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { installStorageGuards } from './helpers/vaultTreeFixtures.mjs'
import { makeT } from '../src/lib/strings.js'
import { makeVaultBackend, serverBlob, CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import { startVaultScreenEnv, settle, unlock, lockVault, byText } from './helpers/vaultScreenHarness.js'

const guards = installStorageGuards()
const { createUnlockedVaultState, PURGE_REASONS, UnlockedStateError } = await import('../src/lib/vaultUnlockedState.js')
const { onSessionEnded, notifySessionEnded } = await import('../src/lib/sessionEnded.js')

function make(overrides = {}) {
  const calls = { revoked: [], closedAll: 0, closedTokens: [] }
  const state = createUnlockedVaultState({
    revokeObjectUrl: (u) => calls.revoked.push(u),
    closeAllPreviewSessions: () => { calls.closedAll += 1; return Promise.resolve(true) },
    ...overrides,
  })
  return { state, calls }
}

test('US-1 purge(reason) performs, in order: abort → invalidateMutations → disposers → revoke URLs → close preview sessions (once) → drop keys → drop buffers; returns the report', () => {
  const { state, calls } = make()
  const order = []
  const ctrl = new AbortController(); ctrl.signal.addEventListener('abort', () => order.push('abort'))
  state.registerAbort(ctrl)
  const token = state.mutationToken()
  state.registerDisposer(() => { order.push('disposer'); assert.equal(state.isMutationValid(token), false, 'mutations invalidated before disposers run') })
  state.registerObjectUrl('blob:one'); state.registerObjectUrl('blob:two')
  state.registerPreviewToken('tok-a'); state.registerPreviewToken('tok-b')
  const keyRef = { trk: { fake: 'CryptoKey' }, kek: { fake: 'CryptoKey' } }
  state.registerKey(keyRef)
  const buf = new Uint8Array([1, 2, 3, 4]); const bufRef = { bytes: buf }
  state.registerBuffer(bufRef)
  const revoke = state.__hooks.revokeObjectUrl
  state.__hooks.revokeObjectUrl = (u) => { order.push('revoke'); revoke(u) }
  state.__hooks.closeAllPreviewSessions = () => { order.push('closeAll'); calls.closedAll += 1; return Promise.resolve(true) }
  const report = state.purge(PURGE_REASONS.MANUAL_LOCK)
  assert.deepEqual(report, { reason: 'MANUAL_LOCK', abortedFetches: 1, revokedUrls: 2, closedTokens: 2, droppedKeys: 1, droppedBuffers: 1, disposers: 1, alreadyPurged: false })
  assert.deepEqual(order, ['abort', 'disposer', 'revoke', 'revoke', 'closeAll'])
  assert.deepEqual(calls.revoked, ['blob:one', 'blob:two']); assert.equal(calls.closedAll, 1)
  assert.deepEqual(keyRef, { trk: null, kek: null }, 'key references dropped in place')
  assert.deepEqual([...buf], [0, 0, 0, 0]); assert.equal(bufRef.bytes, null)
  assert.equal(state.isPurged(), true)
})

test('US-2 idempotent: a second purge returns alreadyPurged=true and performs nothing; registrations after purge throw', () => {
  const { state, calls } = make()
  const ctrl = new AbortController(); state.registerAbort(ctrl)
  state.registerObjectUrl('blob:x')
  state.purge(PURGE_REASONS.AUTO_LOCK)
  const second = state.purge(PURGE_REASONS.LOGOUT)
  assert.deepEqual(second, { reason: 'LOGOUT', abortedFetches: 0, revokedUrls: 0, closedTokens: 0, droppedKeys: 0, droppedBuffers: 0, disposers: 0, alreadyPurged: true })
  assert.equal(calls.revoked.length, 1); assert.equal(calls.closedAll, 1)
  for (const [name, fn] of [['registerAbort', () => state.registerAbort(new AbortController())], ['registerObjectUrl', () => state.registerObjectUrl('blob:y')], ['registerPreviewToken', () => state.registerPreviewToken('t')], ['registerKey', () => state.registerKey({})], ['registerBuffer', () => state.registerBuffer({ bytes: new Uint8Array(1) })], ['registerDisposer', () => state.registerDisposer(() => {})]]) {
    assert.throws(fn, (e) => e instanceof UnlockedStateError && e.code === 'PURGED', name)
  }
  assert.equal(state.isMutationValid(state.mutationToken()), false, 'no mutation is ever valid after purge')
})

test('US-3 every PURGE_REASONS value is accepted; an unknown reason throws (before anything is touched)', () => {
  assert.deepEqual(Object.keys(PURGE_REASONS).sort(), ['AUTO_LOCK', 'LOGOUT', 'MANUAL_LOCK', 'NAVIGATION', 'PAGE_HIDE', 'SESSION_INVALIDATED', 'UNMOUNT'])
  for (const reason of Object.values(PURGE_REASONS)) {
    const { state } = make()
    assert.equal(state.purge(reason).reason, reason)
  }
  const { state, calls } = make()
  state.registerObjectUrl('blob:keep')
  for (const bad of ['LOCK', '', null, undefined, 42]) assert.throws(() => state.purge(bad), (e) => e instanceof UnlockedStateError && e.code === 'BAD_REASON')
  assert.equal(state.isPurged(), false); assert.equal(calls.revoked.length, 0, 'a rejected purge touched nothing')
})

test('US-4 registered buffers are zero-filled best-effort and dereferenced; the report says droppedBuffers and the module header states the limitation', async () => {
  const { state } = make()
  const a = new Uint8Array([9, 9, 9]), b = new Uint8Array(0), c = { bytes: new Uint8Array([7]) }
  const refA = { bytes: a }, refB = { bytes: b }
  state.registerBuffer(refA); state.registerBuffer(refB); state.registerBuffer(c)
  const detached = { bytes: new Uint8Array(new ArrayBuffer(8)) }
  detached.bytes.buffer.transfer?.() // detach where supported — fill must not throw on it
  state.registerBuffer(detached)
  const report = state.purge(PURGE_REASONS.UNMOUNT)
  assert.equal(report.droppedBuffers, 4)
  assert.deepEqual([...a], [0, 0, 0]); assert.equal(refA.bytes, null); assert.equal(refB.bytes, null); assert.equal(c.bytes, null)
  assert.equal('erasedBytes' in report, false); assert.equal('zeroized' in report, false)
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../src/lib/vaultUnlockedState.js', import.meta.url), 'utf8')
  assert.match(src.split('\n').slice(0, 30).join('\n'), /best-effort|ไม่รับประกัน|not.*guarantee/i)
  assert.match(src, /physical|RAM|หน่วยความจำจริง/)
})

test('US-5a api.js emits SESSION_INVALIDATED on a 401 (unless suppressed) and on PASSWORD_RESET_REQUIRED; auth.logout emits LOGOUT', async () => {
  const { apiFetch, apiFetchBytes } = await import('../src/lib/api.js')
  const { logout } = await import('../src/lib/auth.js')
  const seen = []
  const off = onSessionEnded((reason) => seen.push(reason))
  const origFetch = globalThis.fetch
  let status = 401, body = { error: 'unauthorized' }
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  try {
    await apiFetch('/api/vault')
    assert.deepEqual(seen, ['SESSION_INVALIDATED'])
    await apiFetch('/api/me', { suppressAuthHandler: true })
    assert.deepEqual(seen, ['SESSION_INVALIDATED'], 'suppressed probes do not end the session')
    await apiFetchBytes('/api/vault/blobs/1')
    assert.deepEqual(seen, ['SESSION_INVALIDATED', 'SESSION_INVALIDATED'])
    status = 403; body = { error: 'PASSWORD_RESET_REQUIRED' }
    await apiFetch('/api/vault')
    assert.deepEqual(seen.at(-1), 'SESSION_INVALIDATED')
    status = 200; body = { ok: true }
    await logout()
    assert.deepEqual(seen.at(-1), 'LOGOUT')
    off()
    status = 401; body = { error: 'unauthorized' }
    await apiFetch('/api/vault')
    assert.equal(seen.length, 4, 'unsubscribed')
  } finally { globalThis.fetch = origFetch }
})

// ── screen-level (US-5b, US-6, US-7) ─────────────────────────────────────────
const t = makeT('en')
let env, dom, Vault, sessionEnded, winGuards
before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom, Vault } = env)
  sessionEnded = await env.load('/src/lib/sessionEnded.js')
  winGuards = installStorageGuards(dom.window)
})
after(async () => { await env?.stop(); delete globalThis.__VAULT_BACKEND__ })
let backend
beforeEach(() => { backend = makeVaultBackend(); globalThis.__VAULT_BACKEND__ = backend })

const SECRET_NAMES = ['REPORT-CONFIDENTIAL.gif', 'merger-plan.gif']
function withVault() {
  backend.state['/api/vault'].data = { configured: true, blobs: [serverBlob({ id: 'blob-a', name: SECRET_NAMES[0] }), serverBlob({ id: 'blob-b', name: SECRET_NAMES[1] })] }
  backend.state['/api/security/settings'] = { loading: false, error: null, data: { settings: { vaultAutoLockMinutes: 1, shareDefaults: { expiry: '24h', scope: 'zones', requirePassword: true } } } }
}
/** spy factory: records every purge on every state the screen creates */
function spyFactory() {
  const purges = []
  const states = []
  const factory = (opts) => {
    const s = createUnlockedVaultState(opts)
    const orig = s.purge
    s.purge = (reason) => { const r = orig(reason); purges.push({ reason, alreadyPurged: r.alreadyPurged }); return r }
    states.push(s)
    return s
  }
  return { factory, purges, states, live: () => purges.filter((p) => !p.alreadyPurged) }
}
/** the idle timer of the screen — same interception as vaultAutoLockTimer.test.js (global setTimeout) */
/**
 * Intercept ONLY the idle-lock delay, leaving every other timer (shake reset,
 * blob-URL revoke, React's scheduler) running normally so nothing else about the
 * screen is simulated away.
 *
 * Returns the armed handles plus a restore function.
 */
function interceptIdleTimer(expectedMs) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const armed = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === expectedMs) {
      const handle = { fn, args, cancelled: false }
      armed.push(handle)
      return handle
    }
    return realSetTimeout(fn, ms, ...args)
  }
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object' && 'cancelled' in handle) {
      handle.cancelled = true
      return
    }
    return realClearTimeout(handle)
  }
  return {
    armed,
    live: () => armed.filter((timer) => !timer.cancelled),
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

const text = () => dom.window.document.body.textContent

test('US-5b Vault.jsx: manual Lock → purge(MANUAL_LOCK) once; auto-lock → AUTO_LOCK once; unmount → UNMOUNT once; session end → LOGOUT / SESSION_INVALIDATED; pagehide → PAGE_HIDE', async () => {
  withVault()
  // manual lock
  let spy = spyFactory()
  let h = env.mount()
  await h.render(React.createElement(Vault, { t, unlockedStateFactory: spy.factory }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  assert.equal(spy.states.length, 1, 'one unlocked state per unlock')
  await lockVault(dom, t)
  assert.deepEqual(spy.live().map((p) => p.reason), ['MANUAL_LOCK'])
  await h.unmount()
  assert.deepEqual(spy.live().map((p) => p.reason), ['MANUAL_LOCK'], 'unmount after lock does not purge a dead state again')
  // auto lock
  spy = spyFactory()
  const timers = interceptIdleTimer(60_000)
  h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t, unlockedStateFactory: spy.factory }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    const armed = timers.live(); assert.equal(armed.length, 1)
    await act(async () => { armed[0].fn(...armed[0].args) }); await settle()
    assert.deepEqual(spy.live().map((p) => p.reason), ['AUTO_LOCK'])
  } finally { timers.restore(); await h.unmount() }
  assert.deepEqual(spy.live().map((p) => p.reason), ['AUTO_LOCK'])
  // unmount while unlocked
  spy = spyFactory(); h = env.mount()
  await h.render(React.createElement(Vault, { t, unlockedStateFactory: spy.factory }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await h.unmount()
  assert.deepEqual(spy.live().map((p) => p.reason), ['UNMOUNT'])
  // logout / 401 via the session-end listener (the same module instance the screen subscribed to)
  for (const [emit, expected] of [['LOGOUT', 'LOGOUT'], ['SESSION_INVALIDATED', 'SESSION_INVALIDATED']]) {
    spy = spyFactory(); h = env.mount()
    await h.render(React.createElement(Vault, { t, unlockedStateFactory: spy.factory }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await act(async () => { sessionEnded.notifySessionEnded(emit) }); await settle()
    assert.deepEqual(spy.live().map((p) => p.reason), [expected], emit)
    assert.ok(byText(dom, 'button', t('unlockVault')), `${emit}: the screen is locked afterwards`)
    await h.unmount()
    assert.deepEqual(spy.live().map((p) => p.reason), [expected])
  }
  // pagehide (best-effort)
  spy = spyFactory(); h = env.mount()
  await h.render(React.createElement(Vault, { t, unlockedStateFactory: spy.factory }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('pagehide')) }); await settle()
  assert.deepEqual(spy.live().map((p) => p.reason), ['PAGE_HIDE'])
  await h.unmount()
})

test('US-6 after purge no DOM node contains a decrypted name and the locked veil renders {id}.aegisenc', async () => {
  withVault()
  const spy = spyFactory()
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t, unlockedStateFactory: spy.factory }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    for (const n of SECRET_NAMES) assert.ok(text().includes(n), `unlocked shows ${n}`)
    await lockVault(dom, t)
    const html = dom.window.document.body.innerHTML
    for (const n of SECRET_NAMES) assert.equal(html.includes(n), false, `locked DOM must not contain ${n}`)
    assert.ok(html.includes('blob-a.aegisenc') && html.includes('blob-b.aegisenc'), 'locked veil')
    assert.equal(spy.states[0].isPurged(), true)
  } finally { await h.unmount() }
})

test('US-7 storage absence: instrumented localStorage/sessionStorage/indexedDB/caches record zero writes across the whole screen suite', () => {
  assert.equal(guards.writes, 0); assert.equal(winGuards.writes, 0)
})
