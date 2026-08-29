---
title: Outstanding Items — Consolidated
tags: [aegis, summary, outstanding, open-items, tracking]
type: summary
created: 2026-08-06
updated: 2026-08-29
sources: ["[[log]]", "[[core/system-overview]]"]
owner: kla
edit_policy: owner-writable
---

# 🚦 Outstanding Items — Consolidated

> Every 🔴/🟠/🟡/🟢/⚠️ flag left behind across every session in `[[log]]`, gathered into one list instead of scattered across a dozen "Carried forward" sections. Severity markers are kept as the original sessions used them: 🔴 = real functional gap, 🟠 = known limitation (often infra-blocked, not code), 🟡 = cosmetic/deferred-by-choice, 🟢 = designed but not yet implemented, ⚠️ = operational caveat to remember, not a bug.
>
> Status is reconciled through the infrastructure readiness evidence dated **2026-08-15**.
> SSH hardening, VLAN 30 on-site reachability, backup/restore, service persistence
> and controlled host reboot are closed. UFW production rules, Docker/Twingate
> restart policies and server-side post-reboot health are now verified.
> Phase B Formal Current Production Audit STEP 1–9 and Documentation Checkpoint 2
> are **COMPLETED** read-only. Phase C / Web Functional Testing is **NOT STARTED**
> and waits for human final review. See [[infrastructure/deployment/Docker-Stack-Plan]].
>
> Items marked **Awaiting go-ahead** were found by an audit and reported with a specific fix, but deliberately left unapplied pending the user's confirmation — they are open by decision, not by oversight.

---

## 🔴 Real functional gaps

