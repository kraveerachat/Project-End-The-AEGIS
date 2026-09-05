// tests/vaultAutoLockTimer.test.js — AEGIS Drive (IDEA1) · SECURITY-2
//
// The half of SECURITY-2 that needs the real Vault screen: the idle timer is
// armed from the account's saved duration, and the message shown afterwards
// names the duration that actually fired.
//
// The production defect this pins: an account set to 5 minutes was auto-locked
// correctly after 5 minutes, and then told "Vault re-locked after 10 minutes of
// inactivity." The number was a constant in the copy, unrelated to the timer.
//
// Every test below arms the timer through the component itself and fires that
// exact timer, so a message can only be right for the right reason.
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import React, { act } from 'react'

import { makeT, autoLockedMessageKey } from '../src/lib/strings.js'
import { makeVaultBackend, serverBlob, CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import {
  startVaultScreenEnv, settle, click, byText, unlock, lockVault,
} from './helpers/vaultScreenHarness.js'

const t = makeT('en')

let env
let dom
let Vault

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom, Vault } = env)
})

after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
})

let backend
beforeEach(() => {
  backend = makeVaultBackend()
  globalThis.__VAULT_BACKEND__ = backend
})

const html = () => dom.window.document.body.textContent

/** Give the screen an account whose auto-lock is `minutes`. */
function withAutoLock(minutes) {
  backend.state['/api/security/settings'] = {
    loading: false,
    error: null,
    data: {
      settings: {
        vaultAutoLockMinutes: minutes,
        shareDefaults: { expiry: '24h', scope: 'zones', requirePassword: true },
      },
    },
  }
}

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

/**
 * Unlock a vault configured for `minutes`, let its idle timer fire, and return
 * the resulting page text.
 */
async function autoLockAfter(minutes) {
  withAutoLock(minutes)
  backend.state['/api/vault'].data = { configured: true, blobs: [serverBlob({ id: 'blob-a', name: 'REPORT.gif' })] }

  const timers = interceptIdleTimer(minutes * 60_000)
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)

    const live = timers.live()
    assert.equal(live.length, 1, `exactly one ${minutes}-minute idle timer is armed while unlocked`)

    await act(async () => { live[0].fn(...live[0].args) })
    await settle()
  } finally {
    timers.restore()
  }
  const text = html()
  await h.unmount()
  return text
}

// ── AUTOLOCK-8 ───────────────────────────────────────────────────────────────

test('AUTOLOCK-8 the idle timer is armed from the saved setting, one minute included', async () => {
  for (const minutes of [1, 5, 10, 15, 30, 60]) {
    withAutoLock(minutes)
    const timers = interceptIdleTimer(minutes * 60_000)
    const h = env.mount()
    try {
      await h.render(React.createElement(Vault, { t }))
      await unlock(dom, t, CORRECT_PASSPHRASE)
      assert.equal(
        timers.live().length,
        1,
        `an account set to ${minutes} minutes must arm a ${minutes * 60_000} ms timer`,
      )
    } finally {
      timers.restore()
      await h.unmount()
    }
  }
})

test('AUTOLOCK-8b with no resolvable account setting the fallback is used, not a fabricated value', async () => {
  // No /api/security/settings in the backend state at all.
  const timers = interceptIdleTimer(10 * 60_000)
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.equal(timers.live().length, 1, 'the documented 10-minute fallback arms the timer')
  } finally {
    timers.restore()
    await h.unmount()
  }
})

// ── AUTOLOCK-9 ───────────────────────────────────────────────────────────────

test('AUTOLOCK-9 a one-minute timer reports one minute, not ten', async () => {
  const text = await autoLockAfter(1)
  assert.ok(text.includes(t(autoLockedMessageKey(1), { n: 1 })), 'the singular message must be shown')
  assert.ok(text.includes('1 minute of inactivity'))
  // The exact production defect.
  assert.equal(text.includes('10 minutes'), false, 'the old hard-coded 10 must not appear')
  assert.equal(text.includes('1 minutes'), false, 'and never the ungrammatical plural')
})

// ── AUTOLOCK-10 ──────────────────────────────────────────────────────────────

test('AUTOLOCK-10 a five-minute timer reports five minutes', async () => {
  const text = await autoLockAfter(5)
  assert.ok(text.includes('5 minutes of inactivity'))
  assert.equal(text.includes('10 minutes'), false)
})

test('AUTOLOCK-10b every allowed duration reports itself', async () => {
  for (const minutes of [15, 30, 60]) {
    const text = await autoLockAfter(minutes)
    assert.ok(text.includes(`${minutes} minutes of inactivity`), `${minutes} must report itself`)
  }
})

test('AUTOLOCK-10c the message describes the timer that fired, not a later setting', async () => {
  // Arm at 5 minutes, then have the account report 30 before the timer fires.
  // The message must still say 5: it is describing the timer that expired.
  withAutoLock(5)
  const timers = interceptIdleTimer(5 * 60_000)
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    const live = timers.live()
    assert.equal(live.length, 1)

    withAutoLock(30) // the account changes elsewhere; this timer is already armed
    await act(async () => { live[0].fn(...live[0].args) })
    await settle()

    assert.ok(html().includes('5 minutes of inactivity'), 'the fired timer was the 5-minute one')
    assert.equal(html().includes('30 minutes of inactivity'), false)
  } finally {
    timers.restore()
    await h.unmount()
  }
})

// ── AUTOLOCK-13 ──────────────────────────────────────────────────────────────

test('AUTOLOCK-13 interaction still resets the timer, at one minute too', async () => {
  withAutoLock(1)
  const timers = interceptIdleTimer(60_000)
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.equal(timers.live().length, 1, 'one timer armed on unlock')

    // Each approved activity cancels the armed timer and arms a fresh one.
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      const before = timers.live()[0]
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event(type, { bubbles: true }))
      })
      const live = timers.live()
      assert.equal(live.length, 1, `${type} must leave exactly one timer armed`)
      assert.notEqual(live[0], before, `${type} must replace the armed timer, not leave it running`)
      assert.equal(before.cancelled, true, `${type} must cancel the previous timer`)
    }

    // Still unlocked: resetting the timer must never lock the vault.
    assert.ok(byText(dom, 'button', t('lockVault')), 'the vault stays unlocked while the user is active')
    assert.equal(html().includes('of inactivity'), false, 'no auto-lock message while active')
  } finally {
    timers.restore()
    await h.unmount()
  }
})

// ── AUTOLOCK-14 ──────────────────────────────────────────────────────────────

test('AUTOLOCK-14 a manual Lock never renders the auto-lock message', async () => {
  withAutoLock(1)
  backend.state['/api/vault'].data = { configured: true, blobs: [serverBlob({ id: 'blob-a', name: 'REPORT.gif' })] }

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await lockVault(dom, t)
    await settle()

    // Locked by the button, so no duration was reached and none may be claimed.
    assert.equal(byText(dom, 'button', t('lockVault')), undefined, 'the vault is locked')
    assert.equal(html().includes('of inactivity'), false, 'a manual lock is not an auto-lock')
    assert.equal(html().includes('1 minute of inactivity'), false)
    assert.equal(html().includes('10 minutes'), false)
  } finally {
    await h.unmount()
  }
})

test('AUTOLOCK-14b unlocking again clears a previous auto-lock message', async () => {
  const text = await autoLockAfter(1)
  assert.ok(text.includes('1 minute of inactivity'), 'precondition: the message was shown')

  withAutoLock(1)
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await settle()
    assert.equal(html().includes('of inactivity'), false, 'a fresh unlock must not keep announcing the old lock')
  } finally {
    await h.unmount()
  }
})
