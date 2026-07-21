#!/usr/bin/env bash
# AEGIS Entry — deploy/update script สำหรับ Beelink (โฮสต์ production)
# ดึงโค้ดล่าสุด แล้ว rebuild + restart containers
#
# ใช้:  bash deploy/deploy.sh
# ต้องมี .env อยู่ข้าง docker-compose.yml ก่อน (ดู .env.example)
set -euo pipefail

# ทำงานจากรากของ HUB-AEGIS_Entry เสมอ (โฟลเดอร์เหนือ deploy/)
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "[aegis] ✗ ไม่พบ .env — คัดลอกจาก .env.example แล้วตั้งค่าก่อน deploy" >&2
  exit 1
fi

echo "[aegis] pulling latest…"
git pull --ff-only

echo "[aegis] rebuilding + restarting containers…"
docker compose up -d --build

echo "[aegis] pruning dangling images…"
docker image prune -f

echo "[aegis] ✓ deployed. tailing app logs (Ctrl-C to stop):"
docker compose logs -f app
