# รายงาน Task 2 — Canonical Modular Detection Runtime

วันที่ตรวจสอบล่าสุด: 14 สิงหาคม 2026

Branch: `feat/idea2-canonical-modular-runtime`

Area: `idea2`

Owner: `pub`

Implementation commit: `87ab1f5`

สถานะ: `PARTIAL` — implementation และ automated/runtime smoke ที่ไม่ใช้ Docker ผ่านแล้ว แต่ Docker จริง กล้องจริง และ production integrations ยังไม่ได้พิสูจน์

## 1. สรุปสำหรับทีม

Task 2 เปลี่ยน runtime หลักของ IDEA2 จาก legacy engine ใน `AEGIS_Camera/` ไปเป็น modular engine ใน `IDEA2-AEGIS_CCTV-Operator/detection-engine/` โดย root Compose ยังคงใช้ชื่อ service `aegis-camera` เพื่อไม่ให้ contract ภายนอกเปลี่ยนโดยไม่จำเป็น

งานนี้ไม่ได้เพิ่ม face recognition ปลอม Modular recognizer ปัจจุบันยังคืนค่า `Unknown` เท่านั้น และไม่ได้ย้าย logic YOLO ที่เคยแปลง object detection เป็น `Authorized / Admin` จาก legacy engine เข้ามา

NAS ถูกเปลี่ยนให้ปิดโดย default สำหรับ development หากปิด, transfer ล้มเหลว หรือยืนยัน integrity ไม่ผ่าน ระบบจะเก็บไฟล์ local และห้ามรายงาน `storedOnNas=true` การลบไฟล์ local เกิดได้เฉพาะหลัง transfer และ checksum/size verification สำเร็จ

## 2. Runtime ก่อนและหลัง

```text
ก่อน Task 2
docker compose
  -> aegis-camera
  -> AEGIS_Camera/Dockerfile
  -> legacy aegis_scanner.py

หลัง Task 2
docker compose
  -> aegis-camera
  -> IDEA2-AEGIS_CCTV-Operator/detection-engine/Dockerfile
  -> python run.py
  -> DetectionEngine + modular workers
```

Legacy directory ยังอยู่ใน repository เพื่อ compatibility และการตรวจย้อนหลัง แต่ไม่ใช่ runtime ที่ root Compose เลือกอีกต่อไป

## 3. สิ่งที่แก้ไข

### 3.1 Canonical runtime และ container wiring

- เพิ่ม Dockerfile ให้ modular engine และใช้ `CMD ["python", "run.py"]`
- container ทำงานด้วย non-root user
- root Compose เปลี่ยน build context ของ `aegis-camera` ไปที่ modular engine
- API ภายใน container ใช้ port `8077`
- host เปิดเฉพาะ loopback `127.0.0.1:8005:8077`
- ใช้ named volumes `camera_segments` และ `camera_snapshots`
- Monitor mount `camera_segments` แบบ read-only
- local volumes ถูกระบุชัดว่าไม่ใช่ production NAS

### 3.2 Configuration ที่เริ่มระบบได้อย่างปลอดภัย

- `AEGIS_NAS_ENABLED` default เป็น `false`
- Monitor, Telegram และ NAS เป็น optional integrations สำหรับ standalone development
- เมื่อเปิด NAS ต้องมี host, user, transfer method และ verification mode ที่รองรับ
- ปฏิเสธ NAS verification mode ที่ไม่ตรวจสอบผลจริง
- service key และ credential ใน URL ถูก redact ก่อนเขียน log
- invalid environment values แสดงชื่อ setting ที่ผิดเพื่อให้ operator แก้ได้ตรงจุด

### 3.3 Lifecycle และ shutdown

- เพิ่ม transactional startup ผ่าน `RuntimeLifecycle`
- หาก worker ตัวใด start ไม่สำเร็จ ระบบ rollback component ที่เริ่มไปแล้ว
- shutdown ใช้ลำดับหยุด producer/consumer ที่กำหนดไว้
- `SIGINT` และ `SIGTERM` ถูกผูกกับ cooperative shutdown path
- startup failure แสดง component และสาเหตุที่อ่านได้

