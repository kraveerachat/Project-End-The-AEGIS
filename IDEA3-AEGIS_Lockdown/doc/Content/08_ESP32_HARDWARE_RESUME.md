# AEGIS IDEA3 — ESP32 Hardware Resume

ใช้ไฟล์นี้เพื่อเริ่ม Codex conversation ใหม่สำหรับขั้น ESP32 โดยไม่ต้องแนบ
source code ทั้ง repository และห้ามใส่ password, token, PIN, private key,
Wi-Fi credential, MQTT credential, HMAC secret หรือ `secrets.h` ตัวจริง

## ไฟล์ที่แชตใหม่ต้องอ่าน

1. `AGENTS.md`
2. `doc/Content/00_START_HERE.md`
3. `doc/Content/03_PRODUCTION_CONSTRAINTS.md`
4. `doc/Content/04_SESSION_HANDOFF.md` — อ่านถึง section 22
5. `doc/Content/08_ESP32_HARDWARE_RESUME.md`

## สถานะล่าสุด

- Repository: `Kittipat050871/NETWORK-SEC-Project`
- Branch: `codex/autonomous-runtime`
- Base HEAD: `d438dd7eb58836fb8b2a685c7a651c4df75b19a2`
- ESP32 เชื่อมต่อที่ `/dev/ttyUSB0`
- USB-UART: CP2102, VID:PID `10C4:EA60`
- รีเลย์/สายแรงยังไม่เชื่อม
- `pio run -e esp32dev` ผ่าน
- RAM 14.2%; Flash 60.2%
- ยังไม่ได้ upload firmware, ส่ง Serial, เชื่อม MQTT จริง หรือสั่ง GPIO
- Voice adapter ยังไม่มีใน source; เอกสาร Voice เป็น proposal เท่านั้น

## ขอบเขตที่อนุญาตในขั้นถัดไป

1. ตรวจ Git status, handoff และ source/config แบบไม่แสดงค่า secret
2. ตรวจสิทธิ์ `/dev/ttyUSB0`
3. ตรวจว่า firmware ใช้ `src/secrets.h` หรือ configuration ใด โดยรายงานเฉพาะ
   ว่าพร้อม/ไม่พร้อม ห้ามอ่านข้อความลับออกมา
4. ขอคำยืนยันก่อน upload firmware เพราะเป็นการเปลี่ยน state ของบอร์ด
5. หลัง upload ให้เปิด Serial Monitor แบบอ่านอย่างเดียวก่อน
6. ยืนยัน boot, Wi-Fi/MQTT state และ error โดยไม่พิมพ์ credential

## สิ่งที่ยังห้าม

- ห้ามเชื่อมสายแรงหรือ production relay
- ห้ามสั่ง CUT/RESTORE หรือ toggle relay GPIO
- ห้ามเปลี่ยน MikroTik, TP-Link, UFW, VLAN หรือ routing
- ห้าม bypass HMAC, nonce, timestamp, ACK, Dead Man's Switch, PIN หรือ recovery
- ห้ามเปิด auto-containment กับฮาร์ดแวร์จริง
- ห้ามอ้างว่า Voice ใช้งานได้จนกว่าจะมี adapter และทดสอบครบ

## Prompt สำหรับวางในแชตใหม่

```text
อ่าน AGENTS.md, doc/Content/00_START_HERE.md,
doc/Content/03_PRODUCTION_CONSTRAINTS.md,
doc/Content/04_SESSION_HANDOFF.md และ
doc/Content/08_ESP32_HARDWARE_RESUME.md ให้ครบก่อนทำอะไร

ทำต่อจาก ESP32 checkpoint section 22 บน branch codex/autonomous-runtime
บอร์ดอยู่ที่ /dev/ttyUSB0 และรีเลย์/สายแรงยังไม่เชื่อม

เริ่มด้วย read-only checks และตรวจ firmware configuration โดยห้ามเปิดเผย secret
ขอคำยืนยันก่อน upload firmware จากนั้นอ่าน Serial Monitor ก่อนเท่านั้น
ห้าม CUT/RESTORE, relay GPIO, production MQTT/network และ auto-containment
รันทดสอบที่เกี่ยวข้องและอัปเดต handoff หลัง milestone ทุกครั้ง
ตอบเป็นภาษาไทยและส่งสรุปเสียง MP3 ภาษาไทยด้วย
```

## คำสั่งเริ่มต้นแบบ read-only

```bash
cd "/home/kittipat/Workspace/Final Project Network Cyber/Projects/AEGIS_IDEA3"
git status --short --branch
git rev-parse HEAD
git remote -v
find /dev -maxdepth 1 -type c -name 'ttyUSB*' -o -type c -name 'ttyACM*'
pio device list
pio run -e esp32dev
```
