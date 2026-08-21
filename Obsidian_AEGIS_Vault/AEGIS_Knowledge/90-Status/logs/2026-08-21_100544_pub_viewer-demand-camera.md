---
title: Task Receipt — Viewer-demand camera runtime
date: 2026-08-21T10:05:44+07:00
owner: pub
area: idea2
branch: feat/idea2-viewer-demand-runtime
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Viewer-demand camera runtime

## What changed

- Detection Engine เปิดกล้องเมื่อ authenticated Monitor viewer เริ่มรับ stream และคืนกล้องเมื่อ viewer คนสุดท้ายออกครบช่วง idle timeout
- Monitor แยกสถานะ “Engine ติดต่อได้แต่กล้องยัง idle” ออกจาก stream ที่ stale หรือใช้ไม่ได้ เพื่อไม่แสดงสถานะพร้อมแบบเท็จ
- โหมดเดิมแบบ always-on ยังคงเป็นค่าเริ่มต้น; viewer-demand ต้องเปิดผ่าน environment โดยตั้งใจ

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — เพิ่มตัวอย่าง configuration สำหรับ viewer-demand โดยไม่ใส่ secret
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — อธิบาย lifecycle, security boundary, rollout และข้อจำกัดของ viewer-demand
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — โหลดและตรวจค่า capture-on-demand แบบ fail-closed
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py` — เชื่อม shared demand signal เข้ากับ capture, recorder และ stream lifecycle
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py` — ผูก authenticated stream request เข้ากับ viewer lease
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/segment_recorder.py` — ปิด segment ที่กำลังเขียนเมื่อ capture กลับสู่ idle
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py` — นับ active viewers และจัดการ idle timeout อย่าง thread-safe
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py` — เปิด/คืนอุปกรณ์กล้องตาม demand โดยคง reconnect และ always-on behavior
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py` — ตรวจ validation ของ viewer-demand configuration
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_viewer_demand.py` — ตรวจ first/last viewer, capture release และ segment finalization
- `IDEA2-AEGIS_Monitor/package.json` — รวม stream-availability contract test ในคำสั่ง test หลัก
- `IDEA2-AEGIS_Monitor/server/db/store.js` — คำนวณ stream availability โดยไม่ตีความกล้อง idle เป็น Engine offline
- `IDEA2-AEGIS_Monitor/tests/streamAvailability.test.mjs` — ตรวจ stream-ready และ stale/missing URL cases
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — บันทึก durable state และ verification gap ของ viewer-demand
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-21_100544_pub_viewer-demand-camera.md` — receipt ของงานนี้

## Verification evidence

- `$env:PYTHONPATH='..'; <detection-engine venv python> -m unittest test_config test_engine_lifecycle test_entrypoint test_nas_sync test_recognition_safety test_runtime_wiring test_viewer_demand` — pass: 24 tests
- `npm test` ใน `IDEA2-AEGIS_Monitor` — pass: 8 tests
- `npm run build` ใน `IDEA2-AEGIS_Monitor` — pass: Vite production build, 2,072 modules transformed
- `git diff --check` — pass: no whitespace errors
- `node --test tests/*.test.mjs` — pass: repository collaboration tests
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass: receipt ownership and links valid

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — เพิ่มสถานะ implemented/tested ของ viewer-demand พร้อมระบุว่ายังไม่ผ่าน Internal/Production และ real multi-client verification

## Shared surfaces touched

- None — task stayed inside the IDEA2 code and knowledge boundary

## Integration requests

- Pub/IDEA2 review: deploy Detection Engine และ Monitor contract พร้อมกัน จากนั้นทดสอบ registered camera, server-side assignment, browser reconnect และหลาย viewer; rollback โดยตั้ง `AEGIS_CAPTURE_ON_DEMAND=false`

## Known limitations

- ยังไม่ได้ทดสอบ Docker AI build/up จริง เพราะ environment นี้ไม่มี Docker CLI
- ยังไม่ได้ทดสอบ Docker USB webcam, Internal/Production, real multi-client disconnect, production heartbeat, NAS หรือ reverse tunnel auto-recovery
- งาน YOLO+SFace Admin recognition, Windows auto-start และ reverse tunnel แยกเป็นคนละ branch/task
- Telegram token ที่เคยเปิดเผยต้อง rotate ก่อน Internal/Production testing
