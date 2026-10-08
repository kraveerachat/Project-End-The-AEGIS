# AEGIS IDEA3 Security Center

ศูนย์กลางรับรู้สถานการณ์ความปลอดภัยของ AEGIS สำหรับผู้ดูแลระบบ โดยรวมหลักฐานแบบ read-only จาก IDEA1, IDEA2 และ runtime ของ IDEA3 พร้อมหน้าปฏิบัติการทั้งหมด 11 หน้าใน UI เดียว

## ขอบเขตที่ส่งมอบ

1. Dashboard — ภาพรวม posture, critical alert, incident และ health ของแหล่งข้อมูล
2. Overview — สรุป health/evidence freshness ของทั้งสาม IDEA
3. IDEA1 Security — เหตุการณ์ไฟล์, denial และแหล่งหลักฐานจาก Drive
4. IDEA2 Detection — detection feed และสถานะกล้องแบบ metadata-only
5. IDEA3 Lockdown — สถานะโซน, relay, heartbeat และ policy โดยไม่มี live actuator command
6. Alerts — triage/acknowledge พร้อม audit trail
7. Incidents — correlation จาก IP เดียวกันภายในช่วงเวลา 10 นาที พร้อม analyst note
8. Audit — บันทึกกิจกรรมและ export แบบจำกัดขนาด
9. Devices — inventory, firmware, last-seen และ evidence state
10. Recovery — ตรวจ validation แบบ dry-run เท่านั้น
11. Settings — session, evidence freshness และ Demo policy

## เริ่มใช้งานสำหรับพัฒนา

ต้องใช้ Node.js 22.13.0 ขึ้นไป จากโฟลเดอร์นี้ให้ติดตั้ง dependency แล้วเปิด API และ Vite แยกกันสอง terminal:

```bash
npm ci

NODE_ENV=development \
AEGIS_ALLOW_DEV_LOGIN=true \
AEGIS_IDEA3_ADMIN_USER=admin \
AEGIS_IDEA3_DEV_PASSWORD='<local-only-password>' \
SESSION_SECRET='<local-secret-at-least-32-characters>' \
npm run dev:server
```

```bash
npm run dev
```

เปิด `http://127.0.0.1:5176` และเข้าสู่ระบบด้วยค่าที่กำหนดใน terminal แรก ห้าม commit ค่า password, hash หรือ session secret ลง repository

## ตัวแปร runtime

| ตัวแปร | ความหมาย |
|---|---|
| `PORT` | พอร์ต API; ค่าเริ่มต้น `8003` |
| `SESSION_SECRET` | production ต้องยาวอย่างน้อย 32 ตัวอักษร, ห้ามใช้ development default/ค่าอักษรซ้ำล้วน และต้องมีอย่างน้อย 3 character classes |
| `AEGIS_IDEA3_ADMIN_USER` | ชื่อบัญชี Admin |
| `AEGIS_IDEA3_ADMIN_PASSWORD_HASH` | bcrypt hash ที่จำเป็นใน production; cost ต้องอยู่ระหว่าง 12–31 |
| `AEGIS_ALLOW_DEV_LOGIN` | เปิดรหัสผ่านพัฒนาได้เฉพาะ non-production เมื่อเป็น `true` |
| `AEGIS_IDEA3_DEV_PASSWORD` | รหัสผ่าน local-only เมื่อเปิด development login |
| `AEGIS_DEMO_ALLOWED` | ปิด Demo ใน non-production ได้ด้วย `false`; production ปิดเสมอ |
| `AEGIS_IDEA1_STATUS_URL` | read-only JSON endpoint ของ IDEA1 |
| `AEGIS_IDEA2_STATUS_URL` | read-only JSON endpoint ของ IDEA2 |
| `AEGIS_IDEA3_RUNTIME_STATUS_URL` | read-only JSON endpoint ของ runtime IDEA3 |
| `AEGIS_MAX_EVIDENCE_AGE_MS` | อายุสูงสุดของหลักฐานก่อนเป็น `UNKNOWN` |
| `AEGIS_ADAPTER_TIMEOUT_MS` | timeout ของ adapter แต่ละแหล่ง |
| `AEGIS_SESSION_IDLE_MS` | อายุ idle ของ Admin session |
| `AEGIS_IDEA3_AUDIT_DB_PATH` | SQLite audit path; ค่าเริ่มต้น `.aegis-runtime/security-center-audit.sqlite3` |

ถ้า endpoint ใดไม่ถูกตั้งค่า ระบบแสดง `NOT_CONFIGURED`; ถ้าตอบไม่ได้/ผิด schema/เก่าเกินไป ระบบแสดง `UNKNOWN` โดยไม่สร้างข้อมูลปลอม และ Demo records ถูกแยก namespace จาก Live records เสมอ

## Production authentication และ durable audit

Canonical environment template อยู่ที่ `../.env.example`

