# AEGIS IDEA3 Security Center (Web) — PR11 Phase 2 container image (design §4.7).
#
# Build context: IDEA3-AEGIS_Lockdown/web. The build stage compiles the React
# bundle; the runtime stage installs production dependencies only and copies the
# Express server plus the built bundle. Application files stay root-owned; the
# service runs as the unprivileged `node` user (UID/GID 1000) and can write only
# its data directory, which is the Compose volume mount point.
#
# The Production build passes a digest-pinned base image, for example
#   --build-arg NODE_IMAGE=node:22-alpine@sha256:<verified digest>
# and records that digest as evidence. No secret, .env file, test, or local
# runtime state enters the image (see .dockerignore). Nothing is published: the
# listeners are reachable only on the dedicated HUB<->IDEA3 network.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -p /var/lib/aegis-idea3/data && chown node:node /var/lib/aegis-idea3/data && chmod 0700 /var/lib/aegis-idea3/data
USER node
CMD ["node", "server/index.js"]
