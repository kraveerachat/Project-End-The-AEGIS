# 14 — Status sidecar deployment readiness package (STEP 38.7)

Owner-facing. **Nothing here is installed, enabled, started or deployed**, and no Production credential, systemd unit, Docker, network, broker, AP, ESP32 or relay was touched. This package prepares a later, separately authorized deployment of the **read-only status feature**. It is **not** evidence that the cyber-physical system works.

## 0. Scope: read-only status is not hardware-control readiness

| Capability | This package |
|---|---|
| Core → Purple Desktop local read-only status projection | prepared (publisher) |
| Core → Web Security Center authenticated mTLS status push | prepared (pusher + Web ingest) |
| CUT / RESTORE / MQTT publish / relay / ESP32 authority | **none added, none required** |
| AP, Mosquitto 8883, dnsmasq, ESP32 heartbeat/ACK, physical relay | **unresolved and out of scope**; a real Core may legitimately be reported DEGRADED or UNKNOWN, and that is the correct result. The status feature must never be described as accepting full cyber-physical operation. |

## 1. Proposed sidecar release (exact)

* Source SHA: the commit of `feat/idea3-live-status-transport` that is merged into `main` after PR #443 and a human review. The checkpoint at the time of writing is recorded in the receipt; the **release SHA is whatever `build-status-sidecar.py` records as `source_git_sha` from a clean checkout of the reviewed `main`**. Never build from a working checkout.
* Payload (6 files, nothing else is accepted by the verifier) and their SHA-256 at this checkpoint:

| File | SHA-256 |
|---|---|
| `aegis_soc/__init__.py` | `01218ea60fe66440840ce432d5b1ddaeb7ad93e69699f9ca77d81479e55735ea` |
| `aegis_soc/dispatch_client.py` | `fd94b4c2c29e325e8ffe24e21190dbc178344fd1519eab9a7244b3904dbce274` |
| `aegis_soc/observer.py` | `a7c37d78a73559487e37308a7b5df195c40843d6b61b56de5cb84c3018933cb8` |
| `aegis_soc/status_projection.py` | `aac0935a0091ef0188c76d0dc134fafd15763344409e785d24e178add4668fcd` |
| `tools/status_projection_publisher.py` | `24460b416ad441e6419d1af5405c3b6a95704f2a08f5f83a2e1eb5851ebadbca` |
| `tools/status_push_client.py` | `0d67956a0707f6d76b15013217fe958d293a004dc3d63be0bd7b4deafee80ca2` |

* Plus `SIDECAR-MANIFEST.json` (exact fields: `schema_version, kind, release_id, source_git_sha, source_tree_dirty, python_version, python_requires_min, file_count, created_by_tool_version`) and `SIDECAR-SHA256SUMS`.
* No venv, no `requirements.txt`, no third-party code, no Core module (no runtime, controller, MQTT, restore, CUT, database), no credential. The Core release contract and installed release `954ce1c1…` are unchanged (verified by tests).

## 2. Installer requirements (`deploy/status-sidecar/install-status-sidecar.py`, inert until an owner runs it)

* Commands: `plan` (read-only), `install`, `activate`, `rollback`, `status` (read-only). `install` never switches `current`; `activate` is a separate explicit step.
* Live use requires root and root-owned results; the ownership contract has no general override. `--host-root`, `--fixture-dest-owner-any` and `--fixture-allow-dirty` exist only for disposable fixtures and are refused without a host root. A fixture root must be a canonical, absolute, non-symlinked directory carrying the owner-created marker `.aegis-sidecar-fixture-root`, outside every system location, and neither containing nor inside the real `/opt/aegis-idea3-status` or `/opt/aegis-idea3`; `/`, `//`, `/.`, `..` spellings and symlink aliases are refused (STEP 38.8).
* A package whose manifest records `source_tree_dirty: true` is refused for install, plan, activation and rollback in live mode; only a validated fixture with `--fixture-allow-dirty` can handle a synthetic dirty package. Editing the flag in the manifest breaks the checksums.
* Touches only `/opt/aegis-idea3-status/{releases/<id>,current,previous}`. Never the Core tree `/opt/aegis-idea3`, Recovery files, `/run`, `/etc`, systemd, Docker or the network. It prints `SYSTEMD_ACTION=NONE`.
* Verified source → staged copy → installed result, each re-verified with the real builder verifier; refuses altered/extra/missing/symlinked/credential/world-writable content, an existing id, a symlinked or group/world-writable ancestor, an unsafe `current`, and an incompatible Python.
* Staging leftovers from an interrupted run are reported and never selected or silently deleted.