### 3.4 NAS truthfulness

- NAS disabled รายงานสถานะ `disabled`
- disabled/failed/unverified path ไม่สร้าง successful clip record
- disabled/failed/unverified path ไม่ลบ local segment
- การรายงาน NAS success ต้องผ่าน transfer และ checksum หรือ size verification
- ลบ local segment ได้เฉพาะ verified-success path

### 3.5 Recognition safety

- `PlaceholderRecognizer` คืนเฉพาะ `Unknown`
- ไม่มี identity enrollment หรือ face embedding model ใน Task 2
- modular runtime ไม่ import หรือเรียก YOLO authorization logic
- ไม่สร้างสถานะ `Authorized` หรือ `Admin` จาก object detection

### 3.6 Credential safety

- ลบ hard-coded Telegram และ engine credentials ออกจาก `AEGIS_Camera/run_engine.ps1`
- helper ถูกระบุเป็น legacy-only
- การลบค่าออกจาก current file ไม่ได้ทำให้ credential ใน Git history ปลอดภัย
- สถานะ blocker ยังคงเป็น **Credential Rotation Required Before Telegram Real Testing**

### 3.7 Documentation และ tests

- อัปเดต root README และ modular engine README ให้ตรงกับ runtime ปัจจุบัน
- อัปเดต `.env.example` โดยไม่มี secret จริง
- เพิ่ม tests สำหรับ config, lifecycle, entrypoint, NAS, recognition safety และ runtime wiring
- อัปเดต IDEA2 canonical status และ task receipt ตามหลักฐานจริง

## 4. ผล verification ล่าสุด

| การตรวจ | ผลลัพธ์ |
|---|---|
| Modular engine unit tests | ผ่าน 17/17 |
| Monitor tests | ผ่าน 6/6 |
| Repository governance/Vault tests | ผ่าน 45/45 |
| Python in-memory compile | ผ่าน 27 files |
| Vault validator | ผ่าน ไม่มี error; มี canvas warnings เดิม 2 รายการ |
| PyYAML Compose structure | ผ่าน |
| Runtime start โดยใช้ camera index ที่ไม่มี | ผ่าน ระบบยังทำงานต่อ |
| `GET /health` | HTTP 200 |
| Health เมื่อไม่มีกล้อง | `status=degraded`, `camera_connected=false` |
| NAS disabled | `nas.last_status=disabled` |
| Clean shutdown | ผ่าน |
| SIGINT cooperative shutdown | ผ่าน |
| Placeholder recognition | คืนเฉพาะ `Unknown`; tests ผ่าน |
| Fake NAS success protection | tests ผ่าน |
| Docker Compose config/build/up | ยังไม่ได้รัน เพราะเครื่องนี้ไม่มี Docker CLI |
| กล้องจริงและการถอดกล้องจริง | ยังไม่ได้ทดสอบ |
| SIGTERM ภายใน Linux container | ยังไม่ได้ทดสอบ |
| Monitor heartbeat, Telegram, production NAS | ยังไม่ได้ทดสอบกับระบบจริง |

Runtime smoke ล่าสุดให้ผล:

```text
runtime_started=true
health.status_code=200
health.status=degraded
health.camera_connected=false
nas_status=disabled
shutdown_complete=true
sigint_shutdown_complete=true
```

## 5. Verification checklist สำหรับปิด Task 2

- [ ] `docker compose config` ผ่าน
- [ ] `docker compose build aegis-camera` ผ่าน
- [ ] `docker compose up aegis-camera` ผ่าน
- [ ] container ไม่ crash-loop
- [x] `/health` ตอบ HTTP 200 ใน direct runtime smoke
- [x] health แสดง degraded เมื่อไม่มีกล้อง
- [x] NAS disabled แล้ว runtime ยังอยู่
- [x] tests ยืนยันว่าไม่มี fake `storedOnNas=true`
- [x] placeholder recognizer ไม่คืน `Authorized` หรือ `Admin`
- [x] SIGINT shutdown สะอาด
- [ ] SIGTERM shutdown สะอาดใน Linux container
- [ ] กล้องจริงเปิดแล้ว `camera_connected=true`
- [ ] ถอดกล้องจริงแล้ว reconnect/error behavior สมเหตุสมผล

