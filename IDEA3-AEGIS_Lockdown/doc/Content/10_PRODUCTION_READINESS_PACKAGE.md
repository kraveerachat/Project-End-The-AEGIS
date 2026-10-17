# IDEA3 live status — Production readiness package (DOCUMENTATION ONLY)

> **Nothing in this file was run.** Every command below is for the Human Owner / infrastructure owner, is marked `OWNER-ONLY`, and requires the written authorization and maintenance window described in `AGENTS.md`. The unattended development session that wrote it used no sudo, changed no service, network or file under `/opt/aegis-idea3`, `/etc/aegis-idea3`, `/var/lib/aegis-idea3` or `/run/aegis-idea3`, published no MQTT and touched no hardware.

Companion design: `09_LIVE_STATUS_TRANSPORT_DESIGN.md`. Status vocabulary: VERIFIED / HYPOTHESIS / UNKNOWN as defined there.

## 0. What is and is not production live

| Item | State |
|---|---|
| Desktop reader without sudo, publisher tool, Web ingest contract, consistency tests | **Repository + offline verified** (this task) |
| Production Core publishing the projection | **Not installed.** Needs an installed release containing the tool and an owner-approved unit/group |
| Production Web receiving Core status | **Not implemented, not deployed.** Needs the route, flag, Core pusher, HUB reachability |
| Desktop on the Production host with live data | **Blocked** until the owner provides a readable projection path |
| Hardware relay/ACK/heartbeat evidence | **Never claimed.** All three stay UNKNOWN |

## 1. Core

