# AEGIS Entry — build frontend (vite) แล้วรัน Express (เสิร์ฟ API + dist)
# multi-stage: stage แรกสร้าง static bundle, stage สองรัน node แบบเบา

# ── build stage ───────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── runtime stage ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ติดตั้งเฉพาะ dependencies (ไม่เอา devDependencies เช่น vite) — image เล็กลง
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
# เอาเฉพาะสิ่งที่ runtime ต้องใช้: โค้ดเซิร์ฟเวอร์ + build จาก stage แรก
COPY server ./server
COPY --from=build /app/dist ./dist
# รันด้วย user ที่ไม่ใช่ root (image node มี user 'node' ให้อยู่แล้ว)
USER node
EXPOSE 8000
# HUB เป็น routing-only — ไม่มี secret ใด ๆ ให้ตั้ง (ไม่มี DB / session โดยเจตนา)
CMD ["node", "server/index.js"]
