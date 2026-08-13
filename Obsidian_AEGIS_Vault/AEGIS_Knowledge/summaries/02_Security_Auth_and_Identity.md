---
title: Work Summary — Security, Auth & Identity
tags: [aegis, summary, security, auth, rbac, identity, encryption]
type: summary
created: 2026-08-06
updated: 2026-08-06
sources: ["[[log]]"]
owner: kla
edit_policy: owner-writable
---

# 🛡️ Security, Auth & Identity — Consolidated

> See also [[core/security-architecture]] for the current-state spec and [[concepts/Identity_Decoupling]] / [[concepts/OWASP_Security_Defense]] / [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] for the underlying concepts. This page is the **history** of how each protection landed.

---

## Provisioning & password lifecycle (2026-07-21)

- **Day-0 bootstrap (IDEA1)**: admin account created from a *pre-computed bcrypt hash* passed via env var, validated by regex before boot — no plaintext password ever crosses a process boundary.
- **Admin API (IDEA1)**: `POST /api/users` provisions `DataLake-User` accounts only (never `Admin`, to limit blast radius from a hijacked Admin session), issuing a server-generated temp password shown exactly once.
- **SSH-only CLI (IDEA2)**: `manage_users.py` (argparse) adds `CCTV-Operator`/`SOC-Responder` accounts and assigns cameras — no new web-exposed write route.
- **Force-password-reset gate**: every server-provisioned account gets `must_reset_password = TRUE`; a gate in both apps' `requireRole.js` blocks all endpoints except `/me`, `/logout`, `/password/reset` until reset. IDEA1 now completes that lifecycle client-side too: a full-screen reset-only surface mounts before its shell, protected hooks receive no URL while gated, and successful reset unlocks the in-memory session without reload. The server remains the enforcing authority.
- **Deterministic test fixtures**: a separate, parallel seeding path (`seedTestFixtures.js` / CLI `--password-stdin --skip-force-reset`) creates 6 known test accounts with `must_reset_password = FALSE` for exercising RBAC flows — explicitly not called from app boot, and never the production default.

## SQL-level identity decoupling (2026-07-22)

- Introduced dedicated Postgres roles `drive_app` and `monitor_app` (least-privilege DML+USAGE, no schema-migration rights) replacing the shared superuser `aegis` for runtime connections.
- `REVOKE CONNECT … FROM PUBLIC` on both databases, so `drive_app` genuinely **cannot open a connection** to `aegis_monitor` and vice versa — not just an application-level convention. Verified: IDEA1 attempting `SELECT password_hash FROM users` against `aegis_monitor` fails at connection time (`permission denied for database`), not query time.
- See [[concepts/Identity_Decoupling]] for the full role/grant model.

## HUB client-side auth vulnerability (2026-07-24)

- **Root cause**: `HUB-AEGIS_Entry/src/lib/auth.js` shipped a hardcoded `DEMO_ACCOUNTS` object with an "API offline → authenticate client-side" fallback — meaning a hardcoded credential/role check shipped in the browser bundle, live, because HUB had no backend service in `docker-compose.yml` at the time.
- **Fix**: converted HUB into a pure, stateless app-picker with **no login of its own** — `Hub.jsx` just does `window.location.href` + reads `config.json`. All authentication now happens exclusively in Drive's and Monitor's own backends.
- Regression-verified via Playwright: zero password inputs, zero forms, zero auth requests on the HUB page.

## CSRF & network-error handling (2026-07-26)

- **Dev-proxy bug**: `vite.config.js`'s `changeOrigin: true` rewrote the `Host` header to the proxy target while the browser still sent its own `Origin` — tripping the CSRF Origin/Host check on *every* mutation, including login. Fixed (`changeOrigin: false` in dev); root cause documented as an nginx-vs-vite-proxy distinction, not a CSRF logic bug.
- Propagated a real `errorKind` (`csrf` / `network` / `timeout` / `server`) from `csrf.js` → `api.js` → `auth.js` → `Login.jsx`, replacing a boolean `error` flag that couldn't distinguish "wrong password" from "blocked by CSRF" from "server down."
- The identical `changeOrigin`/Host-header root cause recurred independently in **IDEA2** during its own audit pass — same fix applied there.