## 3. Host Python requirements

| Item | Finding |
|---|---|
| Declared floor (manifest `python_requires_min`) | 3.11 (the Core itself uses `StrEnum`); shipped syntax is valid from 3.8 by AST, but only the builder's interpreter was executed |
| Tested | 3.14.7 CPython (builder and all tests) |
| Core host `/usr/bin/python3` | **VERIFIED by nonprivileged inspection: Python 3.14.7, x86_64, Arch Linux** (the installed Core venv `pyvenv.cfg` also records 3.14.7) |
| Rule | the installer refuses an older interpreter, a non-CPython or non-POSIX one, and a different minor than the tested one unless the owner passes `--accept-untested-python` |
| Caveat | `/usr/bin/python3` is a rolling system interpreter and can move to a new minor on upgrade; the sidecar then needs a rebuild/re-test or an explicit owner acceptance |
| Architecture | pure Python; no architecture claim is made or needed |

## 4. Core file access policy (owner decision)

* `/run/aegis-idea3/status.json` lives in a Core-private runtime directory. **Do not change its permissions.**
* The sidecar units run as `aegis-idea3` (uid 952, VERIFIED present), which owns the Core runtime files, so no permission change is needed for the pusher or the publisher to read the source.
* The publisher writes its own `/run/aegis-idea3-status` (0750, systemd-managed) and never writes under `/run/aegis-idea3`.

## 5. Dedicated status group (HUMAN DECISION REQUIRED)

* Currently no status group exists (groups present: `aegis-idea3`, `aegis-idea3-detector`, `aegis-idea3-recovery`, `aegis-idea3-alert`). The publisher template uses the placeholder `Group=<AEGIS_STATUS_GROUP>`.
* The owner must decide: the group name; which Desktop operators join it (the current operator account is a member of `aegis-idea3-recovery`, which must **not** be reused for status); or whether to run the Desktop with `AEGIS_CORE_STATUS_FILE` pointing at a user-readable copy. Group membership and `groupadd` are privileged and are not performed here.

## 6. Publisher and Pusher unit prerequisites (templates, not installed)

Reviewed by `tests/test_status_sidecar_units.py` and `systemd-analyze verify` (non-mutating; the only note was the intentional `<AEGIS_STATUS_GROUP>` placeholder).

* No `[Install]` section in either unit (the publisher template previously had one; removed). Nothing in the installer enables or starts anything.
* `After=aegis-idea3-core.service` for ordering only; no `Requires/BindsTo/PartOf/Wants/OnFailure/Conflicts` on the Core; no `ExecStop*`, no `systemctl`. A failure or restart of either unit cannot stop or restart the Core.
* Unprivileged `aegis-idea3`, `NoNewPrivileges`, empty `CapabilityBoundingSet`, `ProtectSystem=strict`, read-only `/run/aegis-idea3` and `/opt/aegis-idea3-status`, no devices/kernel/cgroup/clock access, `SystemCallFilter=@system-service`, `UMask=0077`, `TimeoutStopSec=10`, bounded restarts (`StartLimitBurst=5` in 300 s). Publisher: `AF_UNIX` only plus `IPAddressDeny=any`. Pusher: `AF_INET/AF_INET6` and an owner decision to add `IPAddressAllow=<HUB>` once the route is known.
* Pusher: `/etc/aegis-idea3/status-push.env` (from the `.env.example`, paths only, never key material) and read access to the Core client certificate/CA files by path.
* A stopped publisher removes its runtime directory, so the Desktop then reads UNKNOWN (fail-closed).