| Item | Module | Detail |
|---|---|---|
| No real face-recognition model | IDEA2 | `PlaceholderRecognizer` only finds Haar boxes → everything is `Unknown`. Seam is fully wired (`matched_name`, confidence, DB columns); the model itself is the only missing piece. Largest tracked gap in the whole project. |
| `confirmDelete()` swallows 403 | IDEA1 (`Files.jsx:353-365`) | A denied delete fails silently instead of surfacing the error to the user; re-verified open across two later sessions, still outside the scope of every pass that touched the area. |
| `LARGE_FILE_TRANSFER_V2 = IN_PROGRESS` | IDEA1 | Confirmed as an **application transfer architecture** defect, not a VLAN/LAN/Twingate bandwidth defect: the old path sent one logical file in one HTTP request and required the whole file in browser RAM (Vault ~64 MiB ciphertext, Files backend 1 GiB, HUB `/drive` 512 MiB). Stage **LFT-V2-A** (Normal Files: resumable bounded-chunk upload, durable session state, incremental hashing, server-side final SHA-256 verification, configurable logical limit and free-space reserve) is **source-complete**. The PostgreSQL integration gate (2026-08-28) **passed** against a real isolated PostgreSQL 15.18 — full IDEA1 suite **454/454 with zero skips**, both database lifecycles proven, migration idempotent and non-destructive — and it found and fixed two real defects: the migration granted `drive_app` nothing when applied by a different superuser than the one that ran `ALTER DEFAULT PRIVILEGES` (a rule that now binds every future migration), and a failed metadata write left a session that reported itself ready while its bytes were gone. **The migration has NOT been applied to production and nothing has been accepted in production.** **LFT-V2-B** (Private Vault chunked zero-knowledge transfer) is now **source-complete and verified locally and against real PostgreSQL 15** — full IDEA1 suite **586/586 with zero skips**, `004_vault_v2.sql` proven additive and idempotent and granting `drive_app` DML explicitly when applied by a different superuser. V1 vault blobs are untouched and still fully readable; `MAX_VAULT_CIPHERTEXT_BYTES` is deliberately **unchanged**. Recorded limitations: `VAULT_BROWSER_REFRESH_RESUME = NOT_IMPLEMENTED`, `LARGE_V2_VIDEO_PREVIEW = LIMITED`, `VAULT_V1_NEW_UPLOAD = SUPPORTED_BUT_UNUSED_BY_UI`. **Nothing has been deployed and no Vault migration has been applied to production.** **LFT-V2-C** is now **source-complete and edge-config verified**: HUB and gateway apply 64m Normal / 65m Vault chunk caps, disable request buffering for chunks, use 120-second chunk inactivity windows, allow 600 seconds only for commits, and stream V2 downloads without proxy buffering while preserving the parent 512m V1 upload behavior. Structural parity tests and a disposable real-nginx syntax/routing/header smoke passed. **The edge configuration has NOT been deployed or accepted in production.** **LFT-V2-E1** (truthful transfer speed/ETA + a bounded 32 GiB deployment ceiling) is **source-complete and locally verified**: a new `src/lib/transferRate.js` derives rate and time-remaining from real bytes only — rolling window, an evidence floor before any number is shown, an honest stalled state, and resume baselining so a resumed session cannot report an impossible rate — rendered in the Vault panel in EN/TH/ZH. `MAX_SUPPORTED_LOGICAL_FILE_BYTES` = `34_359_738_368` now bounds what a deployment may configure, replacing an effectively unbounded `Number.MAX_SAFE_INTEGER`; **defaults are unchanged at 5 GiB** and an over-large value fails at boot rather than being clamped. Both `/limits` endpoints expose `maxSupportedLogicalFileBytes` beside the enforced value. Full IDEA1 suite 611 tests / 544 pass / 0 fail / 67 PostgreSQL-gated skips, build passed. **Nothing deployed, nothing accepted in production, and no multi-gigabyte transfer was measured.** **LFT-V2-E2** (bounded-concurrency Vault upload) is **source-complete and locally verified**: the strictly serial upload loop became a fixed worker pool over one shared queue, with one-index-one-writer guaranteed by a synchronous queue increment rather than by timing, a fresh IV on every encryption including retries, exactly-once commit, unchanged resume authority, and the whole-file-read regression test now running at concurrency 4 while recording every slice range. Progress uses disjoint settled/in-flight counters that a chunk moves between in adjacent statements, so it cannot double-count. Defaults moved: `VAULT_CHUNK_PLAINTEXT_BYTES` 16 MiB → 32 MiB and a new `VAULT_UPLOAD_CONCURRENCY` = 2 (range 1–4), which raises **peak tab memory to ≈ 128 MiB from ≈ 32 MiB** — a constant that does not grow with the file, reducible by env with no code change. Full IDEA1 suite 621 tests / 554 pass / 0 fail / 67 skips, build passed. **No throughput improvement is claimed and none was measured.** **LFT-V2-E3** (streaming preview for large encrypted video) is **source-complete and locally verified**: a same-origin Service Worker scoped to `/drive/` serves a virtual `/drive/__vault_preview/<token>` URL, mapping each Range request to the minimum chunk set, fetching only those chunks from the existing authenticated endpoint, rebuilding the AAD locally and streaming decrypted bytes one chunk at a time — so peak memory is one chunk regardless of file size, and opening a preview downloads nothing. The DEK crosses as a non-extractable CryptoKey in worker memory only (no storage, **no Cache API**, `Cache-Control: no-store`), and modal close, vault lock, auto-lock and unmount each revoke it. A failed authentication tag stops the stream and the UI reports an integrity failure. **CSP was not widened** and the 64 MiB buffered ceiling was **not** raised; still-image preview is unchanged. Browsers lacking Service Worker or ReadableStream get a truthful "cannot stream, download instead" message, never a silent whole-file buffer. Full IDEA1 suite 649 tests / 582 pass / 0 fail / 67 skips, build passed, HUB CSP parity 10/10. **Never run in a real browser: no video was played, no seek performed, and no compatibility matrix produced.** `LARGE_V2_VIDEO_PREVIEW` moves from `LIMITED` to `STREAMED` for video only. **LFT-V2-D** remains a future production deployment and acceptance matrix, not a result. See [[concepts/Large_File_Transfer_V2]]. |
| No encryption at rest for Data Lake uploads | IDEA1 | Only the Private Vault path (Argon2id + envelope AES-256-GCM) is encrypted; regular file uploads remain plaintext. The UI overclaim is closed: Uploads now labels this limitation explicitly and no longer uses an encryption-success badge for ordinary files. Implementing encryption at rest remains a separate architecture task. |
| No off-site backup | IDEA1 | Storage is a single ext4 volume; P5 of the mock-removal pass explicitly reported this as infra-blocked rather than built a fake backup UI. |
| No per-user share defaults / snapshot schedule | IDEA1 | Design decision not yet made, not a bug. |
| Dev-only `gateway/nginx.conf` still case-sensitive on `/monitor/internal/` | Infra | Production `HUB-AEGIS_Entry/nginx.conf` was fixed to a case-insensitive regex guard (2026-07-26); the dev-compose gateway config was never patched to match, so the bypass re-verified still open. |
| Twingate governance follow-up | Infra / Remote access | Runtime/Admin Console/SSH path PASS. Current tokens are SET and functional; token creation/rotation timestamp is not exposed or verified and no rotation is required now. `Admin` membership still needs a current least-privilege audit. |
| Production DB credential lifecycle | Infra / PostgreSQL | Runtime app credentials are SET/NON-DEFAULT, SCRAM and endpoint-isolated; known dev defaults are not used. Future expiry/rotation policy needs controlled planning and re-verification; never store values in vault/repo. |
| No heartbeat *history* (uptime %, 24h disconnects, latency sparkline) | IDEA2 | Current heartbeat only proves live/dead at a point in time; needs a time-series table to show trend data honestly instead of a fake sparkline. |
| No `audit_log` table in IDEA2 | IDEA2 | IDEA1 has full audit logging; IDEA2's forensic trail is limited to what `camera_heartbeat`/`detections` incidentally capture. |
| Multi-camera deployment not implemented | IDEA2 | Running two Detection Engine instances (one per camera) is design-confirmed (distinct `AEGIS_CAMERA_ID`/`AEGIS_STREAM_URL`, shared `MONITOR_INTERNAL_URL`/key) but not built — see 🟢 below. |
| Notification preferences are UI-only | IDEA2 | Settings screen presents controls that don't yet wire to real delivery logic beyond the Telegram routing that does exist. |

