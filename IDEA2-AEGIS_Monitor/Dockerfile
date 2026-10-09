# AEGIS Monitor (IDEA2) — build frontend (vite, base '/monitor/') แล้วรัน Express
# (เสิร์ฟ API + dist จาก origin เดียวกัน) multi-stage: stage แรกสร้าง static bundle,
# stage สองรัน node แบบเบา — เหมือนแพทเทิร์นของ HUB-AEGIS_Entry/Dockerfile

# A digest-form NODE_BASE_IMAGE is mandatory for the H1 characterization and
# candidate build. The default preserves the existing development build only;
# it is not immutable artifact authority.
ARG NODE_BASE_IMAGE=node:20-alpine

# ── build stage ───────────────────────────────────────────────────────
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── runtime stage ─────────────────────────────────────────────────────
FROM ${NODE_BASE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8002
# ไม่มี DATABASE_URL ตั้งไว้ที่นี่โดยเจตนา — ไม่มีค่าจริงจะ fallback เป็น
# in-memory dev store อัตโนมัติ (ดู server/db/connection.js) — พอสำหรับทดสอบ localhost
CMD ["node", "server/index.js"]
