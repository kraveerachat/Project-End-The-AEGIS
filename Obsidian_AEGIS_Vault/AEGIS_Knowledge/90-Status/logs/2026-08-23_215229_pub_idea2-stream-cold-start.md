---
title: Task Receipt — IDEA2 stream cold-start reliability
date: 2026-08-23T21:52:29+07:00
owner: pub
area: idea2
branch: fix/idea2-stream-cold-start
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 stream cold-start reliability

## What changed

- แยกเวลารอภาพแรกของ Detection Engine ออกจาก viewer idle timeout เพื่อรองรับการ warm up ของ YOLO และ SFace โดยไม่ปิด stream ก่อนภาพแรกพร้อม
- แยก Monitor first-byte watchdog ออกจาก steady-state idle watchdog; หลังได้รับข้อมูลครั้งแรกยังตรวจ stream ค้างด้วยเวลาเดิม 6 วินาที
- ทำให้การยกเลิก upstream reader แบบ asynchronous เป็น expected cleanup และไม่กลายเป็น unhandled `AbortError` ที่ทำให้ Monitor restart
- คง RBAC, `camera_assignment`, API key boundary, viewer-demand camera release และ API contract เดิม

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — เพิ่มตัวอย่าง first-frame timeout โดยไม่มี secret
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — อธิบายความต่างระหว่าง cold-start และ steady-state timeout
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — โหลดและ validate first-frame timeout แยกจาก viewer idle timeout
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py` — ใช้เวลารอ 45 วินาทีก่อน frame แรกและกลับไปใช้ 15 วินาทีหลังเริ่ม stream
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py` — ตรวจ configuration และ validation ของ timeout ทั้งสองค่า
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_viewer_demand.py` — ตรวจ first-frame/steady-state timeout policy
- `IDEA2-AEGIS_Monitor/package.json` — รวม stream proxy policy test ใน test command หลัก
- `IDEA2-AEGIS_Monitor/server/routes/api.js` — ใช้ first-byte watchdog 50 วินาที, steady-state watchdog 6 วินาที และ await reader cleanup
- `IDEA2-AEGIS_Monitor/server/streamProxyPolicy.js` — รวม timing policy และ safe async reader cancellation ในโมดูลที่ทดสอบได้
- `IDEA2-AEGIS_Monitor/tests/streamProxyPolicy.test.mjs` — ตรวจ cold-start timing และ expected `AbortError` cleanup
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — เพิ่ม durable local-verification fact ของ cold-start stream timing
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-23_215229_pub_idea2-stream-cold-start.md` — immutable receipt ของงานนี้

## Verification evidence