VERIFIED (read-only inspection recorded in STEP 38.1/38.2): installed release `954ce1c191885e9e90198a6f54a3d990bcf144fc` (merge of PR #371); main is ahead by 13 `aegis_soc` files (`config`, `controller`, `cut_client`, `incident_view`, `local_cut`, `local_restore`, `mqtt_client`, `observer`, `production_runtime`, `recovery_core`, `runtime`, `supervisor`, `windows_launcher`; +1422/−11). The service runs as `aegis-idea3`, its runtime directory is `0700`.

Needed before any rollout:
1. **Release identification:** record the exact main SHA that contains this PR once merged (`git rev-parse origin/main`); build it only through the existing governed release builder (`deploy/pr11-phase4/p4-l7-build-release.py`), never by hand-copying files into `/opt`.
2. **Compatibility:** the projection and the Desktop reader consume the Core's `status.json` fields listed in `aegis_soc/observer.py` (`_REQUIRED_FIELDS`). Compare the installed release's `RuntimeStatus` fields with main before trusting the output (UNKNOWN today).
3. **Publisher integration (owner decision):** run `tools/status_projection_publisher.py` as the Core user so it reads the private file as its owner, writing to a dedicated directory:
   - Group decision: a dedicated group (suggested name `aegis-idea3-status`) containing only the Desktop operator accounts. Do **not** reuse `aegis-idea3` and do **not** loosen `/run/aegis-idea3`.
   - Directory: created by the owner (for example by systemd `RuntimeDirectory=` with mode `0750`), owned by the Core user, group `aegis-idea3-status`. The tool refuses anything group/world-writable, world-accessible, symlinked, not owned by the publishing user, or inside `/run/aegis-idea3`, `/var/lib/aegis-idea3`, `/etc`, `/opt`, `/usr`.
   - Reading needs only group membership; the tool never changes ownership or permissions.
   - A reference unit is in `deploy/aegis-idea3-status-publisher.service.example` (TEMPLATE, NOT INSTALLED).
4. **Preflight (OWNER-ONLY, read-only):** `systemctl show aegis-idea3-core.service -p MainPID,ActiveState`, `readlink /opt/aegis-idea3/current`, `stat -c '%U:%G %a' /run/aegis-idea3`, confirm free disk (the repository's own gate fails at ≥90%).
5. **Installation sequence (OWNER-ONLY, not run):** stage new release → verify hashes → install unit → create group → add operator → start publisher → verify output → only then consider the Web pusher. Never restart the Core as part of the publisher step.
6. **Rollback:** stop and disable the publisher unit (the output ages to STALE → UNKNOWN on every consumer); remove the group membership; the Core and `current` symlink are untouched by this step. Core release rollback is the existing `current` symlink flip to the previous release.
7. **Verification (OWNER-ONLY):** as the operator account, `python -m tools.status_projection_publisher --source … --dest-dir … --once` against a **copy** first; then read the output with `python - <<…` through `aegis_soc.observer.read_observer_status`; confirm `FRESH`, then stop the publisher and confirm UNKNOWN within `--max-age`.

## 2. Web (HUB `192.168.10.10`)

UNKNOWN: current container, image, flags, uptime. HISTORICAL: receipt `2026-09-28_060304_music_idea3-web-r2-production-closeout` records image `aegis-idea3-web:weblive-f839a4738409`.

Needed:
1. **Existing state verification (read-only, by Kla on the HUB):** container name/image/health/start time/restart count; feature flags by name only (never print secret values); `/healthz`, `/security/`, `/security/api/readiness` with **certificate validation on**; certificate subject/issuer/validity dates.
2. **Image provenance:** build from the merged main SHA, record the digest and the source revision label; compare with the running image. Keep the previous image tagged for rollback.
3. **Authentication/session requirements (unchanged and verified in source/tests):** admin password hash and session secret from owner-controlled secret files, `NODE_ENV=production`, dev login and demo disabled, session cookie `Secure; HttpOnly; SameSite=Strict`, CSRF on mutating routes, audit repository on a persistent volume.
4. **Status feed:** not configured today (`AEGIS_IDEA3_RUNTIME_STATUS_URL` unset in the compose files). The recommended path is the Core→HUB push in `09_…` (needs the Web route and an independent enable flag, which do not exist yet). Do not point `AEGIS_IDEA3_RUNTIME_STATUS_URL` at a LAB bridge: the production config refuses LAB feeds.
5. **TLS/mTLS dependencies:** server certificate for `idea3-core.aegis.internal`, dedicated client CA and CRL, Core client certificate (all owner-controlled; none created here).
6. **IDEA1/IDEA2 preservation:** compare container identities and mounts before and after, as in the WEB-R2 closeout. Never `docker compose down`, never `--remove-orphans`, never `up` without a service name.
7. **Readiness/health:** `/security/api/readiness` returns `READY`; the machine path must return 404 to browsers/external callers; the status route (when it exists) must be reachable only through the mTLS name.
8. **Rollback:** previous image and compose, scoped `p2a-rollback.sh`, never a full stack restart.

## 3. Desktop

1. Prerequisites: the Desktop must run on a host where an owner-approved readable projection exists; set `AEGIS_CORE_STATUS_FILE` to that **absolute** path. The reader never runs `sudo` or any subprocess; without a readable file it shows UNAVAILABLE/UNKNOWN.
2. No-sudo verification: `tests/test_observer.py` and `tests/test_live_purple_desktop.py` fail if any subprocess starts on the status path; on the host, `AEGIS_CORE_STATUS_FILE` pointing at an unreadable path must show UNKNOWN, not crash.
3. Login and page acceptance: the eight accepted pages (overview, incidents, devices, lockdown, recovery, audit, diagnostics, settings) — GUI-only manual acceptance **pending** (no real Core status was available).
4. Real Core validation: compare the Desktop header values with `status.json` as read by the Core operator; they must match field-for-field and go to UNKNOWN when the publisher stops.
5. Offline/disconnected: missing, stale (>120 s), future, malformed, oversized, symlinked and contradictory files all show UNKNOWN.
6. Shutdown: `tools/graceful_exit.py` path unchanged. CUT/RESTORE remain disabled unless the existing enable flag and socket are set by the owner; this task changes neither.

## 4. Infrastructure issues — separate from this source task (do not fix unattended)

| Issue (VERIFIED at STEP 38.1/38.2) | Why it matters | Owner action (not run) |
|---|---|---|
| `wlp0s20f3` is a Wi-Fi client (`Pboo_2.4`, `192.168.1.117/24`), not the IDEA3 AP | AP address `10.77.30.1` absent | Decide whether the radio serves the AP or the LAN; the L34 recovery path exists for `STALE_BROKER_AP_DOWN` |
| `aegis-idea3-mosquitto.service` restarting (`NRestarts=16946`, "Cannot assign requested address" on `8883`) | consequence of the missing AP address; also warns `passwd`/`acl` are not owned by `mosquitto` | fix after the AP decision; correct file ownership |
| `aegis-idea3-dnsmasq.service` failed (`start-limit-hit`) | `ExecStartPre` waits for the AP state | same root cause |
| System `mosquitto.service` listens plaintext on `0.0.0.0:1883` and `[::]:1883` (auth required) | Production code refuses `1883`; credentials travel plaintext on the LAN | owner to confirm intent; bind to loopback if it is only for LAB |
| No route Core host → HUB | the recommended push cannot work | network owner |
| HUB/Core clock discipline unknown | freshness windows are 120 s | verify NTP |
| Core release behind main | field compatibility unknown | governed release |
| `/etc/aegis-idea3/github-token` (`0600 root`) exists | not read; owner to confirm it is needed | owner |

## 5. Gates before any Production step
1. Written Human Owner authorization and maintenance window. 2. Independent human review of the reviewing PRs (AI review is not approval). 3. Read-only HUB inventory delivered. 4. Core release built through the governed builder and compared with the installed one. 5. Rollback artifacts staged. 6. Nothing here is executed by an automated session.
