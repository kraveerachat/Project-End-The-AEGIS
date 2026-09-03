// Camera membership/order comes exclusively from GET /api/cameras.
export function selectedCamera(cameras, selectedId) {
  return cameras?.find((camera) => camera.id === selectedId) ?? cameras?.[0] ?? null
}

export function cameraDetections(detections, cameraId) {
  return (detections ?? []).filter((event) => event.cam === cameraId)
    .sort((a, b) => b.at - a.at)
}

export function cameraHeartbeat(link, cameraId) {
  return link?.cameras?.find((heartbeat) => heartbeat.cam === cameraId) ?? null
}

export function cameraStatus(heartbeat, streamState) {
  // Do not infer demand/availability from the static cameras.online DB field.
  // hasStream is the server contract (including viewer-demand cold starts).
  if (!heartbeat?.hasStream) return 'Offline'
  if (streamState === 'live') return 'Live'
  if (streamState === 'connecting') return 'Connecting'
  if (streamState === 'error') return 'Reconnecting'
  return 'Online'
}