เมื่อ `NODE_ENV=production` ระบบจะ fail closed หาก `SESSION_SECRET` ไม่ผ่าน
production policy หรือ `AEGIS_IDEA3_ADMIN_PASSWORD_HASH` ไม่ใช่ bcrypt hash
ที่มี cost 12–31 และ development login จะถูกปิดเสมอใน production

Web Security Center ใช้ SQLite audit repository โดยค่าเริ่มต้นที่
`.aegis-runtime/security-center-audit.sqlite3` ใช้ schema version 2 และ WAL
เพื่อเก็บ audit แบบ durable ข้ามการ reopen/restart ของ process

Schema v2 เพิ่ม `containment_decisions`, `integration_lifecycle` และ
`correlated_incidents` แบบ additive; ฐานข้อมูล v1 เดิมจะถูก migrate ให้อัตโนมัติ
เมื่อเปิดใหม่ และ audit row ของ v1 ทั้งหมดถูกเก็บไว้ครบ

Backup/restore: ให้หยุด service ก่อนเสมอ แล้วคัดลอกไฟล์ `.sqlite3` พร้อมไฟล์คู่
`.sqlite3-wal` และ `.sqlite3-shm` ไปด้วย การคัดลอกขณะ service ทำงานอยู่หรือคัดลอก
เฉพาะไฟล์หลักโดยไม่เอา WAL/SHM อาจได้ audit ที่ไม่ครบ

Login success/failure/rate-limit, logout, operational failures และ action audit
ถูกสร้างฝั่ง server หาก audit persistence เปิดหรือเขียนไม่ได้ operation ที่ต้อง
พึ่ง audit จะ fail closed ด้วย HTTP `503` และ code
`AUDIT_PERSISTENCE_FAILURE`

Admin ที่ authenticate แล้วสามารถอ่าน audit แบบ bounded ผ่าน
`GET /api/security/audit?limit=1..250`

Session และ audit มี lifecycle แยกกัน: session ไม่ถูกอ้างว่า durable ข้าม
process restart ส่วน audit ที่ commit ลง SQLite จะยังอยู่

ก่อน backup/restore SQLite ให้หยุด Web service และสำรอง database พร้อม WAL/SHM
ที่เกี่ยวข้อง ห้าม commit database, runtime artifacts, credential, hash หรือ
session secret ลง Git

## Demo ภายในเครื่อง (non-production) และ acceptance

```bash
npm ci && npm run build
npm run demo:local      # เปิด http://127.0.0.1:8003/ รหัสผ่านสุ่มแสดงครั้งเดียวใน terminal
npm run acceptance      # UI → HTTP → server → SQLite แบบ end-to-end ในเครื่อง
```

`demo:local` ทำงานเฉพาะ loopback ในโหมด development ใช้ audit database ชั่วคราวใน directory ส่วนตัวที่ launcher สร้างเอง และลบเฉพาะ directory นั้นเมื่อ SIGINT/SIGTERM/SIGHUP, เริ่มระบบไม่สำเร็จ (เช่น port ถูกใช้) หรือ process จบการทำงานตามปกติ ส่วน SIGKILL/ไฟดับไม่สามารถ cleanup ได้ จึงอาจเหลือ `aegis-idea3-demo-*` ใน temp directory ซึ่งลบทิ้งได้อย่างปลอดภัย
ตัด IDEA1/IDEA2/runtime URL, token, dispatch และ proxy ออกจาก environment ก่อนเริ่ม และปฏิเสธการรันเมื่อ
`NODE_ENV=production` จึงไม่สามารถส่ง MQTT, เข้าถึง ESP32/Relay หรือสร้าง dispatch จริงได้ Live mode แสดง
`NOT_CONFIGURED` ตามจริง ส่วนข้อมูลสาธิตอยู่ใน Settings → Demo Mode (มีป้ายข้อมูลจำลองทุกหน้า)

ขณะเปิด Demo Mode การรับทราบ alert, บันทึก incident, dry-run recovery และการแก้ policy ถูกเก็บใน repository
ในหน่วยความจำของ session นั้นเท่านั้น ไม่เขียนลง SQLite audit จริง และถูกทิ้งเมื่อปิด Demo, เปิดใหม่, logout
หรือ login ใหม่ มีเพียงการสลับโหมดเท่านั้นที่ถูกบันทึกใน audit จริง

ชุด `tests/acceptance` ใช้ Express จริง, session/CSRF จริง และ SQLite จริง โดย inject เฉพาะ response ของ upstream
และ header ของ Core เพื่อทดสอบ request → dispatch → ACK → status โดยหลักฐานกายภาพไม่ถูกอนุมาน

## ตรวจสอบก่อนส่งงาน

```bash
npm test
npm run build
npm audit --omit=dev
```

รายละเอียดสถาปัตยกรรมและข้อกำหนดความปลอดภัยอยู่ใน `../docs/superpowers/specs/2026-09-03-idea3-security-center-11-page-design.md`
