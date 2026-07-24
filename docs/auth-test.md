# AEGIS — Terminal Verification (auth · RBAC · scoped view · Storage Layer)

คำสั่งทุกบรรทัดในไฟล์นี้ **คัดลอกไปวางแล้วรันได้ทันที** กับ stack ทดสอบ localhost
(`docker compose up -d --build` แล้วเปิด http://localhost/)

> ทุกอย่างที่พิสูจน์ในไฟล์นี้ถูกบังคับ **ฝั่งเซิร์ฟเวอร์** ทั้งหมด — การซ่อนเมนูใน UI
> ไม่ใช่ security control สิ่งที่นับคือ endpoint ตอบอะไรกลับมาเมื่อถูกยิงตรงด้วย `curl`
> โดยไม่ผ่านหน้าจอเลย

Base URL ผ่าน gateway:
- IDEA1 AEGIS Drive → `http://localhost/drive/api/...`
- IDEA2 AEGIS Monitor → `http://localhost/monitor/api/...`

## ⚠️ HUB (`http://localhost/`) ไม่มีการล็อกอินของตัวเอง

HUB เป็น **หน้าเลือกแอปแบบ stateless** — ไม่มีฟอร์มล็อกอิน ไม่มีบัญชี ไม่มี session
ไม่มี cookie ไม่มีฐานข้อมูล และไม่มี backend (เสิร์ฟเป็น static จาก nginx ล้วน ๆ)
หน้าที่เดียวของมันคือลิงก์ไปยัง Drive (`/drive/`) และ Monitor (`/monitor/`)
ซึ่ง **แต่ละแอปมีการล็อกอินอิสระของตัวเอง** ตามที่พิสูจน์ในหัวข้อ 1–11 ด้านล่าง

จึงไม่มี "รหัสผ่านของ HUB" ให้ทดสอบ และไม่มี endpoint `/api/login` ที่ราก —
ถ้าเห็น request แบบนั้นยิงออกจากหน้า `http://localhost/` แสดงว่ามีอะไรผิด

> **ประวัติ**: HUB เคยมีฟอร์มล็อกอินที่ *fallback ไปตรวจรหัสผ่านฝั่ง client*
> (`DEMO_ACCOUNTS` ใน `src/lib/auth.js`) เมื่อยิง `/api/login` แล้วไม่มี backend ตอบ
> — เท่ากับแจก session ระดับ Admin โดยไม่มีการบังคับฝั่งเซิร์ฟเวอร์เลย ทั้งฟอร์ม
> โฟลเดอร์ `server/` และ fallback ถูก **ลบทิ้งทั้งหมด** แล้ว (ดูหัวข้อ 12)
> รหัส `aegis-admin` / `aegis-user` ที่เคยแสดงเป็น hint บนหน้านั้น **ใช้ไม่ได้อีกต่อไป
> และไม่เคยเป็นรหัสของ Drive/Monitor** — อย่าสับสนกับตารางด้านล่าง

## บัญชีเดโม่

| App | username | password | role | ขอบเขต |
|---|---|---|---|---|
| Drive | `admin` | `aegis-drive-admin` | `Admin` | ครบ 9 จอ รวม Audit + Access |
| Drive | `user` | `aegis-drive-user` | `DataLake-User` | ไม่มี Audit / Access |
| Monitor | `soc` | `aegis-soc` | `SOC-Responder` | เห็นทุกกล้อง (Aggregate View) |
| Monitor | `operator` | `aegis-operator` | `CCTV-Operator` | **CAM-05 เท่านั้น** |
| Monitor | `operator2` | `aegis-operator2` | `CCTV-Operator` | **CAM-06 เท่านั้น** |

> ⚠️ `operator2` มีไว้เพื่อพิสูจน์สิ่งที่ operator คนเดียวพิสูจน์ไม่ได้:
> **operator คนหนึ่งต้องมองไม่เห็นกล้องของ operator อีกคน** ไม่ใช่แค่ "เห็นน้อยกว่า SOC"
> `soc` ไม่มีแถวใน `camera_assignment` เลย = เห็นทุกกล้อง (ดู `server/db/seed.sql`)

## เตรียม: login + เก็บ cookie/CSRF

session อยู่ใน cookie `HttpOnly + SameSite=Strict` (ไม่มี token ใน localStorage เลย)
ส่วน CSRF token มากับ JSON ของ `/api/login` และต้องแนบกลับทาง header `X-CSRF-Token`
ในทุก request ที่เปลี่ยนสถานะ

```bash
login() {  # login <app> <user> <pass> <cookiejar>  → echo csrf token
  curl -s -c "$4" -X POST "http://localhost/$1/api/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$2\",\"password\":\"$3\"}" |
    sed -n 's/.*"csrfToken":"\([a-f0-9]*\)".*/\1/p'
}
```

---

## 1 · `admin` → role `Admin`

```bash
CSRF_ADMIN=$(login drive admin aegis-drive-admin cj_admin.txt)
curl -s -b cj_admin.txt http://localhost/drive/api/me
```
```
{"user":{"username":"admin","displayName":"Veerachat J.","role":"Admin","mustResetPassword":false},"menu":[...9 รายการ รวม audit + access...],"csrfToken":"..."}
```

## 2 · `user` → `DataLake-User` + endpoint ของ Admin ตอบ 403

```bash
CSRF_USER=$(login drive user aegis-drive-user cj_user.txt)
curl -s -b cj_user.txt http://localhost/drive/api/me | grep -o '"role":"[^"]*"'
curl -s -o /dev/null -w "audit  -> %{http_code}\n" -b cj_user.txt http://localhost/drive/api/audit
curl -s -o /dev/null -w "users  -> %{http_code}\n" -b cj_user.txt http://localhost/drive/api/users
curl -s -o /dev/null -w "keys   -> %{http_code}\n" -b cj_user.txt http://localhost/drive/api/keys
```
```
"role":"DataLake-User"
audit  -> 403
users  -> 403
keys   -> 403
```
เมนู `audit` / `access` ไม่ได้ถูก "ซ่อน" — มันไม่เคยอยู่ใน payload ของ `/api/me` เลย
จึงไม่มีทางโผล่ใน DOM (ดู `server/rbac/permissions.js`)

## 3 · `operator` → เห็นแค่ CAM-05

```bash
login monitor operator aegis-operator cj_op1.txt > /dev/null
curl -s -b cj_op1.txt http://localhost/monitor/api/cameras
```
```json
{"cameras":[{"id":"CAM-05","name":"Reception","zone":"Public","res":"1920×1080","online":true}]}
```

## 4 · `operator2` → เห็นแค่ CAM-06

```bash
login monitor operator2 aegis-operator2 cj_op2.txt > /dev/null
curl -s -b cj_op2.txt http://localhost/monitor/api/cameras
```
```json
{"cameras":[{"id":"CAM-06","name":"Corridor B","zone":"Internal","res":"1280×720","online":true}]}
```

## 5 · operator ยิงขอกล้องของคนอื่นตรง ๆ → 403

**นี่คือข้อพิสูจน์หลักของ Scoped View** — ไม่มีการกรองฝั่ง client เข้ามาเกี่ยวเลย
เพราะ `curl` ไม่ได้รัน JavaScript ของแอปแม้แต่บรรทัดเดียว

```bash
# operator (CAM-05) ขอกล้องของ operator2
curl -s -o /dev/null -w "operator  -> CAM-06 : %{http_code}\n" -b cj_op1.txt http://localhost/monitor/api/cameras/CAM-06
# operator2 (CAM-06) ขอกล้องของ operator
curl -s -o /dev/null -w "operator2 -> CAM-05 : %{http_code}\n" -b cj_op2.txt http://localhost/monitor/api/cameras/CAM-05
# operator2 ขอกล้องของตัวเอง — ต้องผ่าน
curl -s -o /dev/null -w "operator2 -> CAM-06 : %{http_code}\n" -b cj_op2.txt http://localhost/monitor/api/cameras/CAM-06
# วิวที่เป็นของ SOC เท่านั้น
curl -s -o /dev/null -w "operator2 -> alerts : %{http_code}\n" -b cj_op2.txt http://localhost/monitor/api/alerts
# ข้อมูลอื่นก็ถูกกรองด้วย camera_assignment เหมือนกัน ไม่ใช่แค่ /cameras
curl -s -b cj_op2.txt http://localhost/monitor/api/clips | grep -o '"cam":"CAM-[0-9]*"' | sort -u
```
```
operator  -> CAM-06 : 403
operator2 -> CAM-05 : 403
operator2 -> CAM-06 : 200
operator2 -> alerts : 403
"cam":"CAM-06"
```

## 6 · `soc` → เห็นทุกกล้อง

```bash
login monitor soc aegis-soc cj_soc.txt > /dev/null
curl -s -b cj_soc.txt http://localhost/monitor/api/cameras | grep -o '"id":"CAM-[0-9]*"'
```
```
"id":"CAM-01" "id":"CAM-02" "id":"CAM-03" "id":"CAM-04" "id":"CAM-05" "id":"CAM-06"
```

## 7 · username ผิด กับ รหัสผ่านผิด ตอบเหมือนกันเป๊ะ

```bash
curl -s -X POST http://localhost/drive/api/login -H 'Content-Type: application/json' -d '{"username":"nosuchuser","password":"whatever"}'
curl -s -X POST http://localhost/drive/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrongpassword"}'
```
```
{"error":"Invalid credentials"}
{"error":"Invalid credentials"}
```
เหมือนกันทั้ง**ข้อความ**และ**เวลา** — กรณีไม่พบ user เซิร์ฟเวอร์ยัง `bcrypt.compare`
กับ hash หลอกก่อนปฏิเสธเสมอ เพื่อไม่ให้เวลาตอบกลับบอกใบ้ว่าบัญชีนั้นมีอยู่จริงไหม
(`server/auth/login.js`)

## 8 · พยายามผิดครบ 5 ครั้ง → ครั้งที่ 6 ถูกล็อก

```bash
for i in 1 2 3 4 5 6; do
  printf "attempt %s -> " "$i"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost/drive/api/login \
    -H 'Content-Type: application/json' -d '{"username":"bruteforce_probe","password":"bad"}'
done
```
```
attempt 1 -> 401
...
attempt 5 -> 401
attempt 6 -> 429
```
นับสองแกนแยกกัน: **ต่อบัญชี** และ **ต่อ IP** ติดแกนไหนก็ล็อก (`server/auth/rateLimit.js`)
ล็อกครั้งแรก 1 นาที แล้วเพิ่มเป็นเท่าตัวถ้าโดนซ้ำ สูงสุด 1 ชั่วโมง

> ⚠️ แกน per-IP นับรวมทุกบัญชี — รันข้อนี้แล้วจะ login จาก IP เดิมไม่ได้ ~1 นาที
> ให้รันข้อ 8 **เป็นข้อสุดท้าย** เสมอ

---

## 9 · Storage Layer — อัปโหลดแล้วดาวน์โหลดกลับ bytes ต้องตรงกัน

พิสูจน์ว่า Data Lake มีชั้นเก็บไฟล์**จริง** ไม่ใช่แค่แถว metadata:
ไฟล์จริงอยู่บน Docker volume `drive_storage` (mount ที่ `/datalake` ในคอนเทนเนอร์ drive)
ส่วนชื่อ/ขนาด/เจ้าของ/sha256 อยู่ใน Postgres

```bash
CSRF_ADMIN=$(login drive admin aegis-drive-admin cj_admin.txt)

# ไฟล์ทดสอบ binary 3MB (ไม่ใช่ text สั้น ๆ — ต้องพิสูจน์ว่า stream ผ่านครบ)
head -c 3145728 /dev/urandom > upload_src.bin
SHA=$(sha256sum upload_src.bin | cut -d' ' -f1)

# upload
curl -s -b cj_admin.txt -H "X-CSRF-Token: $CSRF_ADMIN" \
  -F "sha256=$SHA" -F "file=@upload_src.bin;filename=roundtrip-proof.bin" \
  http://localhost/drive/api/files/upload

# download กลับมา (ใส่ id ที่ได้จาก response ข้างบน)
curl -s -b cj_admin.txt -o downloaded.bin http://localhost/drive/api/files/1/download

# เทียบ byte ต่อ byte
cmp upload_src.bin downloaded.bin && echo "IDENTICAL"
```
```
{"file":{"id":"1","name":"roundtrip-proof.bin","size":3145728,"sha256":"2f2ef1be…","path":"uploads/218af401-b470-4ae1-854c-001749cf9da2.bin",…}}
IDENTICAL
```

ดู bytes จริงบนดิสก์ และแถว metadata คู่กัน:
```bash
docker exec aegis_system-drive-1 ls -la /datalake/uploads
docker exec aegis_system-postgres-1 psql -U aegis -d aegis_drive \
  -c "SELECT id,name,path,size_bytes,left(sha256,16) FROM files;"
```
```
-rw-r--r-- 1 node node 3145728 218af401-b470-4ae1-854c-001749cf9da2.bin
 1 | roundtrip-proof.bin | uploads/218af401-….bin | 3145728 | 2f2ef1be5c8c1108
```

ชื่อไฟล์บนดิสก์เป็น UUID ทึบ ไม่ใช่ชื่อที่ผู้ใช้ตั้ง — ชื่อจริงอยู่ใน Metadata Layer
เท่านั้น ทำให้ (1) คนที่เข้าถึงได้แค่ดิสก์อ่านไม่ออกว่าไฟล์ไหนคืออะไร (2) ชื่อจาก
ผู้ใช้ไม่มีวันกลายเป็น path บนดิสก์ = ตัด path traversal ตั้งแต่ต้นทาง

### 9.1 · ด่านกันของเสียของ Storage Layer

```bash
# client อ้าง sha256 ผิด (ไฟล์เพี้ยนระหว่างทาง) → 422 และไม่เหลือไฟล์กำพร้าบนดิสก์
curl -s -o /dev/null -w "checksum mismatch -> %{http_code}\n" -b cj_admin.txt -H "X-CSRF-Token: $CSRF_ADMIN" \
  -F "sha256=0000000000000000000000000000000000000000000000000000000000000000" \
  -F "file=@upload_src.bin;filename=corrupt.bin" http://localhost/drive/api/files/upload

# ไม่มี CSRF token → 403
curl -s -o /dev/null -w "no csrf token    -> %{http_code}\n" -b cj_admin.txt \
  -F "file=@upload_src.bin;filename=nocsrf.bin" http://localhost/drive/api/files/upload

# ไม่มี session → 401
curl -s -o /dev/null -w "no session       -> %{http_code}\n" http://localhost/drive/api/files/1/download

# ลบไฟล์ → metadata หาย และ bytes บนดิสก์ต้องหายตามด้วย
curl -s -b cj_admin.txt -H "X-CSRF-Token: $CSRF_ADMIN" -X DELETE http://localhost/drive/api/files/1
docker exec aegis_system-drive-1 sh -c 'ls /datalake/uploads | wc -l'
```
```
checksum mismatch -> 422
no csrf token    -> 403
no session       -> 401
{"ok":true}
0
```

### 9.2 · ทุกอย่างลง audit log โดยไม่เก็บชื่อไฟล์ดิบ

```bash
curl -s -b cj_admin.txt http://localhost/drive/api/audit | head -c 400
docker exec aegis_system-postgres-1 psql -U aegis -d aegis_drive \
  -c "SELECT action,result,left(target_hash,12) FROM audit_log WHERE action LIKE 'FILE%' ORDER BY id;"
```
```
 FILE_UPLOAD   | OK     | 748aa7d9ba85
 FILE_DOWNLOAD | OK     | 748aa7d9ba85
 FILE_UPLOAD   | DENIED | f134e8c323db
 FILE_DELETE   | OK     | 748aa7d9ba85
```
ชื่อไฟล์ถูกเก็บเป็น SHA-256 — ผู้ตรวจ log ตามรอยได้ว่า "เหตุการณ์ชุดนี้เกิดกับไฟล์
เดียวกัน" (hash ซ้ำกัน) โดยไม่เห็นชื่อไฟล์จริง

---

## 10 · Identity Decoupling — สองระบบตัวตนที่แยกขาดจากกัน

```bash
# session ของ Drive ใช้กับ Monitor ไม่ได้ (คนละ cookie คนละ SESSION_SECRET คนละฐานข้อมูล)
curl -s -o /dev/null -w "drive cookie -> monitor/api/me : %{http_code}\n" -b cj_admin.txt http://localhost/monitor/api/me
# และกลับกัน
curl -s -o /dev/null -w "monitor cookie -> drive/api/me : %{http_code}\n" -b cj_soc.txt http://localhost/drive/api/me
# บัญชีของ Monitor ล็อกอินเข้า Drive ไม่ได้ (คนละตาราง users คนละ database)
curl -s -X POST http://localhost/drive/api/login -H 'Content-Type: application/json' -d '{"username":"soc","password":"aegis-soc"}'
```
```
drive cookie -> monitor/api/me : 401
monitor cookie -> drive/api/me : 401
{"error":"Invalid credentials"}
```

ระดับฐานข้อมูล:
```bash
docker exec aegis_system-postgres-1 psql -U aegis -d aegis_drive   -c "\dt"
docker exec aegis_system-postgres-1 psql -U aegis -d aegis_monitor -c "\dt"
```
`aegis_drive` มี `users, files, shares, audit_log, vault_*` — ไม่มี `cameras` เลย
`aegis_monitor` มี `users, cameras, camera_assignment, detections, alerts, clips` — ไม่มี `files` เลย
สอง `users` นี้เป็นคนละตารางในคนละฐานข้อมูล ไม่มี foreign key เชื่อมถึงกัน

## 11 · Identity Decoupling ระดับ SQL — role แยกต่อแอป

การแยกฐานอย่างเดียวยัง **ไม่พอ** ถ้าทั้งสองแอปต่อด้วย superuser คนเดียวกัน เพราะ
โปรเซสของ IDEA1 จะถือ credential ที่ `\c aegis_monitor` แล้วอ่าน `password_hash`
ของ IDEA2 ได้ทันที ตอนนี้แต่ละแอปมี DB role ของตัวเองที่ถูก **REVOKE CONNECT**
ออกจากฐานของอีกฝั่ง (`postgres/init/02-app-roles.sh`)

```bash
docker exec aegis_system-postgres-1 psql -U aegis -d postgres -c "\du"
```
```
  Role name  |                         Attributes
-------------+------------------------------------------------------------
 aegis       | Superuser, Create role, Create DB, Replication, Bypass RLS
 drive_app   | No inheritance
 monitor_app | No inheritance
```
`aegis` (superuser) ใช้ตอน init/migrate/ตรวจสอบเท่านั้น — **แอปที่รันอยู่ไม่เคยต่อด้วย
role นี้** ตรวจได้จาก `DATABASE_URL` ที่ resolve จริง:
```bash
docker compose config | grep DATABASE_URL
```
```
DATABASE_URL: postgresql://drive_app:…@postgres:5432/aegis_drive
DATABASE_URL: postgresql://monitor_app:…@postgres:5432/aegis_monitor
```

**ยิงข้ามฐานตรง ๆ — ต้องถูกปฏิเสธตั้งแต่ชั้นเปิด connection:**
```bash
docker exec -e PGPASSWORD="$DRIVE_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U drive_app -h 127.0.0.1 -d aegis_monitor -c "SELECT username, password_hash FROM users;"
docker exec -e PGPASSWORD="$MONITOR_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U monitor_app -h 127.0.0.1 -d aegis_drive -c "SELECT username, password_hash FROM users;"
```
```
FATAL:  permission denied for database "aegis_monitor"
DETAIL:  User does not have CONNECT privilege.
FATAL:  permission denied for database "aegis_drive"
DETAIL:  User does not have CONNECT privilege.
```
> ถูกปฏิเสธที่ **ชั้น connection** ไม่ใช่ชั้น query — ไม่ต้องมี WHERE clause ไหนถูก
> ต้องเลย เพราะ session ข้ามฐานเปิดไม่ได้ตั้งแต่แรก SQL injection จุดใดจุดหนึ่งใน
> IDEA1 จึงไปแตะข้อมูล IDEA2 ไม่ได้เลย

**แต่ละ role ยังทำงานในฐานของตัวเองได้ปกติ และแก้ schema ไม่ได้ (ไม่ใช่เจ้าของตาราง):**
```bash
docker exec -e PGPASSWORD="$DRIVE_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U drive_app -h 127.0.0.1 -d aegis_drive -c "SELECT current_user, count(*) FROM users;"
docker exec -e PGPASSWORD="$DRIVE_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U drive_app -h 127.0.0.1 -d aegis_drive -c "DROP TABLE audit_log;"
docker exec -e PGPASSWORD="$DRIVE_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U drive_app -h 127.0.0.1 -d aegis_drive -c "CREATE TABLE backdoor(x int);"
```
```
 current_user | count
 drive_app    |     2
ERROR:  must be owner of table audit_log
ERROR:  permission denied for schema public
```
แอปมีแค่ DML (SELECT/INSERT/UPDATE/DELETE) — migration ยังเป็นงานของ superuser
ตอน deploy เท่านั้น ต่อให้โปรเซสถูกยึดทั้งตัวก็ DROP ตารางหรือฝังตารางใหม่ไม่ได้

---

## 12 · HUB ไม่มี auth surface ให้โจมตี (regression test ของช่องโหว่ที่ปิดไป)

เดิม HUB มีฟอร์มล็อกอินที่ยิง `POST /api/login` — และเมื่อ **ไม่มี backend ตอบ**
(gateway เสิร์ฟ static จึงตอบ `405`) โค้ดฝั่ง client จะ *ถอยไปตรวจรหัสผ่านเอง* จาก
อาเรย์ `DEMO_ACCOUNTS` ที่ฝังอยู่ใน bundle แล้วมอบ session ระดับ Admin ให้
— นั่นคือการยืนยันตัวตนที่ไม่มีการบังคับฝั่งเซิร์ฟเวอร์แม้แต่ชั้นเดียว

วิธีปิดคือ **ถอดความสามารถนั้นออกทั้งหมด** ไม่ใช่ซ่อมมัน: HUB ไม่มีฟอร์ม ไม่มีบัญชี
ไม่มี session ไม่มี backend อีกต่อไป ของที่ไม่มีอยู่ ย่อม bypass ไม่ได้

**12.1 · ไม่มีรหัสผ่านหรือ endpoint ล็อกอินหลงเหลือใน bundle ที่ deploy จริง**
```bash
BUNDLE=$(curl -s http://localhost/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
echo "bundle: $BUNDLE"
curl -s "http://localhost$BUNDLE" | grep -coE 'aegis-user|aegis-admin|DEMO_ACCOUNTS|/api/login'
```
```
bundle: /assets/index-XXXXXXXX.js
0
```
> `0` = ไม่มีรหัสผ่าน ไม่มีชื่อ fallback ไม่มี endpoint ล็อกอินอยู่ในโค้ดที่ผู้ใช้โหลด

**12.2 · ราก `/` ไม่มี API ให้เรียก — ทุก method บน `/api/*` ไม่ใช่ทางเข้า**
```bash
curl -s -o /dev/null -w "POST /api/login  -> %{http_code}\n" \
  -X POST http://localhost/api/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"aegis-admin"}'
curl -s -o /dev/null -w "GET  /api/me     -> %{http_code}\n" http://localhost/api/me
```
```
POST /api/login  -> 405
GET  /api/me     -> 200   ← index.html (SPA fallback) ไม่ใช่ JSON session
```
> จุดสำคัญคือ **ไม่มีฝั่ง client ที่รอผลนี้แล้วถอยไปตรวจเอง** อีกต่อไป
> `405` เดิมคือ *ทริกเกอร์* ของช่องโหว่ ตอนนี้มันไม่ทริกอะไรเลย

**12.3 · หน้า HUB ไม่ยิง request ล็อกอินใด ๆ ออกมาเลย**

ดูจาก access log ของ gateway ระหว่างเปิดหน้าแรก:
```bash
docker compose logs --since 2m gateway | grep -cE '"(POST|GET) /api/(login|me|logout)'
```
```
0
```

**12.4 · ไม่มีโค้ด auth เหลือใน repo ฝั่ง HUB**
```bash
ls HUB-AEGIS_Entry/server 2>&1
grep -rn "DEMO_ACCOUNTS" HUB-AEGIS_Entry/src 2>&1 | wc -l
```
```
ls: cannot access 'HUB-AEGIS_Entry/server': No such file or directory
0
```

> สรุป: ช่องโหว่ถูกปิดด้วยการ**ลบพื้นผิวการโจมตีทิ้ง** ไม่ใช่การเพิ่ม guard
> HUB กลับไปเป็นสิ่งที่สถาปัตยกรรมตั้งใจให้เป็นตั้งแต่แรก — ตัวจัดเส้นทางล้วน ๆ
> ส่วน identity ยังคงแยกขาดกันที่ Drive และ Monitor ตามหัวข้อ 10–11

---

## 13 · Add Operator จาก**ในเว็บ** (SOC-Responder) — endpoint จริง ไม่ใช่ CLI

หัวข้อ 3–5 พิสูจน์ว่าบัญชีที่ **CLI** (`server/cli/manage_users.py`, ผ่าน SSH) สร้าง ถูก
บังคับ Scoped View ฝั่งเซิร์ฟเวอร์ ตอนนี้เพิ่มเส้นทาง **เว็บ**: SOC-Responder กด "Add
operator" ในหน้า *Nodes & routing* ได้เลย ไม่ต้อง SSH — ยิง `POST /monitor/api/operators`

ตรรกะ provisioning ฝั่งเว็บอยู่ที่ `store.provisionOperator()` **ตัวเดียว** (แหล่งความจริง
เดียวของโค้ด Node) ส่วน CLI เป็น Python เส้นทาง SSH แยกต่างหาก — คนละภาษา แชร์ object
ฟังก์ชันเดียวกันไม่ได้ จึงบังคับให้ **ผลลัพธ์เท่ากัน** ด้วยค่าคงที่ชุดเดียว
(`USERNAME_RE` / `BCRYPT_COST=12` / `must_reset` ดีฟอลต์ = TRUE) แล้วพิสูจน์ความเท่ากันที่
§13.5 CLI ยังใช้ได้เหมือนเดิมทุกประการ (ไม่ถูกแก้/ถอด — เป็นเส้นทาง provisioning ที่ยังใช้ได้)

**13.1 · `soc` เพิ่ม operator ผ่าน endpoint → `201` + รหัสชั่วคราวคืนมาครั้งเดียว**
```bash
CSRF_SOC=$(login monitor soc aegis-soc cj_soc.txt)
RESP=$(curl -s -b cj_soc.txt -X POST http://localhost/monitor/api/operators \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF_SOC" \
  -d '{"username":"m.reyes.web","cameraId":"CAM-04"}')
echo "$RESP"
TEMP=$(echo "$RESP" | sed -n 's/.*"tempPassword":"\([^"]*\)".*/\1/p')
```
```json
{"operator":{"id":"6","name":"m.reyes.web","role":"CCTV-Operator","active":true},"tempPassword":"…24-char base64url…","mustResetPassword":true}
```
รหัสชั่วคราวถูกสร้าง**ฝั่งเซิร์ฟเวอร์** ส่งกลับครั้งเดียวในบอดี้ — และ**ไม่เคยถูก log**:
```bash
docker compose logs monitor | grep -c "$TEMP"
```
```
0
```
> `0` = รหัส plaintext ไม่โผล่ใน log ที่ไหนเลย มีแต่ bcrypt hash ลง DB (ดู §13.5)

**13.2 · กล้องที่ถูกจับจองแล้ว → `409` และไม่มีบัญชีกำพร้าถูกสร้าง**

`CAM-05` เป็นของ `operator` อยู่แล้ว (ดู `seed.sql`) — dropdown ในเว็บซ่อนกล้องนี้อยู่แล้ว
แต่ถ้ายิง request ตรง ๆ ด้วยข้อมูลเก่า/ปลอม เซิร์ฟเวอร์ต้องปฏิเสธเอง:
```bash
curl -s -b cj_soc.txt -w "\nHTTP %{http_code}\n" -X POST http://localhost/monitor/api/operators \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF_SOC" \
  -d '{"username":"x.taken","cameraId":"CAM-05"}'
# transaction rollback → ต้องไม่มีผู้ใช้ x.taken หลงเหลือ
docker exec -e PGPASSWORD="$MONITOR_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U monitor_app -h 127.0.0.1 -d aegis_monitor -tAc \
  "SELECT count(*) FROM users WHERE username = 'x.taken';"
```
```
{"error":"Camera CAM-05 is already assigned to an operator"}
HTTP 409
0
```
> `0` = การตรวจกล้องว่างเกิด**ในทรานแซกชันเดียวกับ**การ insert user — กล้องชนคือ 409
> และ user ไม่ถูกสร้าง (ไม่เหลือบัญชีกำพร้า) กฎ "user_id NOT NULL = จองแล้ว" เดียวกับ CLI

**13.3 · `operator` (ไม่ใช่ SOC) ยิง endpoint ตรง ๆ → `403`**
```bash
CSRF_OP=$(login monitor operator aegis-operator cj_op.txt)
curl -s -b cj_op.txt -w "\nHTTP %{http_code}\n" -X POST http://localhost/monitor/api/operators \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF_OP" \
  -d '{"username":"sneaky.op","cameraId":"CAM-02"}'
```
```
{"error":"Forbidden"}
HTTP 403
```
> บังคับด้วย `requireRole('SOC-Responder')` ฝั่งเซิร์ฟเวอร์ — ไม่ใช่แค่ซ่อนปุ่มในหน้า
> Nodes (`curl` ไม่รัน JS ของแอปเลย) CCTV-Operator ไม่มีทางสร้างบัญชีได้ไม่ว่าทางใด

**13.4 · operator ใหม่ล็อกอินด้วยรหัสชั่วคราว → เห็นแค่กล้องของตัวเอง (scoping เท่า CLI)**
```bash
# ใช้ $TEMP ที่ได้จาก §13.1
CSRF_NEW=$(login monitor m.reyes.web "$TEMP" cj_new.txt)
# บัญชีติด must_reset_password=TRUE (เหมือนบัญชีที่ CLI สร้าง) → endpoint อื่นถูกกั้นก่อน
curl -s -o /dev/null -w "ก่อนรีเซ็ต /cameras -> %{http_code}\n" -b cj_new.txt http://localhost/monitor/api/cameras
# บังคับตั้งรหัสใหม่ก่อน
curl -s -b cj_new.txt -X POST http://localhost/monitor/api/password/reset \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF_NEW" \
  -d "{\"currentPassword\":\"$TEMP\",\"newPassword\":\"brand-new-strong-pass-2026\"}" > /dev/null
# ตอนนี้เห็นเฉพาะกล้องที่ถูกมอบหมาย (CAM-04) — ไม่ใช่ทุกกล้อง
curl -s -b cj_new.txt http://localhost/monitor/api/cameras
```
```
ก่อนรีเซ็ต /cameras -> 403      ← PASSWORD_RESET_REQUIRED (พฤติกรรมเดียวกับบัญชีจาก CLI)
{"cameras":[{"id":"CAM-04","name":"Loading dock","zone":"Restricted","res":"1920×1080","online":true}]}
```
> เห็นแค่ `CAM-04` กล้องเดียว — Scoped View บังคับผ่าน `camera_assignment` ฝั่งเซิร์ฟเวอร์
> เหมือน `operator`/`operator2` ในหัวข้อ 3–5 **เป๊ะ ไม่ว่าบัญชีจะถูกสร้างจากเว็บหรือ CLI**

**13.5 · เว็บ endpoint กับ CLI สร้างแถว "รูปทรง + ข้อจำกัดเดียวกัน" (พิสูจน์ว่าไม่แตกเป็นสองสายพันธุ์)**

สร้างอีกบัญชีด้วย **CLI** (เส้นทาง SSH) แล้วเทียบสองแถวตรง ๆ ใน DB — `DATABASE_URL` ชี้ไป
ฐาน `aegis_monitor` เดียวกับที่แอปใช้ (รันจากโฮสต์ที่มี Python + `psycopg2` + `bcrypt`):
```bash
export DATABASE_URL="postgresql://monitor_app:${MONITOR_DB_PASSWORD}@localhost:5432/aegis_monitor"
echo 'CliTemp#2026abcd' | python3 IDEA2-AEGIS_Monitor/server/cli/manage_users.py add-operator \
  --username m.reyes.cli --display-name "M. Reyes (CLI)" --role CCTV-Operator \
  --camera CAM-02 --password-stdin
```
เทียบแถวจากทั้งสองเส้นทาง — คอลัมน์ที่บังคับ + ข้อจำกัดต้องตรงกันทุกช่อง:
```bash
docker exec -e PGPASSWORD="$MONITOR_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U monitor_app -h 127.0.0.1 -d aegis_monitor -x -c "
    SELECT username, role, active, must_reset_password,
           substring(password_hash for 7) AS bcrypt_prefix,   -- \$2a\$12\$ = cost 12
           length(password_hash)            AS hash_len
      FROM users
     WHERE username IN ('m.reyes.web','m.reyes.cli')
     ORDER BY username;"
```
```
-[ RECORD 1 ]-------+----------------
username            | m.reyes.cli
role                | CCTV-Operator
active              | t
must_reset_password | t
bcrypt_prefix       | $2b$12$
hash_len            | 60
-[ RECORD 2 ]-------+----------------
username            | m.reyes.web
role                | CCTV-Operator
active              | t
must_reset_password | t
bcrypt_prefix       | $2b$12$          ← cost 12 เท่ากัน (store.BCRYPT_COST = CLI BCRYPT_COST)
hash_len            | 60
```
และ `camera_assignment` ทั้งสองแถวมีรูปทรงเดียวกัน (คีย์ที่ `camera_id`, `user_id` ชี้เจ้าของ):
```bash
docker exec -e PGPASSWORD="$MONITOR_DB_PASSWORD" aegis_system-postgres-1 \
  psql -U monitor_app -h 127.0.0.1 -d aegis_monitor -c "
    SELECT a.camera_id, u.username, (a.user_id IS NOT NULL) AS has_owner
      FROM camera_assignment a JOIN users u ON u.id = a.user_id
     WHERE u.username IN ('m.reyes.web','m.reyes.cli') ORDER BY a.camera_id;"
```
```
 camera_id |  username   | has_owner
-----------+-------------+-----------
 CAM-02    | m.reyes.cli | t
 CAM-04    | m.reyes.web | t
```
> ทั้งสองแถว: `active=t`, `must_reset_password=t`, bcrypt **cost 12**, hash ยาว 60, และหนึ่งแถว
> ใน `camera_assignment` คีย์ด้วย `camera_id` — **รูปทรง + ข้อจำกัดเดียวกันเป๊ะ** เพราะทั้งคู่ลง
> ตาราง `users`/`camera_assignment` เดียวกันภายใต้ CHECK/PK เดียวกัน และเว็บใช้ค่าคงที่
> (`USERNAME_RE`, `BCRYPT_COST`) ที่ export จาก `store.js` เพื่อให้ตรงกับ `manage_users.py`
> — สถาปัตยกรรมที่เลือก: โค้ด Node เป็นเจ้าของเส้นทางเว็บ, CLI เป็นเส้นทาง SSH, **ความเท่ากัน
> พิสูจน์ด้วยการทดสอบนี้** (ไม่ใช่ subprocess ข้ามภาษา) — ดู `store.provisionOperator()`

> **หมายเหตุความสะอาดของ fixture**: บัญชี `m.reyes.web` / `m.reyes.cli` ข้างบนเป็นของทดสอบ
> ล้างทิ้งได้ด้วย `DELETE FROM users WHERE username IN ('m.reyes.web','m.reyes.cli');`
> (ON DELETE CASCADE เก็บกวาดแถว `camera_assignment` ให้เอง)
