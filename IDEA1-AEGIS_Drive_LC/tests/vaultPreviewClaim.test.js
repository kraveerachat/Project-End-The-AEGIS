// tests/vaultPreviewClaim.test.js — AEGIS Drive (IDEA1) · LFT-V2-E3.2
//
// ⚠️ The claim handshake is the recovery path for a production lifecycle bug:
//    registration.active activated, navigator.serviceWorker.controller null,
//    <video> requests bypassing the worker entirely. The page must not have to
//    be reloaded by hand, and it must not be reloaded automatically either.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PREVIEW_CLAIM_MESSAGE, isPreviewClaimRequest, handlePreviewClaimRequest,
} from '../src/lib/vaultPreviewClaim.js'

test('the claim request is one named message, recognised exactly', () => {
  assert.equal(PREVIEW_CLAIM_MESSAGE, 'vault-preview-claim')
  assert.equal(isPreviewClaimRequest({ type: PREVIEW_CLAIM_MESSAGE }), true)
  assert.equal(isPreviewClaimRequest({ type: 'vault-preview-open' }), false)
  assert.equal(isPreviewClaimRequest(null), false)
  assert.equal(isPreviewClaimRequest('vault-preview-claim'), false)
})

test('a successful claim takes control, replies ok, and is kept alive by waitUntil', async () => {
  const replies = []
  const extended = []
  let claimed = 0
  const ok = await handlePreviewClaimRequest({
    clients: { claim: async () => { claimed += 1 } },
    reply: (payload) => replies.push(payload),
    waitUntil: (promise) => extended.push(promise),
  })

  assert.equal(ok, true)
  assert.equal(claimed, 1, 'clients.claim() is what actually takes over the open page')
  assert.deepEqual(replies, [{ ok: true }])
  assert.equal(extended.length, 1, 'the worker must stay alive until the claim settles')
  await extended[0]
})

test('a rejected claim answers truthfully and never rejects into waitUntil', async () => {
  // ⚠️ An unhandled rejection handed to waitUntil can terminate a worker that
  //    is holding keys for a live preview. It must be neutralised here.
  const replies = []
  const extended = []
  const ok = await handlePreviewClaimRequest({
    clients: { claim: async () => { throw new Error('claim refused') } },
    reply: (payload) => replies.push(payload),
    waitUntil: (promise) => extended.push(promise),
  })

  assert.equal(ok, false)
  assert.deepEqual(replies, [{ ok: false }])
  await assert.doesNotReject(extended[0])
})

test('a claim that throws synchronously is answered rather than escaping the handler', async () => {
  const replies = []
  const ok = await handlePreviewClaimRequest({
    clients: { claim: () => { throw new Error('no clients') } },
    reply: (payload) => replies.push(payload),
  })
  assert.equal(ok, false)
  assert.deepEqual(replies, [{ ok: false }])
})

test('a worker with no clients.claim answers false instead of hanging the page', async () => {
  const replies = []
  assert.equal(await handlePreviewClaimRequest({ clients: {}, reply: (p) => replies.push(p) }), false)
  assert.equal(await handlePreviewClaimRequest({ reply: (p) => replies.push(p) }), false)
  assert.equal(await handlePreviewClaimRequest(), false, 'no options at all must not throw')
  assert.deepEqual(replies, [{ ok: false }, { ok: false }])
})

test('a synchronous claim implementation still counts as claimed', async () => {
  const replies = []
  assert.equal(await handlePreviewClaimRequest({
    clients: { claim: () => undefined },
    reply: (p) => replies.push(p),
  }), true)
  assert.deepEqual(replies, [{ ok: true }])
})

test('a non-extendable event does not break the claim', async () => {
  const replies = []
  const ok = await handlePreviewClaimRequest({
    clients: { claim: async () => {} },
    reply: (payload) => replies.push(payload),
    waitUntil: () => { throw new TypeError('event is not extendable') },
  })
  assert.equal(ok, true)
  assert.deepEqual(replies, [{ ok: true }])
})