## 🟠 Known limitations (often infra-blocked, not code)

| Item | Module | Detail |
|---|---|---|
| SMART/RAID telemetry and filesystem snapshots unavailable | IDEA1 | Measured, not assumed: the container has neither `smartctl`/`mdadm` nor `CAP_SYS_RAWIO`/`CAP_SYS_ADMIN` on plain ext4. Correctly reported as "unavailable, and why" per [[concepts/Honest_Telemetry_and_Unavailable_States]] rather than faked. |
| Session list does not survive restart | IDEA1 | Backed by `MemoryStore`; needs a shared/persistent session store before running multiple app instances. |
| Safari does not support `multipart/x-mixed-replace` in an `<img>` tag | IDEA2 | Live MJPEG streaming works in Chrome/Firefox-family browsers; Safari needs a different delivery mechanism if it must be supported. |
| `object-fit: cover` will misalign bounding boxes once real bbox telemetry exists | IDEA2 | Needs to become `object-fit: contain`, or normalized coordinates will be off by the cropped margin — currently harmless only because the recognizer is a placeholder. |

## 🟡 Cosmetic / explicitly deferred by user choice

| Item | Module | Detail |
|---|---|---|
| ~5 stacked "redesign pass" CSS blocks with duplicate `:root`/`.hero`/`.topbar`/`.panel`/`.side` declarations | IDEA2 (`src/index.css`) | Each later block silently wins the cascade, leaving earlier ones as dead code. Flagged to the user before a 2026-08-01 session touched the file; **explicitly deferred by their own choice**, not an oversight. |
| i18n rollout incomplete | IDEA2 | `lib/i18n.js` + `Settings.jsx` consume it; `Live.jsx`, `TopBar.jsx`, `Sidebar.jsx`, `Footer.jsx`, `Detection.jsx`, `Diagnostics.jsx`, and `Login.jsx` still render hardcoded English/Thai strings. In progress since 2026-08-01, not yet finished as of the latest entry. |
| Design-hook false positives | Both | `broken-image` findings on the literal string `<img>` inside code comments (IDEA2 — and the same pattern re-confirmed in IDEA1 `Settings.jsx:83` on 2026-08-07) and an `Avatar` fallback pattern (IDEA1) — all confirmed false positives, left unsuppressed pending explicit confirmation rather than silently muted. |

