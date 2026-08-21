---
title: Task Receipt — YOLO and SFace Admin recognition
date: 2026-08-21T10:12:52+07:00
owner: pub
area: idea2
branch: feat/idea2-yolo-sface-admin
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — YOLO and SFace Admin recognition

## What changed

- เพิ่ม recognizer แบบ opt-in ที่ต้องผ่านทั้ง YOLO Admin candidate และ SFace enrolled-template match ก่อนคืน `Authorized/Admin`
- การไม่มีโมเดล, YOLO ล้ม, SFace ล้ม, face ไม่ overlap หรือคะแนนไม่ถึงเกณฑ์คืน `Unknown` แบบ fail-secure
- เพิ่ม enrollment tool และ optional Docker AI dependency path โดยไม่ใส่ model, รูปใบหน้า, embedding หรือ secret ลง Git/image
- ค่าเริ่มต้นยังเป็น placeholder เพื่อไม่ claim identity เมื่อ node ยังไม่ได้ provision AI material

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.dockerignore` — กัน secret, models, biometric templates และ runtime evidence ออกจาก build context
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — อธิบาย AI configuration โดยไม่มีค่าจริงหรือ secret
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.gitignore` — กัน local models และ biometric enrollment artifacts
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/Dockerfile` — เพิ่ม build argument สำหรับติดตั้ง optional AI dependencies; runtime artifacts ต้อง mount ภายนอก
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — อธิบาย dual-gate security, enrollment, Docker AI และข้อจำกัด
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — โหลด/ตรวจ recognizer backend, model paths และ thresholds แบบ fail-closed
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/yolo_admin_recognizer.py` — helper สำหรับ YOLO tensors/geometry ที่ไม่สามารถ authorize เอง
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/yolo_sface_admin_recognizer.py` — dual-gate recognizer และ fail-secure error handling
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/enroll_admin.py` — สร้าง local SFace templates พร้อม model hash โดยไม่ commit biometric data
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-ai.txt` — optional Ultralytics dependency layer
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/run.py` — inject recognizer ที่เลือกไว้และหยุด startup เมื่อ AI provisioning ไม่ครบ
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_alert_policy.py` — ตรวจว่า alert ส่งเฉพาะ Unknown policy
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py` — ตรวจ AI configuration และ missing-artifact failures
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_entrypoint.py` — ตรวจ recognizer injection ที่ entrypoint
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_recognition_safety.py` — เปลี่ยน safety contract เป็น placeholder-safe และ configured-backend-only
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_runtime_wiring.py` — ตรวจ runtime wiring ของ configured recognizer
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_yolo_admin_recognizer.py` — ตรวจ geometry helper ไม่สร้าง authorization boundary
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_yolo_sface_admin_recognizer.py` — ตรวจ dual-gate pass/fail/error cases
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — แทนสถานะ placeholder-only ด้วยสถานะ local partial ที่ตรง implementation
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-21_101252_pub_yolo-sface-admin.md` — receipt ของงานนี้

## Verification evidence

- `<detection-engine venv python> -m unittest discover -s tests -p 'test_*.py'` — pass: 40 tests
- `Get-Command docker -ErrorAction SilentlyContinue` — blocked: Docker CLI not found; Docker AI build/up not claimed
- `git diff --check` — pass: no whitespace errors
- staged secret/private-key scan — pass: no token-shaped value or private-key header
- staged model/biometric/recording artifact scan — pass: no `.pt`, `.onnx`, `.npz`, image, video, model, enrollment or recording path staged
- `node --test tests/*.test.mjs` — pass: repository collaboration tests
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass: receipt ownership and links valid

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — บันทึก opt-in YOLO+SFace dual gate, safe default, local verification และ production blockers

## Shared surfaces touched

- None — task stayed inside the IDEA2 code and knowledge boundary

## Integration requests

- Pub/IDEA2 review: ตรวจ dual-gate threshold กับ Admin ทั้งสามคน, build/up Docker AI บนเครื่องที่มี Docker, และ deploy หลัง Telegram rotation เท่านั้น; rollback โดยตั้ง `AEGIS_RECOGNIZER_BACKEND=placeholder`

## Known limitations

- Docker AI build/up จริงยัง blocked เพราะ environment นี้ไม่มี Docker CLI
- Model weights, YuNet/SFace files, enrolled embeddings และรูปบุคคลไม่อยู่ใน Git; แต่ละ camera node ต้อง provision local material แยก
- ยังไม่ผ่าน Internal/Production, Docker webcam, multi-camera calibration หรือ threshold verification ของ Admin ทั้งสามคน
- Telegram token ที่เคยเปิดเผยต้อง revoke/rotate ก่อนทดสอบจริง
- `AEGIS_Camera/aegis_scanner.py` เป็น legacy compatibility runtime แยกต่างหากและไม่ได้เปลี่ยนในงานนี้
- Windows auto-start และ reverse tunnel เป็นงานแยก ไม่รวมใน branch นี้
