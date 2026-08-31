/** Explicit public failure contract for large encrypted video preview. */
export const PREVIEW_FAILURE_REASON = Object.freeze({
  UNSUPPORTED_BROWSER: 'unsupported-browser',
  WORKER_REGISTRATION_FAILED: 'worker-registration-failed',
  WORKER_CONTROLLER_TIMEOUT: 'worker-controller-timeout',
  WORKER_SESSION_OPEN_FAILED: 'worker-session-open-failed',
  WORKER_SESSION_LOST: 'worker-session-lost',
  WORKER_SESSION_REHYDRATE_FAILED: 'worker-session-rehydrate-failed',
  VAULT_LOCKED: 'vault-locked',
  CHUNK_FETCH_FAILED: 'chunk-fetch-failed',
  INTEGRITY_FAILED: 'integrity-failed',
  RANGE_INVALID: 'range-invalid',
  MEDIA_PLAYBACK_FAILED: 'media-playback-failed',
})

const TEMPORARY = new Set([
  PREVIEW_FAILURE_REASON.WORKER_REGISTRATION_FAILED,
  PREVIEW_FAILURE_REASON.WORKER_CONTROLLER_TIMEOUT,
  PREVIEW_FAILURE_REASON.WORKER_SESSION_OPEN_FAILED,
  PREVIEW_FAILURE_REASON.WORKER_SESSION_LOST,
  PREVIEW_FAILURE_REASON.WORKER_SESSION_REHYDRATE_FAILED,
  PREVIEW_FAILURE_REASON.VAULT_LOCKED,
])

export function previewFailureGroup(reason) {
  if (reason === PREVIEW_FAILURE_REASON.UNSUPPORTED_BROWSER) return 'unsupported'
  if (TEMPORARY.has(reason)) return 'temporary'
  if (reason === PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED) return 'network'
  if (reason === PREVIEW_FAILURE_REASON.INTEGRITY_FAILED) return 'integrity'
  if (reason === PREVIEW_FAILURE_REASON.RANGE_INVALID) return 'range'
  return 'playback'
}

export function previewFailureCopyKey(reason) {
  switch (previewFailureGroup(reason)) {
    case 'unsupported': return 'vaultPreviewUnsupportedBrowser'
    case 'temporary': return 'vaultPreviewTemporaryFailure'
    case 'network': return 'vaultPreviewNetworkFailure'
    case 'integrity': return 'vaultPreviewIntegrityFailed'
    case 'range': return 'vaultPreviewRangeFailure'
    default: return 'vaultPreviewPlaybackFailure'
  }
}

// ── Cancellation is not failure (LFT-V2-E3.2) ───────────────────────────────
//
// ⚠️ Chromium routinely opens several overlapping media Range requests, keeps
//    the one it wants and cancels the rest. Reporting a canceled response as a
//    network failure marks the whole preview broken while playback is in fact
//    healthy — that is the exact production symptom this taxonomy removes.
//
//    Two cancellations are legitimate and each is attributable to a concrete
//    deliberate act, never to the network:
//      REQUEST — the media element superseded/canceled this one response
//      SESSION — close preview, Vault lock, closeAll, or session replacement
export const PREVIEW_CANCELLATION = Object.freeze({
  REQUEST: 'preview-request-canceled',
  SESSION: 'preview-session-invalidated',
})

/** Stamp an error so a later handler can tell deliberate teardown from a fault. */
export function markPreviewCancellation(error, kind) {
  if (error && typeof error === 'object') {
    try { error.previewCancellation = kind } catch { /* frozen error — read below */ }
  }
  return error
}

export function previewCancellationKind(error) {
  const kind = error?.previewCancellation
  return kind === PREVIEW_CANCELLATION.REQUEST || kind === PREVIEW_CANCELLATION.SESSION
    ? kind
    : null
}

/** AbortError in either DOMException or plain-Error shape. */
export function isPreviewAbortError(error) {
  if (!error || typeof error !== 'object') return false
  return error.name === 'AbortError' || error.code === 20
}

/**
 * Is this stream error a benign cancellation rather than a reportable failure?
 *
 * ⚠️ The order of these rules is the whole security argument:
 *
 *    1. Integrity is never benign. A chunk that failed authentication is a
 *       statement about the stored bytes, not about who canceled what, so it
 *       stays fatal even on a response nobody is reading any more.
 *    2. A response that this browser canceled is gone: none of its bytes and
 *       none of its errors can reach the player, so nothing about it may
 *       change global preview state. This is the superseded-Range case.
 *    3. An error explicitly marked as deliberate teardown is benign wherever
 *       it surfaces, because close/lock/replacement are user intent.
 *    4. Everything else — including a bare AbortError with no cancellation
 *       context — is a real failure and must still be reported. Treating
 *       *every* AbortError as benign would hide genuine aborted transfers.
 */
export function isBenignPreviewCancellation(error, {
  requestCanceled = false,
  sessionInvalidated = false,
} = {}) {
  if (error?.previewFailure === PREVIEW_FAILURE_REASON.INTEGRITY_FAILED) return false
  if (requestCanceled || sessionInvalidated) return true
  return previewCancellationKind(error) !== null
}

/** The AbortSignal reason used when one Range response is canceled. */
export function previewRequestCanceledError(message = 'preview range canceled') {
  return markPreviewCancellation(abortShapedError(message), PREVIEW_CANCELLATION.REQUEST)
}

/** The AbortSignal reason used when a preview session is torn down. */
export function previewSessionInvalidatedError(message = 'preview session closed') {
  return markPreviewCancellation(abortShapedError(message), PREVIEW_CANCELLATION.SESSION)
}

function abortShapedError(message) {
  if (typeof DOMException === 'function') {
    try { return new DOMException(message, 'AbortError') } catch { /* fall through */ }
  }
  return Object.assign(new Error(message), { name: 'AbortError' })
}
