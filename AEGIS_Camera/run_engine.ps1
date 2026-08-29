# Legacy Detection Engine helper (retained for compatibility review only).
# The canonical IDEA2 development runtime is now:
#   IDEA2-AEGIS_CCTV-Operator/detection-engine/run.py
#
# This script never supplies or prints credentials. Set secrets in the current
# process environment only when an explicitly approved legacy test requires it.

if (-not $env:MONITOR_INTERNAL_URL) {
    $env:MONITOR_INTERNAL_URL = "http://localhost:8002"
}
if (-not $env:AEGIS_CAMERA_ID) {
    $env:AEGIS_CAMERA_ID = "CAM-05"
}
if (-not $env:AEGIS_STREAM_URL) {
    $env:AEGIS_STREAM_URL = "http://host.docker.internal:8005/video_feed"
}

Write-Warning "AEGIS_Camera is a legacy compatibility runtime, not the canonical IDEA2 engine."
if (-not $env:DETECTION_ENGINE_API_KEY) {
    Write-Warning "DETECTION_ENGINE_API_KEY is unset; Monitor ingest will fail secure."
}
if (-not $env:TELEGRAM_BOT_TOKEN) {
    Write-Warning "Credential Rotation Required Before Telegram Real Testing"
}

python aegis_scanner.py
