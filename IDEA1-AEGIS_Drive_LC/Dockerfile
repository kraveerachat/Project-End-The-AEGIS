# AEGIS Drive (IDEA1) — build frontend (vite, base '/drive/') แล้วรัน Express
# (เสิร์ฟ API + dist จาก origin เดียวกัน) multi-stage: stage แรกสร้าง static bundle,
# stage สองรัน node แบบเบา — เหมือนแพทเทิร์นของ HUB-AEGIS_Entry/Dockerfile

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
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
# ── Storage Layer mountpoint ──────────────────────────────────────────
# ⚠️ ต้องสร้าง + chown ให้ user 'node' "ก่อน" USER node: docker คัดลอกสิทธิ์/เจ้าของ
# ของโฟลเดอร์นี้จาก image ไปตั้งให้ named volume ตอนสร้างครั้งแรก ถ้าไม่ทำ volume จะ
# เป็นของ root แล้วโปรเซสที่รันด้วย 'node' เขียนไม่ได้เลย (อัปโหลดพังทั้งระบบ)
RUN mkdir -p /datalake && chown -R node:node /datalake
USER node
EXPOSE 8001
# ไม่มี DATABASE_URL ตั้งไว้ที่นี่โดยเจตนา — ไม่มีค่าจริงจะ fallback เป็น
# in-memory dev store อัตโนมัติ (ดู server/db/connection.js) — พอสำหรับทดสอบ localhost
CMD ["node", "server/index.js"]
