import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PREVIEW_FAILURE_REASON, previewFailureGroup, previewFailureCopyKey,
} from '../src/lib/vaultPreviewErrors.js'

test('all E3.1 failure reasons are explicit and grouped truthfully', () => {
  assert.deepEqual(Object.values(PREVIEW_FAILURE_REASON).sort(), [
    'chunk-fetch-failed', 'integrity-failed', 'media-playback-failed', 'range-invalid',
    'unsupported-browser', 'worker-controller-timeout', 'worker-registration-failed',
    'worker-session-lost', 'worker-session-open-failed', 'worker-session-rehydrate-failed',
  ].sort())

  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.UNSUPPORTED_BROWSER), 'unsupported')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.WORKER_SESSION_LOST), 'temporary')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED), 'network')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.INTEGRITY_FAILED), 'integrity')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.RANGE_INVALID), 'range')
  assert.equal(previewFailureGroup(PREVIEW_FAILURE_REASON.MEDIA_PLAYBACK_FAILED), 'playback')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.WORKER_REGISTRATION_FAILED), 'vaultPreviewTemporaryFailure')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED), 'vaultPreviewNetworkFailure')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.INTEGRITY_FAILED), 'vaultPreviewIntegrityFailed')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.RANGE_INVALID), 'vaultPreviewRangeFailure')
  assert.equal(previewFailureCopyKey(PREVIEW_FAILURE_REASON.MEDIA_PLAYBACK_FAILED), 'vaultPreviewPlaybackFailure')
})