## 🟢 Designed and confirmed, not yet implemented

| Item | Module | Detail |
|---|---|---|
| Multi-instance Detection Engine (one process per camera) | IDEA2 | Config shape agreed (distinct `AEGIS_CAMERA_ID`/`AEGIS_STREAM_URL`, shared `MONITOR_INTERNAL_URL` + key); not built. |
| Real NAS integration | IDEA2 | Current `nas_sync_clip()` is a same-disk sha256-only Phase-1 simulation; the real version (swap the Compose bind-mount source, add an actual rsync/scp step) is design-confirmed but not implemented. |

## ⚠️ Operational caveats (not bugs — remember before demoing/testing)

- **Production Compose is runtime-only.** `/opt/aegis/runtime/docker-compose.production.yml` is the verified production artifact and does not match either Git-tracked Compose file; `git pull` alone is not a complete production update.
- **Do not recreate the healthy Monitor container yet.** Its running image differs from local `aegis-prod-monitor:latest` and the running image object is no longer locally resolvable; this is a rollback/provenance gap, not a service-health failure.
- **Production state must be preserved.** `aegis_postgres_data`, `aegis_drive_storage`, runtime HUB config/certs and Monitor clip bind mounts are verified active contracts. An unattached anonymous volume has unknown ownership and must not be deleted before read-only investigation.
- **IDEA1 `npm test` glob requires the verified Node 24 runner.** The package script passes the quoted argument `"tests/**/*.test.js"`; Linux Node 20.20.2 treated it as a literal path and stopped before test discovery, while Node 24.14.0 expanded it and completed 119/119. No application/test code was changed during the run-and-report pass. If Node 20 CI support is required later, adjust the runner/script only after explicit approval.
- **Demo credentials rotate on isolated test runs.** IDEA1's seeded accounts are single-use per disposable test database once the force-reset gate is real; IDEA2's demo passwords were similarly rotated during the 2026-07-27 verification pass. Never use `docker compose down -v` on the Beelink production workload: it destroys volumes/state. Recreating disposable volumes applies only to an explicitly isolated local test environment.
- **Ethics documentation discrepancy** in `AEGIS_System_Design.docx` (§5.5–5.7 BOM renumbering, §2.3.4 "Terminal Account" naming, a duplicated §2.1) blocked full syllabus-alignment work pending a decision from the report's own source — see [[summaries/07_Ethics_and_Compliance]].
- **Private Vault large-file transfer stays `IN PROGRESS` until `LFT-V2-D`.** `LFT-V2-A` changed nothing in the Vault. `LFT-V2-B` now adds a second, explicitly versioned format (`formatVersion = 2`) with per-chunk AES-256-GCM, one DEK per file as before, a fresh 96-bit IV per encryption and AAD binding of format, content id, chunk index and chunk count — **source-complete and locally verified, but not deployed and not accepted in production**. `MAX_VAULT_CIPHERTEXT_BYTES` remains 64 MiB and still governs V1 blobs, which really are one whole-file GCM message; raising it, or splitting an existing V1 ciphertext ad hoc, are both still rejected. The server proves `SERVER_CIPHERTEXT_INTEGRITY` only — `SERVER_PLAINTEXT_SHA256_VERIFY` is never claimed for a zero-knowledge vault. Do not read source-complete as production-ready.
- **`.env` must exist, not just `.env.example`**, or `DETECTION_ENGINE_API_KEY` silently ends up empty inside the container and the internal-route endpoint fails secure (503) rather than open — this bit a live session on 2026-08-01.

---

## Closed since first flagged (for continuity — do not re-report these as open)

