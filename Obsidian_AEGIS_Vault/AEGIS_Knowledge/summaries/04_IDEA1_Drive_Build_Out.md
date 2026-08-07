---
title: Work Summary — IDEA1 Drive Feature Build-Out
tags: [aegis, summary, idea1, drive, features]
type: summary
created: 2026-08-06
updated: 2026-08-07
sources: ["[[log]]"]
---

# 💾 IDEA1 Drive — Feature Build-Out — Consolidated

> Current-state spec: [[02 - 💾 IDEA1 AEGIS Drive LC]]. Security-specific parts of this history (provisioning, ownership, Private Vault crypto) are covered in [[summaries/02_Security_Auth_and_Identity]] and only cross-referenced here.

---

## Storage Layer goes real (2026-07-22)

First functional (non-metadata-only) file storage: `POST /api/files/upload` (multipart via `multer`) streams bytes to a UUID-named path under a named volume, with `sha256` computed client-side *and* server-side so a mismatch fails the upload with `422` rather than silently storing a corrupt file. Path is derived through `resolveKey()` to close a path-traversal route a raw client-supplied filename would have opened. A second CCTV operator (`operator2` → `CAM-06`) was seeded on the IDEA2 side in the same session for camera-scoping test coverage.

## Global Search — `⌘K` (2026-07-26, three passes)

