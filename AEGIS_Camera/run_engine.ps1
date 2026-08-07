# run_engine.ps1 — รัน Detection Engine นอก Docker พร้อม env ที่ต้องใช้ครบ
# ใช้แทนการพิมพ์ $env:... ทีละบรรทัดทุกครั้งที่เปิด terminal ใหม่
# วิธีใช้: เปิด PowerShell ในโฟลเดอร์ AEGIS_Camera แล้วรัน  .\run_engine.ps1

$env:MONITOR_INTERNAL_URL   = "http://localhost:8002"
$env:DETECTION_ENGINE_API_KEY = "dev-key-12345"
$env:AEGIS_CAMERA_ID        = "CAM-05"
$env:AEGIS_STREAM_URL       = "http://host.docker.internal:8005/video_feed"
# ⚠️ ใส่ token ของ bot ใหม่ตรงนี้ (สร้างผ่าน @BotFather) — token เก่าหลุดเข้า git แล้ว
$env:TELEGRAM_BOT_TOKEN     = "8973866991:AAGQ7PgE8YdOYm3m4A213V81ucPeCmtsMfs"

Write-Host "MONITOR_INTERNAL_URL   = $env:MONITOR_INTERNAL_URL"
Write-Host "DETECTION_ENGINE_API_KEY = $env:DETECTION_ENGINE_API_KEY"
Write-Host "AEGIS_CAMERA_ID        = $env:AEGIS_CAMERA_ID"
Write-Host "AEGIS_STREAM_URL       = $env:AEGIS_STREAM_URL"
Write-Host "--- starting aegis_scanner.py ---"

python aegis_scanner.py