- `<main detection-engine venv python> -m pytest -q` — pass: Detection Engine 52/52 tests
- `npm test` ใน `IDEA2-AEGIS_Monitor` — pass: Monitor 10/10 tests
- `npm run build` ใน `IDEA2-AEGIS_Monitor` — pass: Vite production build, 2,072 modules transformed
- `docker build -t aegis-monitor-cold-start-validation:local IDEA2-AEGIS_Monitor` — pass: isolated Monitor image built
- isolated Monitor `/healthz` และ authenticated `/api/cameras/CAM-05/stream` open → close → reopen — pass: first bytes 6.52s และ 3.94s, restart count 0, temporary test user removed
- real Windows Detection Engine `/stream.mjpg` cold start → close/idle → reopen — pass: first bytes 26.67s และ 5.97s; Engine returned to `idle / false / false`
- Engine stream request without key / with configured key — pass: 401 / 200 with 4,096 bytes; key value not printed
- validation container/image cleanup and original local Monitor `/healthz` — pass: temporary artifacts removed; original Monitor remained healthy
- stable Windows runtime migration — pass: source, local-only `.env`, and Windows runners were copied from `%TEMP%` to `C:\Users\puppu\AppData\Local\AEGIS\DetectionEngine\app`; the current-user `AEGIS Detection Engine` task was re-registered against that stable path, started successfully, and `/health` returned `idle / false / false`
- local operator browser check through `http://localhost/monitor/` — pass: opening the assigned Live canvas started viewer demand and the real camera, leaving released it to `idle / false / false`, and reopening restored the stream without manually starting `run.py`
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/dockerBootstrap.test.mjs tests/collaborationPolicy.test.mjs` — pass: repository collaboration/governance tests 45/45
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass: vault valid with two pre-existing owner-review canvas warnings
- changed-path filename/content scan — pass: 12 changed paths; no `.env`, private key, Admin photo, model/media artifact or Telegram-token-shaped value detected
- `git diff --check` — pass: no whitespace errors
- final pre-Git isolated Monitor audit (`aegis-monitor-final-audit:local`) — pass: image rebuilt from this worktree; `/healthz` returned `ok=true` with PostgreSQL, `/monitor/` returned 200, unauthenticated camera stream returned 401, internal route returned 401 without the engine key and 200 with the configured key, container hashes matched this worktree for `server/routes/api.js`, `server/streamProxyPolicy.js`, and `package.json`, restart count stayed 0, and no error/fatal/exception lines were emitted
- final pre-Git isolated Detection Engine audit (`aegis-final-audit:local`) — pass: OpenCV/Torch/Ultralytics imports succeeded, the non-root container stayed healthy with a deliberately unavailable camera, `/health` truthfully returned `degraded`, restart count stayed 0, and SIGTERM cleanup closed the test port
- `docker compose -f docker-compose.yml config --quiet` — pass: all five services rendered; Compose emitted only the existing obsolete top-level `version` warning
- `npm audit --omit=dev --audit-level=high` — pass: 0 runtime vulnerabilities; full development-tree audit remains non-zero for transitive `nanoid` (high) and `postcss` (moderate) under Vite
- read-only Internal TLS audit — partial: `https://aegis.internal/` and `/monitor/healthz` returned HTTP 200/healthy only with Schannel revocation best-effort; strict Windows `curl.exe` still fails with `CRYPT_E_NO_REVOCATION_CHECK`. The installed AEGIS Root CA is valid, but the active leaf certificate contains no CRL Distribution Point or AIA extension and `pki.aegis.internal` has no DNS result, so clean strict revocation verification requires an infrastructure certificate/CRL rollout rather than a client bypass
- reverse-tunnel preparation — partial: a dedicated ED25519 tunnel key was generated under LocalAppData, outside Git, with user/system/administrator ACLs; unattended authentication was retested with `BatchMode=yes` and is still not authorized on the server, so the `AEGIS Detection Tunnel` Scheduled Task was intentionally not installed
- permanent Windows auto-start re-registration — pass: `AEGIS Detection Engine` was registered again from `C:\Users\puppu\AppData\Local\AEGIS\DetectionEngine\app`, the task action and working directory contain no `%TEMP%` path, task state became `Running`, and `/health` returned `idle / false / false`
- Git task-boundary audit — pass for the clean stacked task: `fix/idea2-stream-cold-start` is based on local dependency `feat/idea2-windows-edge-autostart` and contains 12 intended changed paths with exactly one new Pub receipt. Direct reconciliation onto current `origin/main` is blocked because `origin/main` is 52 commits ahead and does not yet contain the canonical runtime, viewer-demand, YOLO/SFace, Docker AI, or Windows auto-start dependency chain

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — บันทึก timing policy และผล local real-camera/isolated-Monitor verification โดยไม่ claim Internal/Production

## Shared surfaces touched

- None — task stayed inside the IDEA2 code and knowledge boundary

## Integration requests

- Pub/IDEA2 review: deploy Detection Engine และ Monitor changes พร้อมกัน แล้วทดสอบผ่าน reverse tunnel และ Internal browser; rollback โดยคืนค่า timeout/code ทั้งสองฝั่งเป็น revision ก่อน task นี้

## Known limitations

- ยังไม่ได้ deploy หรือทดสอบผ่าน `https://aegis.internal/`, Production Monitor หรือ remote reverse tunnel
- local `aegis_system-monitor-1` was built from older mixed Compose inputs and does not contain this task's final stream policy; final-code runtime evidence therefore comes from the isolated image above, not from claiming that the existing local stack is current
- Monitor image build แสดง dependency audit ของ development tree 1 moderate และ 1 high; runtime `npm ci --omit=dev` รายงาน 0 vulnerabilities งานนี้ไม่ได้เปลี่ยน dependency
- `Stop-ScheduledTask` ไม่หยุด child Detection Engine ในการทดสอบครั้งนี้; cleanup ทำเฉพาะ PID ที่ตรวจ command line แล้ว เรื่อง process lifecycle ต้องเป็นงาน Windows auto-start แยกต่างหาก
- Telegram token เดิมเคยถูกเปิดเผยและผู้ใช้เลือกคงใช้งานต่อ จึงยังเป็น production security limitation แม้ functional delivery เคยผ่าน
- Windows strict TLS verification remains blocked until Infrastructure reissues the leaf certificate with a reachable revocation path and publishes the CRL/AIA endpoint; browser trust/HTTP success under best-effort mode is not equivalent to a clean strict-TLS production gate
- the dedicated IDEA2 reverse-tunnel key still needs one-time server authorization for `pubpup2006p`, after which the current-user tunnel task and Monitor-to-Engine health/authenticated-stream checks must pass
- the dependency branches must be published/reviewed in order before this stacked PR can be retargeted to `main`; deploying the current branch directly over newer Production Monitor code could regress unrelated merged work
- automated in-app browser verification of the localhost UI was unavailable because the browser control policy rejected local navigation; the UI behavior evidence in this receipt is the user's manual observation plus API/runtime measurements
- Production Monitor deployment remains intentionally blocked until the dependency PR chain is published/reviewed and the reverse tunnel can authenticate unattended; no Production container or shared server configuration was changed by this task
