# AEGIS Entry — build frontend (vite) แล้วเสิร์ฟ static ด้วย nginx
#
# ⚠️ ไม่มี Node runtime และไม่มี Express อีกต่อไป — HUB เป็น static ล้วน:
# ไม่มี API, ไม่มี session, ไม่มี DB, ไม่มีรหัสผ่านของตัวเอง (ดู src/App.jsx)
# เดิม stage สองรัน `node server/index.js` ซึ่งมี fallback ตรวจรหัสผ่านฝั่ง
# client อยู่เบื้องหลัง — server/ ถูกลบทิ้งทั้งโฟลเดอร์แล้ว
#
# nginx.conf ในโฟลเดอร์นี้เขียนไว้สำหรับกรณีนี้อยู่แล้ว ("production ตัวนี้
# เสิร์ฟ static โดยตรงจาก nginx ไม่ผ่าน Express") — Dockerfile เพิ่งตามมาทัน

# ── build stage ───────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── runtime stage — nginx เสิร์ฟ dist/ อย่างเดียว ─────────────────────
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# 443 ต้องมีใบรับรอง mount เข้ามาที่ /etc/nginx/certs (ดู deploy/README.md)
EXPOSE 80 443
