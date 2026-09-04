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

ต้องใช้ Node.js 20 ขึ้นไป จากโฟลเดอร์นี้ให้ติดตั้ง dependency แล้วเปิด API และ Vite แยกกันสอง terminal:

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
| `SESSION_SECRET` | secret ของ session; production ต้องยาวอย่างน้อย 32 ตัวอักษร |
| `AEGIS_IDEA3_ADMIN_USER` | ชื่อบัญชี Admin |
| `AEGIS_IDEA3_ADMIN_PASSWORD_HASH` | bcrypt hash ที่จำเป็นใน production |
| `AEGIS_ALLOW_DEV_LOGIN` | เปิดรหัสผ่านพัฒนาได้เฉพาะ non-production เมื่อเป็น `true` |
| `AEGIS_IDEA3_DEV_PASSWORD` | รหัสผ่าน local-only เมื่อเปิด development login |
| `AEGIS_DEMO_ALLOWED` | ปิด Demo ใน non-production ได้ด้วย `false`; production ปิดเสมอ |
| `AEGIS_IDEA1_STATUS_URL` | read-only JSON endpoint ของ IDEA1 |
| `AEGIS_IDEA2_STATUS_URL` | read-only JSON endpoint ของ IDEA2 |
| `AEGIS_IDEA3_RUNTIME_STATUS_URL` | read-only JSON endpoint ของ runtime IDEA3 |
| `AEGIS_MAX_EVIDENCE_AGE_MS` | อายุสูงสุดของหลักฐานก่อนเป็น `UNKNOWN` |
| `AEGIS_ADAPTER_TIMEOUT_MS` | timeout ของ adapter แต่ละแหล่ง |
| `AEGIS_SESSION_IDLE_MS` | อายุ idle ของ Admin session |

ถ้า endpoint ใดไม่ถูกตั้งค่า ระบบแสดง `NOT_CONFIGURED`; ถ้าตอบไม่ได้/ผิด schema/เก่าเกินไป ระบบแสดง `UNKNOWN` โดยไม่สร้างข้อมูลปลอม และ Demo records ถูกแยก namespace จาก Live records เสมอ

## ตรวจสอบก่อนส่งงาน

```bash
npm test
npm run build
npm audit --omit=dev
```

รายละเอียดสถาปัตยกรรมและข้อกำหนดความปลอดภัยอยู่ใน `../docs/superpowers/specs/2026-09-03-idea3-security-center-11-page-design.md`
