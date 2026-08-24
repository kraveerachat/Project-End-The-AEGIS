// Cold AI startup and a stalled live stream are different failure modes.
// YOLO+SFace may need tens of seconds before its first annotated JPEG, while
// an established stream should still fail quickly if frames stop arriving.
export const STREAM_FIRST_BYTE_MS = 50_000
export const STREAM_IDLE_MS = 6_000

export function streamWatchdogDelay(hasReceivedData) {
  return hasReceivedData ? STREAM_IDLE_MS : STREAM_FIRST_BYTE_MS
}

// ReadableStream.cancel() returns a promise. A synchronous try/catch cannot
// absorb a later AbortError, so always await it behind this no-throw boundary.
export async function cancelStreamReaderQuietly(reader) {
  if (!reader) return
  try {
    await reader.cancel()
  } catch {
    // The upstream may already be aborted or closed; cleanup is still complete.
  }
}