รายการที่ยังไม่ checked คือเหตุผลที่ Task 2 ยังคงเป็น `PARTIAL` และยังไม่ควรใช้เป็นหลักฐานว่า production deployment พร้อม

## 6. ไฟล์ที่เปลี่ยน

### Shared/deployment surfaces

- `.env.example`
- `.gitignore`
- `README.md`
- `docker-compose.yml`
- `docs/reports/2026-08-14-idea2-canonical-modular-runtime-th.md`

### IDEA2 owned paths

- `AEGIS_Camera/run_engine.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/Dockerfile`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements.txt`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/run.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/lifecycle.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/metrics.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/nas_sync.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_engine_lifecycle.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_entrypoint.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_nas_sync.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_recognition_safety.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_runtime_wiring.py`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_221256_pub_canonical-modular-runtime.md`

## 7. Dependency และ PR base

ณ เวลาตรวจสอบ `origin/main` ยังไม่มี Task 1 commit `ee5151e` และ validator fix commits `39654b6`/`49719ba` แม้ implementation ของ Task 1 จะเสร็จแล้ว

Task 2 branch จึงรวม validator-fix dependency แบบไม่เกิด conflict และควรเปิด stacked PR โดยใช้ `fix/shared-vault-receipt-ownership` เป็น base ชั่วคราว การตั้ง base แบบนี้ทำให้ PR diff ของ Task 2 มี Task 2 receipt ใหม่เพียงหนึ่งไฟล์และใช้ validator ที่แก้ owner mapping แล้ว

หลัง dependencies merge ให้ retarget Task 2 ไป `main`, merge `origin/main` เข้ามา, รัน verification ซ้ำ และอัปเดต receipt ก่อน merge

## 8. Integration review ที่ต้องทำ

Kla ต้องตรวจ shared surfaces ต่อไปนี้:

- `.env.example` ไม่มี secret และ contract ไม่กระทบ IDEA1/IDEA3
- `.gitignore` ไม่ซ่อนหลักฐานหรือ source ที่ควร track
- `README.md` อธิบาย runtime ตรงกับ source
- `docker-compose.yml` เปลี่ยนเฉพาะ IDEA2 camera wiring และ Monitor recording mount
- Dockerfile ใช้ modular entrypoint จริงและ non-root user ใช้งาน volume ได้
- named volume lifecycle และ rollback ไป legacy Compose block ถูกต้อง

## 9. ขั้นตอนถัดไปก่อน Task 3

1. เปิด/ตรวจ stacked PR ของ Task 2 ด้วย `integration-review: yes`
2. ทดสอบ Docker checklist บน Detection Laptop ที่มี Docker
3. หากมีกล้อง ให้ทดสอบ connect, health และ unplug/reconnect
4. Rotate credential เดิมก่อน Telegram real test
5. อัปเดต Task 2 receipt จากผลจริง
6. Merge ผ่าน PR เมื่อ functional และ integration review ผ่าน
7. เริ่ม Task 3 หลัง Task 2 ผ่าน Docker/runtime smoke เท่านั้น

Task 3 ยังไม่ได้เริ่มในงานนี้

## 10. Rollback

หาก modular container ไม่สามารถทำงานบน target host ให้ rollback เฉพาะ `aegis-camera` service และ Monitor camera-recording mount ใน `docker-compose.yml` ไปยัง block ก่อน Task 2 ผ่าน Pull Request ห้ามนำ fake authorization หรือ fake NAS success กลับมาเพื่อให้ demo ดูเหมือนผ่าน
