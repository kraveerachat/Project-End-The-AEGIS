# AEGIS IDEA 3 — Voice Control Integration

โมดูลนี้เพิ่มการสั่งงานด้วยเสียงให้ **4 คำสั่ง operator**:

1. `ARM`
2. `DISARM`
3. `CUT_UPLINK`
4. `RESTORE_UPLINK`

โดย **ไม่เขียน MQTT/HMAC ใหม่** และไม่ bypass ระบบเดิม: เสียงเป็นเพียง trigger ไปยังเมท็อด GUI เดิม ดังนั้น PIN, CONFIRM, ACK tracking, HMAC/nonce/timestamp และ audit log เดิมยังทำงานเหมือนเดิม

## 1) ติดตั้ง dependency บน Arch Linux

```bash
cd ~/Workspace/Final\ Project\ Network\ Cyber/Projects/AEGIS_IDEA3
source venv/bin/activate

sudo pacman -S --needed portaudio
pip install -r requirements-voice.txt
```

> `faster-whisper` จะดาวน์โหลดโมเดลครั้งแรก หากต้องการให้ทำงานตอน WAN ถูกตัด ต้องเปิดใช้งานอย่างน้อยหนึ่งครั้งให้โมเดลถูก cache ก่อน หรือกำหนด `AEGIS_VOICE_MODEL` เป็น path ของโมเดล local

## 2) วางไฟล์

คัดลอก:

```text
aegis_soc/voice_control.py
requirements-voice.txt
```

เข้า project IDEA3 ปัจจุบัน

## 3) แก้ `aegis_soc/gui.py`

### 3.1 เพิ่ม import

ใกล้ import ของ `MQTTManager`:

```python
from .voice_control import VoiceController
```

### 3.2 เริ่ม VoiceController ใน `__init__`

หลังบรรทัด:

```python
self._emit_startup_warnings()
```

เพิ่ม:

```python
self.voice = VoiceController(
    root=self.root,
    is_armed=lambda: self.armed,
    on_arm=lambda: self._voice_set_arm(True),
    on_disarm=lambda: self._voice_set_arm(False),
    on_cut=self.on_cut_clicked,
    on_restore=self.on_restore_clicked,
    log=lambda message: self.log_message(
        f"[{time.strftime('%H:%M:%S')}] [VOICE] {message}", db.INFO
    ),
)
self.voice.start()
```

### 3.3 เพิ่ม helper เพื่อไม่ให้ ARM/DISARM toggle ผิดทิศ

เพิ่มใน class `AegisAdminGUI` ใกล้ `toggle_arm()`:

```python
def _voice_set_arm(self, desired_armed: bool):
    if self.armed == desired_armed:
        state = "ARMED" if self.armed else "DISARMED"
        self.log_message(
            f"[{time.strftime('%H:%M:%S')}] [VOICE] ระบบอยู่ {state} อยู่แล้ว",
            db.INFO,
        )
        return
    self.toggle_arm()  # ใช้ PIN gate เดิม
```

### 3.4 หยุด microphone thread ตอนปิด GUI

ใน `_on_close()` เพิ่มก่อน `self.mqtt.stop()`:

```python
if getattr(self, "voice", None):
    self.voice.stop()
```

ตัวอย่าง:

```python
def _on_close(self):
    try:
        db.log_event("SYSTEM", "SOC GUI shutting down", db.INFO)
        if getattr(self, "voice", None):
            self.voice.stop()
        self.mqtt.stop()
    finally:
        self.root.destroy()
```

## 4) เปิดใช้งาน

```bash
export AEGIS_VOICE_ENABLE=1
export AEGIS_VOICE_MODEL=base
export AEGIS_VOICE_LANGUAGE=th
export AEGIS_VOICE_WAKE_REQUIRED=1

python3 server_admin.py
```

ถ้าเครื่องแรงขึ้นสามารถใช้:

```bash
export AEGIS_VOICE_MODEL=small
```

## 5) คำพูดที่รองรับ

ต้องพูด wake word `AEGIS` ก่อน เช่น:

```text
"เอจิส อาร์ม"
"เอจิส ดิสอาร์ม"
"เอจิส ตัดเน็ต"
"เอจิส คืนเน็ต"
```

คำพ้องที่มีในโค้ด:

- ARM: `อาร์ม`, `เปิดเฝ้าระวัง`, `โหมดเฝ้าระวัง`, `arm`
- DISARM: `ดิสอาร์ม`, `โหมดซ่อมบำรุง`, `ปิดเฝ้าระวัง`, `disarm`
- CUT: `ตัดเน็ต`, `ตัดอินเทอร์เน็ต`, `ตัดอัพลิงก์`, `ล็อกดาวน์`, `cut uplink`
- RESTORE: `คืนเน็ต`, `คืนอินเทอร์เน็ต`, `คืนอัพลิงก์`, `คืนระบบเครือข่าย`, `restore uplink`

### CUT / RESTORE มี voice confirmation เพิ่มอีกชั้น

ตัวอย่าง CUT:

```text
ผู้ใช้: "เอจิส ตัดเน็ต"
ระบบ:  รอคำยืนยัน
ผู้ใช้: "ยืนยันตัด"
GUI:    เปิด PIN + CONFIRM เดิมของ AEGIS
```

RESTORE:

```text
ผู้ใช้: "เอจิส คืนเน็ต"
ผู้ใช้: "ยืนยันคืน"
GUI:    เปิด PIN เดิม
```

จึงยังคงหลักเดิมว่า **เสียงไม่สามารถ bypass Admin PIN ได้**

## 6) ทำไมไม่ให้พูด PIN

ไม่แนะนำให้ PIN เป็น voice credential เพราะไมโครโฟน/คนรอบข้างสามารถได้ยินและ replay ได้ง่ายกว่า input แบบ masked จึงให้ voice เป็น command trigger เท่านั้น และให้ authentication เดิมของ AEGIS เป็น authority

## 7) ทดสอบ parser ก่อนเปิดไมค์

จาก root project:

```bash
python3 - <<'PY'
from aegis_soc.voice_control import parse_voice_command

for text in [
    "เอจิส อาร์ม",
    "เอจิส ดิสอาร์ม",
    "เอจิส ตัดเน็ต",
    "เอจิส คืนเน็ต",
    "ตัดเน็ต",
]:
    print(text, "=>", parse_voice_command(text))
PY
```

ต้องได้ประมาณ:

```text
เอจิส อาร์ม => ARM
เอจิส ดิสอาร์ม => DISARM
เอจิส ตัดเน็ต => CUT
เอจิส คืนเน็ต => RESTORE
ตัดเน็ต => None
```

บรรทัดสุดท้ายต้อง `None` เพราะไม่มี wake word

## 8) Regression หลังเพิ่ม

ก่อนใช้งานกับ Relay จริง:

```bash
python3 -m py_compile aegis_soc/voice_control.py
pytest -v
ruff check .
```

จากนั้นทดสอบ voice ในโหมดที่ Relay ยังไม่คั่น WAN จริงก่อน แล้วจึง HIL test ตาม runbook เดิม
