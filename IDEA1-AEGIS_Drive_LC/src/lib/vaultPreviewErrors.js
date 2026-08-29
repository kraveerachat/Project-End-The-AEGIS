/** Explicit public failure contract for large encrypted video preview. */
export const PREVIEW_FAILURE_REASON = Object.freeze({
  UNSUPPORTED_BROWSER: 'unsupported-browser',
  WORKER_REGISTRATION_FAILED: 'worker-registration-failed',
  WORKER_CONTROLLER_TIMEOUT: 'worker-controller-timeout',
  WORKER_SESSION_OPEN_FAILED: 'worker-session-open-failed',
  WORKER_SESSION_LOST: 'worker-session-lost',
  WORKER_SESSION_REHYDRATE_FAILED: 'worker-session-rehydrate-failed',
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
