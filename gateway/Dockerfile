# AEGIS Gateway — build HUB-AEGIS_Entry's static bundle, serve it via nginx,
# and reverse-proxy /drive and /monitor to the drive/monitor containers on the
# compose network. Build context MUST be the repo root (see docker-compose.yml)
# so this stage can reach the HUB-AEGIS_Entry/ sibling directory.

# ── build stage — HUB frontend only (routing-only, no server needed here) ──
FROM node:20-alpine AS build
WORKDIR /app
COPY HUB-AEGIS_Entry/package*.json ./
RUN npm ci
COPY HUB-AEGIS_Entry/ .
RUN npm run build

# ── runtime stage — nginx serving the HUB dist + reverse proxy config ──────
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY gateway/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