## Private Vault — Zero-Knowledge envelope encryption (IDEA1, 2026-07-26)

Replaced a mockup/demo "encrypted vault" screen with a real client-side zero-knowledge pipeline:

- **KDF**: Argon2id (`hash-wasm`, m=64MiB/t=3/p=1 — memory-hard against GPU cracking) derives a KEK from the user's passphrase + salt. `'wasm-unsafe-eval'` added to CSP (narrower than `'unsafe-eval'` — scoped to WASM only).
- **Envelope**: per-file 256-bit DEK generated per upload → encrypted by the KEK → only the *wrapped* DEK is ever stored; the server only ever sees ciphertext (`.aegisenc`) plus non-secret metadata.
- **Two real security bugs fixed during build**, not just features added: (1) the verifier was checked client-side, meaning a forged verifier could unlock a UI state without a real vault — moved server-side; (2) a wrong passphrase produced a generic `hash-wasm` error string instead of the intended `'wrong-key'` signal.
- **29 tests** covering unlock/lock cycles, upload→download round-trips (0B/1B/200KB), GCM ciphertext shape, and negative-path checks that plaintext/passphrase never appear in DB rows, server stdout/stderr, or audit logs.
- **Verification pass against real Postgres** (separate session): 38/38 passing (29 + 9 Postgres-only), migration-guard tested (refuses to boot against a stale schema, rolls back with `RAISE EXCEPTION`), and a `pg_dump` + Postgres statement-log grep for plaintext/passphrase came back **0 hits**.
- **One real divergence found between the in-memory mock and real Postgres**: `auditAct()` was fire-and-forget (`memAudit.unshift()` synchronously vs. an un-awaited Postgres `INSERT`), so a vault-unlock audit row could still be in flight when the HTTP response returned — closed by awaiting all 7 vault-route audit calls. The wider pattern of `await auditAct(...)` was rolled out project-wide.

## Ownership enforcement (IDEA1, 2026-07-26)

- `DELETE /api/files/:id` previously checked only "logged in", not "is the owner" — any authenticated user could delete any other user's file (metadata + bytes). Fixed to `403` on mismatch, with an `Admin` governance override still permitted and logged, and `ownerId` set `ON DELETE SET NULL` (fail-secure) rather than cascading.
- 4 new regression tests confirm cross-owner delete is blocked and audited as `DENIED`.

## Security hygiene folded into the IDEA1 mock-removal pass (2026-07-27)

Part of the larger 7-phase build-out (full detail in [[summaries/04_IDEA1_Drive_Build_Out]]):
- Closed the gap where `ON CONFLICT DO NOTHING` seeding left *existing* databases with `must_reset_password = FALSE` demo accounts — an idempotent `UPDATE` now closes them retroactively.
- Fixed a rate-limiter bug where **share-link password failures and login failures shared one IP counter** — behind a NAT egress, a fumbled share-link password could lock the login page for an entire office. Counters are now namespaced by scope.
- Added `token_hash` (sha256 of the share token, never the raw token) plus bcrypt-hashed link passwords and real CIDR zone enforcement for share links — the feature previously had **no token column at all**.

## IDEA2 security fixes folded into its own audit (2026-07-27)

Full detail in [[summaries/05_IDEA2_Monitor_and_Detection_Engine]]. Security-relevant highlights:
- Seeded demo accounts were live-forever (`must_reset_password = FALSE` with hashes committed to a public repo) — flipped to `TRUE` + retroactive `UPDATE`.
- `POST /api/link/outage` flipped *process-wide* state but was reachable by any operator (`requireAuth` only) — restricted to SOC.
- Live-video streaming (`GET /api/cameras/:id/stream`) is authorized through the same `canSeeCamera` function `/api/cameras` already used, checked again every 10s (not just at connection open) — a logged-out operator or one whose camera assignment was revoked mid-stream now gets cut within 10s, not indefinitely.
- `stream_url` (engine-supplied, Monitor dials it) is validated to `http`/`https` on ingest — otherwise it's an SSRF surface.

---

## Open items
See [[summaries/08_Outstanding_Items_Consolidated]] for encryption-at-rest for Data Lake uploads, session-store persistence, and other unresolved security-adjacent gaps.
