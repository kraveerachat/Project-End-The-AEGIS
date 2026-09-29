// tests/vaultPlainChunkStream.test.js — AEGIS Drive (IDEA1) · PR220-R2 · pull adapter over downloadVaultV2
//
//   PCS-1  chunks arrive in order; at most one decrypted chunk waits (one-chunk hand-off)
//   PCS-2  return() aborts the download at once; nothing further is produced
//   PCS-3  a failed download surfaces as an error on the next pull (never a short image)
//   PCS-4  the caller's signal aborts both producer and a waiting consumer
import test from 'node:test'
import assert from 'node:assert/strict'
import { openVaultPlainChunks } from '../src/lib/vaultPlainChunkStream.js'

function producer(chunks, { fail = null } = {}) {
  const state = { written: 0, maxWaiting: 0, waiting: 0, signal: null }
  const run = async (sink, signal) => {
    state.signal = signal
    for (const c of chunks) {
      if (signal.aborted) return { ok: false, reason: 'cancelled' }
      state.waiting += 1
      state.maxWaiting = Math.max(state.maxWaiting, state.waiting)
      try { await sink.write(c) } catch { return { ok: false, reason: 'cancelled' } } finally { state.waiting -= 1 }
      state.written += 1
    }
    if (fail) return { ok: false, reason: fail }
    return { ok: true }
  }
  return { run, state }
}

test('PCS-1 in-order pull with a one-chunk hand-off', async () => {
  const p = producer([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])])
  const it = openVaultPlainChunks({ run: p.run })
  const got = []
  for (;;) { const s = await it.next(); if (s.done) break; got.push(s.value[0]) }
  assert.deepEqual(got, [1, 2, 3])
  assert.equal(p.state.maxWaiting, 1, 'never more than one chunk waiting for the consumer')
})

test('PCS-2 return() aborts the download immediately', async () => {
  const p = producer([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])])
  const it = openVaultPlainChunks({ run: p.run })
  await it.next()
  await it.return()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(p.state.signal.aborted, true)
  assert.ok(p.state.written <= 2, `download stopped early (written ${p.state.written})`)
})

test('PCS-3 a failed download is an error on the next pull', async () => {
  const p = producer([new Uint8Array([1])], { fail: 'auth-failed' })
  const it = openVaultPlainChunks({ run: p.run })
  assert.equal((await it.next()).value[0], 1)
  await assert.rejects(it.next(), (e) => e.code === 'auth-failed')
})

test('PCS-4 the caller signal aborts a waiting consumer and the producer', async () => {
  const ctrl = new AbortController()
  let release
  const run = async (sink, signal) => { await new Promise((r) => { release = r; signal.addEventListener('abort', r) }); return { ok: false, reason: 'cancelled' } }
  const it = openVaultPlainChunks({ run, signal: ctrl.signal })
  const pulling = it.next()
  ctrl.abort()
  await assert.rejects(pulling, (e) => e.name === 'AbortError')
  release?.()
})