## 7. Web feature-flag prerequisites

`AEGIS_IDEA3_STATUS_INGEST_ENABLED=true` (default false), `AEGIS_IDEA3_DISPATCH_{PORT,TRUSTED_PROXY,EXPECTED_SUBJECT}` for the shared machine listener, and **no** `AEGIS_IDEA3_RUNTIME_STATUS_URL`/LAB feed with it (config refuses the combination). Enabling it does not enable dispatch. The deployed Web container revision is UNKNOWN until a HUB operator runs the read-only package in doc 12 section 3.

## 8. HUB / NGINX and mTLS readiness — UNKNOWN

No access to the HUB host from here. Required and unverified: the nginx machine block forwarding `X-Aegis-Client-Verify` / `X-Aegis-Client-DN` for `/api/machine/v1/status`, certificate chain and expiry for the Core client identity, CRL, and hostname `idea3-core.aegis.internal` resolution from the Core host.

## 9. Core-to-HUB network — BLOCKED/UNKNOWN

No verified route or DNS from the Core host to the HUB (doc 12). The TLS handshake probe needs owner authorization and was not run.

## 10. Clock synchronization

On the Core host, nonprivileged `timedatectl` reports `NTPSynchronized=yes` (VERIFIED at this moment, one host, one instant). The HUB clock is UNKNOWN. Freshness uses the Core `updated_at`, so a skewed HUB clock can wrongly age or future-date evidence.

## 11. Current infrastructure blockers (unchanged, not touched)

* AP down (the Core host is a Wi-Fi client), Mosquitto 8883 not listening (no listener on 8883 observed), dnsmasq failed, ESP32/relay path unverified.
* **Port 1883 is listening plaintext on all interfaces (`0.0.0.0:1883` and `[::]:1883`, observed with `ss -ltn`)**. This is a security issue independent of this feature; no change was made. It needs a separate infrastructure change with the owner.
* The Core service `aegis-idea3-core.service` is active and enabled on this host (read-only query). It was not touched.

## 12. Before/after preservation checks (run by the owner around a future install)

Record before and after and require equality: `readlink /opt/aegis-idea3/current`; `sha256sum` of `/opt/aegis-idea3/releases/954ce1c1…/RELEASE-SHA256SUMS`; `systemctl show -p MainPID,ActiveEnterTimestamp aegis-idea3-core.service` (MainPID and start time must not change); Recovery files/units untouched; `ls -l /run/aegis-idea3` mode unchanged; `ss -ltn` listener set unchanged; no new enabled unit. The tests assert the same invariants on disposable trees.

## 13. Rollback steps

* Before activation: nothing to undo; remove nothing (an installed-but-inactive release is inert).
* After `activate`: `install-status-sidecar.py rollback` selects the previous release only after re-verifying it in full; no release is deleted. If any unit was separately started by the owner, stopping it is an owner action and has no effect on the Core.
* There is no automatic rollback and no rollback ever sends CUT/RESTORE or any device command.

## 14. Actual LIVE acceptance criteria (human-observed, owner-run, not performed)

1. Sidecar verified from the reviewed `main` SHA; installed and activated by the owner; Core unchanged per section 12.
2. Pusher enabled by the owner in a written maintenance window; HUB reports `ACCEPTED` and the Web Security Center shows the Core's own `generatedAt` advancing, not the Web clock.
3. Stop the **pusher only** (never the Core): the Web evidence ages to UNKNOWN within the freshness window; restart it: evidence resumes.
4. Web restart yields UNKNOWN until the next push.
5. Relay, ACK and heartbeat stay UNKNOWN unless real physical evidence exists; DEGRADED/UNKNOWN is accepted as the honest result while hardware dependencies are unresolved.
6. Desktop shows the same freshness and states as the Web for the same `updated_at`.
Until all of this is done by a human on the real system, the status is **not LIVE**.
