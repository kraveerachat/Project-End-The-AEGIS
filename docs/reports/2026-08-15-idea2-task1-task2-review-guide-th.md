# คู่มือ Review งาน IDEA 2 — Task 1 และ Task 2

วันที่จัดทำ: 15 สิงหาคม 2026

Branch: `docs/idea2-task1-task2-reviewability`

Area / owner: `idea2` / `pub`

ขอบเขตของเอกสารนี้คือช่วยให้ทีมตรวจ Task 1 และ Task 2 ได้เร็วขึ้น เอกสารและ comment ที่เพิ่มในรอบนี้ไม่เปลี่ยน architecture, API contract, configuration value หรือ runtime behavior และยังไม่ได้เริ่ม Task 3

## What changed

### Task 1 — Current-state audit

- ตรวจสภาพ repository, source, deployment wiring และหลักฐาน verification ของ IDEA 2
- บันทึกสถานะจริงลง IDEA2 status และ receipt โดยไม่อ้างว่า mock/placeholder เป็น production implementation
- ระบุว่า modular Detection Engine เป็นเป้าหมาย canonical แต่ก่อน Task 2 root Compose ยังเลือก legacy engine
- ระบุช่องว่างสำคัญ ได้แก่ Docker จริง กล้องจริง production NAS, Monitor integration และ credential rotation

Task 1 เป็นงาน audit/documentation จึงไม่มี source code หรือ runtime config ที่ต้องเพิ่ม inline comment

### Task 2 — Canonical modular Detection Runtime

- เปลี่ยน build context ของ Compose service `aegis-camera` ให้เลือก modular engine ที่ `IDEA2-AEGIS_CCTV-Operator/detection-engine/`
- เพิ่ม Docker entrypoint ของ modular runtime และรัน container ด้วย non-root user
- ทำให้ startup/shutdown มี rollback ที่กำหนดลำดับชัดเจน
- ใช้ Monitor HTTP API เป็น persistence boundary; Detection Engine ไม่รับ PostgreSQL credential
- ทำ NAS ให้ fail-safe: local segment ถูกลบและ success ถูกบันทึกได้เฉพาะหลัง integrity verification
- คง placeholder recognizer ที่คืนได้เฉพาะ `Unknown`; ไม่ย้าย legacy YOLO authorization logic เข้ามา
- ย้ายค่าปรับใช้และ credential ไปยัง environment variables พร้อมเอา hard-coded credential ออกจาก legacy helper ปัจจุบัน
- เพิ่ม tests สำหรับ config, lifecycle, entrypoint, NAS truthfulness, recognition safety และ Compose/runtime wiring

### Comment pass รอบนี้

- อธิบายเหตุผลที่ Compose ใช้ service name `aegis-camera` ต่อ แต่ build modular runtime
- อธิบาย container port เทียบกับ host-mapped port และความหมายของ local named volume
- อธิบาย non-root container, derived stream URL, queue overflow policy และ partial-start rollback
- แก้คำอธิบาย NAS เดิมที่ทำให้เข้าใจว่า transfer exit code อย่างเดียวถือเป็น verification ได้ ทั้งที่ implementation ยอมรับเฉพาะ `checksum` หรือ `size`

## Why it changed

Task 2 แตะทั้ง runtime orchestration, Docker, Monitor API, NAS และ legacy migration boundary หากอ่านเฉพาะชื่อ class หรือค่า config อาจสรุปผิดได้ว่า service เดิมยังใช้ legacy engine, port `8005` ใช้ภายใน Docker หรือ local volume คือ NAS จริง Comment ที่เพิ่มจึงอธิบายเหตุผลและ trust boundary ตรงจุด โดยไม่เล่าประวัติ Task ใน source code

## Important files to review first

1. `docker-compose.yml`
   - ตรวจว่า `aegis-camera` build modular engine จริง
   - ตรวจ service-to-service URL `aegis-camera:8077`, loopback host mapping `127.0.0.1:8005:8077` และ local volumes

2. `IDEA2-AEGIS_CCTV-Operator/detection-engine/Dockerfile`
   - ตรวจ entrypoint `run.py`, health check, optional NAS tooling และ non-root runtime

3. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
   - ตรวจ environment contract, secret redaction, optional integrations และ NAS validation

4. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py`
   - ตรวจ component wiring, queue policies, Monitor boundary และ shutdown order

5. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/lifecycle.py`
   - ตรวจ transactional startup, rollback เมื่อ worker เริ่มไม่สำเร็จ และ bounded joins

6. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py`
   - ตรวจว่า Detection Engine ส่งข้อมูลผ่าน HTTP API และไม่มี direct PostgreSQL access

7. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/nas_sync.py`
   - ตรวจเงื่อนไข verified success, local retention เมื่อผิดพลาด และการสร้าง clip row หลัง verification เท่านั้น

8. `IDEA2-AEGIS_CCTV-Operator/detection-engine/run.py` และ `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_recognition_safety.py`
   - ตรวจว่า placeholder คืนได้เฉพาะ `Unknown` และไม่มี YOLO authorization path ใน modular runtime

9. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py`
   - ตรวจ health/events/stream boundary และการ proxy ไป Monitor สำหรับ endpoint ที่ต้องใช้ backend authorization

## Architecture decisions

- **Canonical component:** root Compose เลือก modular Detection Engine ใต้ `IDEA2-AEGIS_CCTV-Operator/detection-engine/`
- **Legacy component:** `AEGIS_Camera/` ยังถูกเก็บไว้เพื่อ compatibility และ rollback/reference แต่ไม่ใช่ runtime ที่ root Compose เลือก
- **Persistence boundary:** Detection Engine ติดต่อ Monitor ด้วย internal HTTP API; Monitor เป็นเจ้าของ database persistence และ RBAC จึงห้ามให้ Detection Engine ต่อ PostgreSQL โดยตรง
- **Configuration:** camera source, API, stream, heartbeat, Monitor, NAS และ Telegram มาจาก environment เพื่อให้แต่ละ Detection Laptop ปรับ deployment ได้โดยไม่แก้ source และไม่ฝัง secret
- **Docker networking:** container ภายใน Compose ใช้ service DNS และ container port `8077`; port `8005` bind เฉพาะ loopback ของ host สำหรับ diagnostics
- **Stream URL:** `AEGIS_STREAM_PUBLIC_URL` ต้องเป็น URL ที่ Monitor เข้าถึงได้ หากเว้นว่าง standalone runtime จะ derive จาก local API address
- **Heartbeat:** heartbeat เป็น best-effort Monitor integration การล้มเหลวของ Monitor ต้องไม่หยุด capture/recording pipeline
- **Security/RBAC:** Local API ไม่ใช่ผู้ตัดสินสิทธิ์ผู้ใช้ปลายทาง Endpoint ที่มี authorization ต้องอาศัย Monitor/backend; UI filtering ไม่ใช่ security boundary
- **NAS truthfulness:** local named volume ไม่ใช่ production NAS และห้ามรายงาน `storedOnNas=true` ก่อน transfer และ checksum/size verification สำเร็จ
- **Recognition limitation:** placeholder ยังไม่ใช่ real face recognition และต้องไม่สร้างสถานะ `Authorized` หรือ `Admin`

## What was intentionally NOT changed

- ไม่เปลี่ยน IDEA 1 หรือ IDEA 3
- ไม่เริ่ม Task 3
- ไม่ลบหรือ rewrite legacy engine
- ไม่เพิ่ม real face recognition, identity enrollment หรือ face embedding model
- ไม่เปลี่ยน API contract, database schema, RBAC policy หรือ public interface
- ไม่ติดตั้งหรือปรับ production NAS/network infrastructure
- ไม่เปิดใช้ Telegram จริง และไม่ถือว่าการลบ credential จากไฟล์ปัจจุบันแทน credential rotation ได้
- ไม่แก้ receipt ของ Task 1 หรือ Task 2 ย้อนหลัง
- ไม่แก้ `idea2-status.md` เพราะรอบนี้ไม่มี durable system fact ใหม่

## Files reviewed

### Task 1 evidence

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_213827_pub_idea2-current-state-audit.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`

### Task 2 source and configuration

- `.env.example`
- `.gitignore`
- `README.md`
- `docker-compose.yml`
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
- tests ทั้ง 6 ไฟล์ใต้ `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/`
- Task 2 receipt, IDEA2 status และรายงาน Task 2 เดิม

ไฟล์ที่ไม่เพิ่ม comment มีคำอธิบายตรงกับ implementation อยู่แล้ว หรือ logic อ่านได้ชัดจากชื่อและ tests การเพิ่ม comment ซ้ำจะเพิ่มภาระดูแลโดยไม่ช่วยการ review

## Verification

ผลของ documentation/reviewability pass นี้:

| การตรวจ | ผล |
|---|---|
| Modular Detection Engine tests | ผ่าน 17/17 |
| IDEA2 Monitor tests | ผ่าน 6/6 |
| Repository governance/Vault tests | ผ่าน 45/45 |
| Vault validator | ผ่าน; มี canvas owner-review warnings เดิม 2 รายการ |
| Python in-memory compile | ผ่าน 26/26 files |
| Python AST equality หลังตัด docstring | ผ่าน 3/3 files ที่แก้ comment/docstring |
| Non-comment content equality สำหรับ Compose, Dockerfile และ `.env.example` | ผ่าน 3/3 files |
| `git diff --check` | ผ่าน |

Docker build/up และกล้องจริงไม่ได้รันซ้ำใน comment-only pass นี้ และหลักฐานดังกล่าวยังเป็น verification gap ของ Task 2 เหมือนเดิม จึงห้ามใช้เอกสารนี้ยกระดับ Task 2 จาก `PARTIAL` เป็น production-ready

## Recommended review order

1. `docker-compose.yml`
   - ยืนยัน canonical/legacy boundary, Docker DNS/ports และ local-volume semantics

2. `IDEA2-AEGIS_CCTV-Operator/detection-engine/Dockerfile`
   - ยืนยัน modular entrypoint และ non-root security boundary

3. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
   - ยืนยัน environment validation และไม่มี secret/default ที่ไม่ปลอดภัย

4. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py`
   - ยืนยัน wiring, queue behavior และ Monitor API boundary

5. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/lifecycle.py`
   - ยืนยัน rollback/shutdown behavior

6. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/nas_sync.py`
   - ยืนยันว่า verified transfer เป็นทางเดียวที่รายงาน NAS success

7. `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py` และ `monitor_client.py`
   - ยืนยัน API/RBAC/persistence boundaries

8. tests ทั้ง 6 ไฟล์
   - เทียบ architecture claims ข้างต้นกับ executable evidence

## Remaining review difficulty

- Docker/Linux signal behavior ยังต้องดูบนเครื่องที่มี Docker จริง
- Camera connect/unplug/reconnect ยังต้องดูบน Detection Laptop ที่มีกล้องจริง
- Monitor heartbeat, Telegram และ production NAS ยังไม่มี end-to-end evidence จากระบบจริง
- Credential ที่เคยอยู่ใน Git history ยังต้อง rotate ก่อน Telegram real testing
- Branch นี้เป็น stacked documentation PR บน Task 2; ต้อง retarget หลัง dependency merges และต้องขอ integration review เพราะแตะ `docker-compose.yml` กับเอกสาร root-level