1. **Build**: `GlobalSearch.jsx` — click-outside/Escape/state-cleanup handling, `FILES`/`PEOPLE`/`ACTIONS` result sections, illustrated empty state, RBAC-filtered `PEOPLE` results (reads the same `access` permission the nav already gates on — not a separate hardcoded role check), and an explicit **disabled state on the Vault screen** (ciphertext isn't searchable, and it must not silently return nothing).
2. **Wiring**: found the built component wasn't actually rendered in production — a 4-part gap (component not mounted in `App.jsx`, TopBar input not wired, a stale service-worker serving an old bundle, aggressive HTML caching hiding the new build). All four fixed and 10/10 regression-verified with a real Playwright pass over the built bundle, not source.
3. **Attribute audit**: verified via `grep` that no backend `/api/search` or `?q=` endpoint exists at all — search is 100% client-side filtering over already-fetched `/api/files` and `/api/users` responses. Documented as a known constraint rather than left ambiguous.

## Share links become real (2026-07-27, part of the 7-phase pass below)

Previously "worse than a facade" — there was no token column at all, so no shareable link could exist. Added `token_hash` (see [[summaries/02_Security_Auth_and_Identity]]), real `GET/POST /s/:token` redemption, bcrypt-hashed link passwords, a hit counter that only increments on successful redemption, and real CIDR-zone enforcement snapshotted at link-creation time. A `ScopeDiagram` UI element and an `otc` (one-time-code) option were removed because they promised behavior that didn't exist.

---

## The 7-phase mock-data removal pass (2026-07-27)

**Goal**: make the remainder of IDEA1 fully real on the existing stack (Express + Postgres + local disk + nginx) — explicitly no Redis/MinIO/S3/ZFS/Kubernetes unless proven necessary and reported first — landed as 9 isolated, independently-verified commits.

| Phase | What changed |
|---|---|
| **P1 — Security hygiene** | Retroactive `must_reset_password` closure for existing seeded DBs; `listUsers()` moved off a hardcoded `demoUsers` array onto the real table with real `lastLogin` from `audit_log`. |
| **P2 — Identity** | New columns on `users` (`profile_name`, `avatar_key`, `avatar_mime`) rather than a separate table, since every display-name read already touches that row. Avatar type checked by magic bytes (not extension) — SVG explicitly refused as an XSS vector — 2 MiB cap enforced twice, EXIF/GPS stripped before write. Sessions became real (store-backed, real IP/UA/timestamp, working remote revoke); a fake "encryption keys" settings card and its `/api/keys*` endpoints were deleted outright rather than left as dead UI. |
| **P3 — Access reconciliation** | A dedicated test suite opens its *own* independent Postgres connection and compares the API response to the `users` table row-by-row, specifically to catch the case where an account provisioned by one app instance wasn't visible from a separately-created instance until restart. |
| **P4 — Share links** | See above. |
| **P5 — Snapshots/Storage** | Investigated *before* building anything: `/datalake` is plain ext4 (no LVM/ZFS/Btrfs), and the container has neither `smartctl`/`mdadm` nor `CAP_SYS_RAWIO`/`CAP_SYS_ADMIN` — measured, not assumed. Built the smallest real thing possible instead: `file_versions` + a `versions/` byte store with a restore path that returns actual prior bytes, and capacity read from `fs.statfs`. Fabricated disk-health/RAID/backup UI was deleted and replaced with an honest "unavailable, and why" state (see [[concepts/Honest_Telemetry_and_Unavailable_States]]). |
| **P6 — Dashboard** | A hardcoded 7-day transfer array (with a fake "projected" flag) replaced by real `audit_log` counts; hardcoded capacity numbers (`342 GB` / `1024 GB`) replaced by `statfs`. Units deliberately reported as **event counts, not GB** — `audit_log` has no per-event byte size, and adding one is flagged as a separate privacy decision rather than guessed at. |
| **P7 — Cleanup** | 132 dead i18n lines removed (leftover snapshot/RAID/backup/zone-label strings), a duplicate `copied` key fixed, `auditViewer` test suite added. |

### Bugs found *while doing the work* (not part of the original audit)
- Audit writes were fire-and-forget under Postgres — a **denied** request could answer `403` before its `DENIED` row actually committed, so a rejected attempt could vanish from the forensic record. All 21 call sites now `await`.
- The rate limiter shared one IP counter across login *and* share-link password attempts (see [[summaries/02_Security_Auth_and_Identity]]).
- Uploads over 1 GiB were silently dropped from the queue with no row and no error — indistinguishable from a broken app. Now shows a failed row with the limit stated.
- The delete-confirmation dialog's copy promised snapshot recovery that doesn't exist; corrected in all three languages, and version bytes are now actually removed on delete (matching the "permanent" claim).
- `vaultCrypto.test.js` was flaky — it searched base64 output for the substring `'pdf'`, which appears by chance roughly 1 run in 400. Fixed to search for a character base64 cannot produce.

### Verification
Current release baseline: **122/122 against isolated real PostgreSQL**, 0 fail, 0 skip; the normal in-memory run is 104 pass + 18 PostgreSQL-only skips. The latest Postgres run used a temporary `aegis_drive_test` because the suite performs destructive cleanup and password/user mutation without a suite-wide rollback. `TEST_DATABASE_URL` was scoped to a read-only-source ephemeral runner; live counts and health stayed unchanged; the runner, anonymous volume, sessions, and database were removed afterward. The earlier live-server walkthrough remains valid: login through the force-reset gate → upload → new version → password-protected share link → anonymous redemption returning real bytes → hit-counter increment → restore returning the earlier bytes → capacity from `statfs`.

---

## The empty-state contract, and the error box that outlived it (2026-08-07, three passes)

1. **Dashboard** — page-level `if (dash.error) return <ErrorState>` replaced by a stable zero/empty payload contract (`src/lib/dashboardState.js`); the seeded in-memory dev fallback stopped masquerading as NAS telemetry.
2. **Every other authenticated screen** — a shared health-derived `placeholderMode` from `App.jsx` keeps fixture rows out of the presentation while all chrome, actions, filters and headers stay mounted.
3. **The leftover error panel** — passes 1–2 gated the *data* but not the *error*, so each screen rendered its correct empty state **and** a red "โหลดหน้านี้ไม่สำเร็จ / เซิร์ฟเวอร์ Drive ไม่ตอบสนอง" box on top, while the header still read `Edge node: online`.

4. **The audit and closure** — rendering the real components in jsdom confirmed `db=postgres` + every `/api/*` failing → **9/9 screens show the error box with a working Retry**, 0/9 false positives when healthy. Its four surrounding findings are now fixed: Shares surfaces its secondary `/api/files` failure, `isPlatformWired` is the one predicate, `App.jsx` owns the one `/healthz` poll, and Dashboard no longer double-signals error + `ยังไม่เชื่อมต่อ`. The complete harness and focused repository regressions both pass. Method: [[concepts/Client_Render_State_Verification]].

> The third pass is the interesting one, because the obvious diagnosis was wrong. The box looked like a component someone forgot to delete; it was not. `useApi` had a real failed fetch behind it, and the pill was equally truthful — with no PostgreSQL pool, `checkDb()` answers `{ ok: true, mode: 'memory' }`, so `/healthz` is genuinely green while every `/api/*` read genuinely fails. Two accurate signals, one missing distinction: **reachable** is not **wired**. Deleting the component would have thrown away the real error path; the fix was to narrow the condition it renders under. `src/lib/fetchState.js` now owns both `isPlatformWired` and `visibleFetchError`; no screen reads a raw `api.error`, and App/Dashboard cannot drift onto different definitions of "wired".

## First-login password reset becomes a real client flow (2026-08-07)

The backend force-reset gate was already correct, but Drive treated its intentional `403 PASSWORD_RESET_REQUIRED` as a broken data endpoint. `src/lib/api.js` now preserves that code as a distinct error kind. `App.jsx` derives one `protectedDataEnabled` boolean from the session and passes `null` to Dashboard, health, files and users hooks while `mustResetPassword` is true; no protected screen is created before the branch.

`MandatoryPasswordReset.jsx` is a full-screen reset-only surface with current temporary password, new password and confirmation. Password values remain component state only. It calls the existing `/api/password/reset`, distinguishes invalid-current and weak-password responses, suppresses the global 401 interceptor for the endpoint's intentional wrong-current response, and unlocks by flipping only the in-memory session flag after a successful server response. `tests/passwordResetGate.test.js` pins first-class error classification, zero protected requests before reset, natural hook startup after reset without reload, and the normal-session bypass.

## Open items
See [[summaries/08_Outstanding_Items_Consolidated]] — encryption at rest, off-site backup, per-user share defaults/snapshot schedule, session-store persistence across restarts, and the still-open `confirmDelete()` 403-swallow bug in `Files.jsx`.
