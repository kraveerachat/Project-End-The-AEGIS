# AEGIS Drive (IDEA1) — build frontend (vite, base '/drive/') แล้วรัน Express
# (เสิร์ฟ API + dist จาก origin เดียวกัน) multi-stage: stage แรกสร้าง static bundle,
# stage สองรัน node แบบเบา — เหมือนแพทเทิร์นของ HUB-AEGIS_Entry/Dockerfile

# ── build stage ───────────────────────────────────────────────────────
# ⚠️ pin Alpine minor ทั้งสองสาง — media toolchain (ffmpeg) ถูก pin เป็น apk เวอร์ชันแน่นอนของ v3.23
#    (plan Task 15 / spec §10.3); ขยับ minor = ต้องยืนยัน apk policy ffmpeg ใหม่พร้อมหลักฐาน
FROM node:20-alpine3.23 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── runtime stage ─────────────────────────────────────────────────────
FROM node:20-alpine3.23 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ── Media preview toolchain (spec §10.3) ──────────────────────────────
# ffmpeg/ffprobe จาก Alpine community pin แน่นอน (ตรวจด้วย `apk policy ffmpeg` บน node:20-alpine3.23)
# sharp ใช้ prebuilt @img/sharp-linuxmusl-x64 ผ่าน npm ci ด้านล่าง — ไม่ต้องคอมไพล์ libvips
RUN apk add --no-cache ffmpeg=8.0.1-r1
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
# ── Storage Layer mountpoint ──────────────────────────────────────────
# ⚠️ ต้องสร้าง + chown ให้ user 'node' "ก่อน" USER node: docker คัดลอกสิทธิ์/เจ้าของ
# ของโฟลเดอร์นี้จาก image ไปตั้งให้ named volume ตอนสร้างครั้งแรก ถ้าไม่ทำ volume จะ
# เป็นของ root แล้วโปรเซสที่รันด้วย 'node' เขียนไม่ได้เลย (อัปโหลดพังทั้งระบบ)
RUN mkdir -p /datalake && chown -R node:node /datalake
# ── Media derivative cache mountpoint (แยก volume จาก /datalake — สร้างใหม่ได้ ไม่ backup) ──
RUN mkdir -p /var/cache/aegis-media && chown -R node:node /var/cache/aegis-media
USER node
EXPOSE 8001
# ไม่มี DATABASE_URL ตั้งไว้ที่นี่โดยเจตนา — ไม่มีค่าจริงจะ fallback เป็น
# in-memory dev store อัตโนมัติ (ดู server/db/connection.js) — พอสำหรับทดสอบ localhost
CMD ["node", "server/index.js"]
