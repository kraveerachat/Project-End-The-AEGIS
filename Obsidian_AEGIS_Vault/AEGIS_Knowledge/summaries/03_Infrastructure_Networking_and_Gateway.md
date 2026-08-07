---
title: Work Summary — Infrastructure, Networking & Gateway
tags: [aegis, summary, infrastructure, nginx, docker, networking]
type: summary
created: 2026-08-06
updated: 2026-08-06
sources: ["[[log]]"]
---

# 🌐 Infrastructure, Networking & Gateway — Consolidated

> See [[concepts/VLAN_Segmentation_and_Port_Mapping]] for the current-state network diagram. This page tracks how the gateway/Docker layer evolved.

---

## NGINX gateway — DNS resolver caching fix (2026-07-23)

- **Symptom**: `gateway/nginx.conf` resolved `drive`/`monitor` hostnames to a container IP once at nginx startup and never re-resolved it; any container recreate (new IP) produced 502s until a manual `docker compose restart gateway`.
- **Fix**: `resolver 127.0.0.11 valid=10s ipv6=off;` (Docker's embedded DNS) + `set $..._upstream` / `proxy_pass http://$var` per location, forcing nginx to re-resolve at request time instead of caching the IP for the process lifetime.
- Added a `/healthz` gateway healthcheck (`access_log off`) wired into the Compose healthcheck for the `gateway` service.
- Reproduced and measured both directions: pre-fix, a container IP change (`.3`→`.7`) 502'd for the full 12 minutes until manual restart; post-fix, `valid=10s` meant at most ~10s of staleness.

## Production `/drive` routing + CSP consolidation (2026-07-26)

- `HUB-AEGIS_Entry/nginx.conf` had **no rewrite** for `/drive/*` — the app's own `base: '/drive/'` build config expected the prefix stripped, so every asset request came back as `200 text/html` (the SPA fallback page) instead of the actual JS/CSS. Fixed with `location = /drive` (redirect) + `location /drive/` (rewrite, strip prefix) + explicit `proxy_hide_header`/`add_header` pairs.
- **Before/after, verified against the real config** (not assumed): `/drive/assets/index-*.js` went from `200 text/html 556B` to `200 application/javascript 922,922B`; `POST /drive/api/login` went from `404` to `200 application/json`.
- Consolidated a duplicate security-header layer (nginx *and* Express both setting CSP) down to a single header — the double CSP had been silently overriding the `'wasm-unsafe-eval'` directive the Private Vault's WASM Argon2id needs, which meant Private Vault only actually worked in dev, not through the production gateway, until this fix.

## Production `/monitor` routing + ingest guard (2026-07-26)

- Mirrored the `/drive` fix for `/monitor`, plus a **security-relevant regression found via testing, not inspection**: nginx `location` prefix matching is case-sensitive but Express route matching is not — `POST /Internal/detections` / `/INTERNAL/detections` / `/internal/Detections` all returned `201 Created` (real DB writes) even though the literal-prefix guard `location /monitor/internal/ { return 404; }` was supposed to block exactly this endpoint. Fixed by switching to a case-insensitive regex location (`location ~* ^/monitor/internal(/|$) { return 404; }`), verified against **14 case-variant/path-trick payloads** (case, double slash, percent-encoding, `.`/`..` segments, trailing query strings) with **0 leaks**.
- Also fixed `proxy_set_header Host $host` → `$http_host`, needed because `:8443` deployments were sending `Origin: https://localhost:8443` to a backend that saw `Host: localhost`, tripping the CSRF Origin/Host check — this is the same class of bug as the dev-proxy CSRF issue in [[summaries/02_Security_Auth_and_Identity]], but at the production gateway layer instead of vite's dev proxy.
- Confirmed the equivalent guard in the **dev-only** `gateway/nginx.conf` was still case-sensitive (not yet patched to match production) — tracked in [[summaries/08_Outstanding_Items_Consolidated]].

## Docker / Compose topology

- Production network: `subnet=192.168.10.0/24`, `gateway=.1`, `hub=.10` (nginx TLS :443 + :80→301), `drive=.11:8001`, `monitor=.12:8002`, `postgres=.15`.
- Named volumes introduced for persistent storage: `drive_storage` (IDEA1 file bytes, mounted `/datalake`), with the Dockerfile switched to `mkdir /datalake && chown node:node` + `USER node` so the app never runs as root against its own data volume.
- Session secrets decoupled per app (`DRIVE_SESSION_SECRET` / `MONITOR_SESSION_SECRET`) rather than shared.
- `.dockerignore` added for IDEA1 after discovering `COPY . .` was pulling host `node_modules`/`dist` into the build context and bloating the image with unused multi-megabyte background assets (later replaced by WebP versions — see [[01 - 🚪 HUB-AEGIS Entry]]).
- 12,551 tracked `node_modules` files removed from git (`git rm -r --cached`) after discovering they'd been committed; `.gitignore` corrected and verified with `git check-ignore`.

---

## Open items
The dev-only `gateway/nginx.conf` case-sensitivity gap for `/monitor/internal/` (production is fixed, dev is not) is tracked in [[summaries/08_Outstanding_Items_Consolidated]].
