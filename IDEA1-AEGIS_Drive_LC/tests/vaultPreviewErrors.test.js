import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PREVIEW_FAILURE_REASON, previewFailureGroup, previewFailureCopyKey,
  PREVIEW_CANCELLATION, markPreviewCancellation, previewCancellationKind,
  isPreviewAbortError, isBenignPreviewCancellation,
  previewRequestCanceledError, previewSessionInvalidatedError,
} from '../src/lib/vaultPreviewErrors.js'

test('all E3.1 failure reasons are explicit and grouped truthfully', () => {
  assert.deepEqual(Object.values(PREVIEW_FAILURE_REASON).sort(), [
    'chunk-fetch-failed', 'integrity-failed', 'media-playback-failed', 'range-invalid',
    'unsupported-browser', 'vault-locked', 'worker-controller-timeout',
    'worker-registration-failed', 'worker-session-lost', 'worker-session-open-failed',
    'worker-session-rehydrate-failed',
  ].sort())

  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.UNSUPPORTED_BROWSER), 'unsupported')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.WORKER_SESSION_LOST), 'temporary')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED), 'network')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.INTEGRITY_FAILED), 'integrity')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.RANGE_INVALID), 'range')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.MEDIA_PLAYBACK_FAILED), 'playback')
  // A Vault locked while claim recovery is in flight is a temporary, honest
  // state — it reuses the existing temporary copy and adds no new user string.
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.VAULT_LOCKED), 'temporary')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.VAULT_LOCKED), 'vaultPreviewTemporaryFailure')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.WORKER_REGISTRATION_FAILED), 'vaultPreviewTemporaryFailure')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED), 'vaultPreviewNetworkFailure')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.INTEGRITY_FAILED), 'vaultPreviewIntegrityFailed')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.RANGE_INVALID), 'vaultPreviewRangeFailure')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.MEDIA_PLAYBACK_FAILED), 'vaultPreviewPlaybackFailure')
})

// ── LFT-V2-E3.2 · cancellation is not failure ───────────────────────────────
//
// ⚠️ This block is the whole safety argument of the E3.2 fix. If any of these
//    inverts, the browser can either drown the user in false network errors
//    (the production symptom) or — far worse — a genuine integrity failure or a
//    real aborted transfer could be swallowed as "just a cancellation".

test('a canceled Range response is benign — no failure is derived from it', () => {
  const err = previewRequestCanceledError()
  assert.equal(previewCancellationKind(err), PREVIEW_CANCELLATION.REQUEST)
  assert.equal(isPreviewAbortError(err), true)
  assert.equal(isBenignPreviewCancellation(err, { requestCanceled: true }), true)

  // Chromium does not always surface a tidy AbortError for a response it tore
  // down. Once this response is canceled nothing it produces can reach the
  // player, so nothing it produces may fail the preview either.
  const messy = new TypeError('Failed to fetch')
  assert.equal(isBenignPreviewCancellation(messy, { requestCanceled: true }), true)
})

test('deliberate session teardown is benign wherever it surfaces', () => {
  const err = previewSessionInvalidatedError()
  assert.equal(previewCancellationKind(err), PREVIEW_CANCELLATION.SESSION)
  assert.equal(isBenignPreviewCancellation(err), true, 'close/lock/replacement is user intent')
  assert.equal(isBenignPreviewCancellation(err, { sessionInvalidated: true }), true)
})

test('a bare AbortError with no cancellation context is a real failure', () => {
  // ⚠️ The single most dangerous simplification available here would be
  //    "every AbortError is benign". A transfer aborted by anything other than
  //    this response or this session is a genuine fault the user must be told
  //    about, so it must stay reportable.
  const bare = new DOMException('aborted', 'AbortError')
  assert.equal(isPreviewAbortError(bare), true)
  assert.equal(previewCancellationKind(bare), null)
  assert.equal(isBenignPreviewCancellation(bare), false)
  assert.equal(isBenignPreviewCancellation(new TypeError('Failed to fetch')), false)
})

test('integrity failure is never benign, not even on a canceled or torn-down response', () => {
  const integrity = markPreviewCancellation(
    Object.assign(new Error('chunk auth failed'), {
      previewFailure: PREVIEW_FAILURE_REASON.INTEGRITY_FAILED,
    }),
    PREVIEW_CANCELLATION.REQUEST,
  )
  assert.equal(isBenignPreviewCancellation(integrity, { requestCanceled: true }), false)
  assert.equal(isBenignPreviewCancellation(integrity, { sessionInvalidated: true }), false)
})

test('an unmarkable error still classifies without throwing', () => {
  assert.equal(previewCancellationKind(markPreviewCancellation(null, PREVIEW_CANCELLATION.REQUEST)), null)
  assert.equal(previewCancellationKind('nope'), null)
  assert.equal(isPreviewAbortError(undefined), false)
  assert.equal(isBenignPreviewCancellation(undefined), false)
  assert.equal(previewCancellationKind({ previewCancellation: 'made-up' }), null)
})
