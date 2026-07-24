#!/bin/sh
# AEGIS · Postgres — สร้าง DB role แยกต่อแอป แล้วล็อกให้ต่อได้เฉพาะฐานของตัวเอง
#
# ⚠️ Identity Decoupling ระดับฐานข้อมูล (นี่คือชั้นที่บังคับด้วย SQL จริง ไม่ใช่ธรรมเนียม):
#    แยก database + แยก DB user เพื่อบังคับ Identity Decoupling ระดับฐานข้อมูล
#    IDEA1 กับ IDEA2 query ข้ามฐานกันไม่ได้แม้แต่ในระดับ SQL
#
#    การแยกแค่ connection string (ทั้งคู่ต่อด้วย superuser คนเดียวกัน คนละฐาน) ยัง
#    "ไม่ใช่" การแยกจริง — โปรเซสของ IDEA1 ถือ credential ที่ \c aegis_monitor แล้ว
#    SELECT password_hash ของ IDEA2 ได้ทันที แค่แก้ query บรรทัดเดียว หรือ SQL
#    injection จุดเดียวก็ข้ามฝั่งได้ ไฟล์นี้ปิดช่องนั้นที่ตัว engine เอง
#
# ⚠️ หัวใจอยู่ที่ REVOKE CONNECT ... FROM PUBLIC: โดยดีฟอลต์ PostgreSQL ให้สิทธิ์
#    CONNECT ของทุก database แก่ PUBLIC (= ทุก role ที่ล็อกอินได้) การ GRANT CONNECT
#    ให้ role ที่ถูกต้องอย่างเดียวจึงไม่พอ ต้องถอนของ PUBLIC ออกก่อนเสมอ ไม่งั้น
#    drive_app ยังต่อ aegis_monitor ได้อยู่ดีทั้งที่ไม่เคยถูก GRANT
#
# รันหลัง 01-run-app-init.sh (เรียงตามชื่อไฟล์) เพราะ GRANT ... ON ALL TABLES ต้องมี
# ตารางอยู่ก่อนถึงจะครอบได้ — ALTER DEFAULT PRIVILEGES ด้านล่างรับหน้าที่ตารางที่จะ
# สร้างในอนาคตแทน
set -eu

: "${DRIVE_DB_PASSWORD:?DRIVE_DB_PASSWORD is required}"
: "${MONITOR_DB_PASSWORD:?MONITOR_DB_PASSWORD is required}"

echo "[aegis-postgres] creating scoped app roles: drive_app, monitor_app"

# ── สร้าง role (idempotent — DO block เพราะ CREATE ROLE ไม่มี IF NOT EXISTS) ──
# NOSUPERUSER NOCREATEDB NOCREATEROLE ระบุชัดเจน ไม่พึ่งค่า default ของ cluster
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d postgres \
  -v drive_pw="$DRIVE_DB_PASSWORD" -v monitor_pw="$MONITOR_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    CREATE ROLE drive_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_app') THEN
    CREATE ROLE monitor_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
SQL

# ตั้งรหัสผ่านแยกคำสั่ง ผ่าน :'var' (psql quote ให้เอง) — ไม่ประกอบ SQL ด้วยการต่อสตริง
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d postgres \
  -v drive_pw="$DRIVE_DB_PASSWORD" -v monitor_pw="$MONITOR_DB_PASSWORD" <<'SQL'
ALTER ROLE drive_app   WITH PASSWORD :'drive_pw';
ALTER ROLE monitor_app WITH PASSWORD :'monitor_pw';
SQL

# ── ปิดประตูก่อน แล้วค่อยเปิดเฉพาะบานที่ต้องใช้ (default-deny) ────────────────
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d postgres <<'SQL'
-- ถอน CONNECT ที่ PostgreSQL แจก PUBLIC มาให้โดยอัตโนมัติออกก่อน — ขั้นนี้คือขั้นที่
-- ทำให้ "ข้ามฐานไม่ได้" เป็นจริง ถ้าข้ามขั้นนี้ GRANT ด้านล่างจะไม่มีความหมายเลย
REVOKE CONNECT ON DATABASE aegis_drive   FROM PUBLIC;
REVOKE CONNECT ON DATABASE aegis_monitor FROM PUBLIC;

-- แต่ละ role ต่อได้ "ฐานเดียว" — ไม่มีการ GRANT ไขว้กันที่ไหนในไฟล์นี้
GRANT CONNECT ON DATABASE aegis_drive   TO drive_app;
GRANT CONNECT ON DATABASE aegis_monitor TO monitor_app;
SQL

# ── สิทธิ์ระดับตารางภายในฐานของตัวเอง (DML เท่านั้น ไม่ใช่เจ้าของตาราง) ────────
# ไม่ให้ความเป็นเจ้าของ = แอปแก้ schema/DROP TABLE ไม่ได้ ต่อให้ถูกยึดโปรเซสไปทั้งตัว
# migration ยังเป็นงานของ superuser ตอน deploy เท่านั้น
for pair in "aegis_drive:drive_app" "aegis_monitor:monitor_app"; do
  db=${pair%%:*}
  role=${pair##*:}
  echo "[aegis-postgres] granting $role DML on $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d "$db" -v role="$role" <<'SQL'
GRANT USAGE ON SCHEMA public TO :"role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"role";
-- BIGSERIAL/SERIAL ต้องใช้ sequence ได้ ไม่งั้น INSERT พังทั้งที่มีสิทธิ์ INSERT
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"role";
-- ตารางที่ถูกสร้างทีหลังโดย superuser (migration รอบถัดไป) ให้ได้สิทธิ์เดียวกันอัตโนมัติ
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"role";
SQL
done

echo "[aegis-postgres] scoped roles done — drive_app→aegis_drive, monitor_app→aegis_monitor"