- ✅ **PHASE B FORMAL CURRENT PRODUCTION AUDIT = EXECUTION + CHECKPOINT 2 DOCUMENTATION COMPLETED** (2026-08-16): STEP 1–9, final classification, source-of-truth, service contract, preservation and blast-radius maps are reconciled. Phase C remains NOT STARTED pending human review.
- ✅ **SERVER / INFRASTRUCTURE PRODUCTION READINESS = CLOSED / PASS** (2026-08-15): Ubuntu/hostname/static IP baseline, SSH key authentication with `PasswordAuthentication no` and `PermitRootLogin no`, `ssh.socket` reboot activation, VLAN 30 on-site reachability, backup/SHA256/true restore, Windows off-host copy, service persistence and controlled host reboot recovery are verified within the documented evidence boundary.
- ✅ VLAN 30 direct validation used a friend Linux laptop at `192.168.30.99/24`: gateway `192.168.30.1` and Beelink `192.168.10.10` each returned `4/4`, `0%` loss; Drive and Monitor opened according to user-confirmed on-site browser evidence. No `curl /healthz` JSON is claimed from the screenshot.
- ✅ UFW production state: enabled/active, logging low, deny incoming/routed, allow outgoing, allow TCP/22 on `docker0` from `172.17.0.0/16`, and allow TCP/22 from `192.168.30.0/24`.
- ✅ Docker restart policy: `aegis-prod-postgres-1`, `aegis-prod-drive-1`, `aegis-prod-monitor-1`, `aegis-prod-hub-1` and `twingate-aegis-connector-02` use `unless-stopped`; Twingate has `AutoRemove=false`.
- ✅ Server-side post-reboot checks are separate from VLAN 30 screenshots: `/healthz`, `/drive/healthz` and `/monitor/healthz` returned HTTP 200 with the documented application/database health.
- ✅ IDEA1 P0 data-honesty findings closed: ordinary Uploads no longer claim encryption at rest, `POST /api/files/:id/verify` rehashes current disk bytes and detects tampering, and Dashboard Demo Override is fully removed; isolated PostgreSQL verification is 125/125 (2026-08-07).
- ✅ IDEA1 P1 data-honesty findings closed: one binary capacity formatter across Sidebar/Dashboard/Storage; active shares exclude revoked and expired rows through one store predicate; the security KPI is explicitly DENIED/BLOCKED among the latest 100; Access reports Account ready and real per-instance session counts without claiming persistence. Isolated PostgreSQL verification is 128/128 (2026-08-07).
- ✅ IDEA1 P2 data-honesty findings closed: `/healthz.layers` independently probes Express event-loop, PostgreSQL `SELECT 1`, and Storage write/read/delete with measured timings; TopBar says Drive rather than Edge node; fixed `12/4/2 ms` and staged `5/40/75/100%` upload progress are removed in favor of measured evidence/XHR byte events. Isolated PostgreSQL verification is 132/132 and live Docker health is green (2026-08-07).
- ✅ IDEA1 first-login onboarding closed: `PASSWORD_RESET_REQUIRED` is first-class, `MandatoryPasswordReset.jsx` replaces the shell, all protected hooks pause until reset, and success unlocks in memory without reload; isolated PostgreSQL verification is 122/122 (2026-08-07).
- ✅ IDEA1 Shares secondary `/api/files` false-negative fixed: the picker now shows the existing load-failed notice + Retry and never claims the list is empty after a failed request (2026-08-07).
- ✅ IDEA1 “platform wired” predicate consolidated into `isPlatformWired(healthData)`; the stale literal-source test was replaced with behavioral assertions (2026-08-07).
- ✅ IDEA1 health polling consolidated: `App.jsx` owns the only `/healthz` cycle and shares it with TopBar and Dashboard (2026-08-07).
- ✅ IDEA1 Dashboard genuine failure no longer double-signals error + `ยังไม่เชื่อมต่อ`; placeholder labels now depend on shared health only (2026-08-07).
- ✅ Add-Operator CLI + web, end-to-end (2026-07-24).
- ✅ Detection Engine wired to real DB, demo generator removed (2026-07-24 → 07-25).
- ✅ Zero automated tests in IDEA2 → 6/6 passing by 2026-07-28.
- ✅ Clip playback, CAM-02 stream, Telegram routing by camera, real heartbeat-based node status (all closed 2026-08-01).
- ✅ `GET /api/clips/:id/video` regression (vanished, then re-added same day, 2026-08-01).
