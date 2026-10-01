---
title: Task Receipt — IDEA3 F1 production deployment package (repository only)
date: 2026-10-02T05:05:00+07:00
owner: music
area: idea3
branch: feat/idea3-f1-production-deployment-package
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1 production deployment package (repository only)

## What changed

- **Repository-only. IMPLEMENTED != DEPLOYED.** Base `main` `bfbe1dc68c241c36e7ed6d354545567a581b5553`. Nothing was installed, enabled or started; no host command, no useradd/groupadd/systemctl, Production NOT mutated, Core NOT restarted, L7u NOT run, Recovery NOT run, no ESP32, no L8p/L8. `F1_PRODUCTION_DEPLOYED = NO`, `F1_REAL_DETECTOR_ACCEPTANCE = NO`, `CORE_RESTARTED = NO`, `RECOVERY_LIVE = NOT_RUN`. The merged F1 trust boundary (`recovery_core.py`, `supervisor.py`, `config.py`) is untouched; no #282 or #286 receipt was edited.
- **Production sink (`aegis_soc/alert_sink.py`):** AF_UNIX only; constant path `/run/aegis-idea3/alert.sock` (never from detection input); exact payload `{"v":1,"attacker_ip":"<IPv4>"}` + newline, validated with the same `validate_block_target` rules the Core ingress applies; the Core account is verified via SO_PEERCRED before any byte is written; one monotonic 2 s budget for connect/write/read; one attempt, no retry; stable secret-free result codes (`SENT_BOUND`, `SENT_EXISTING`, `INVALID_ADDRESS`, `SOCKET_MISSING`, `SOCKET_REFUSED`, `PEER_NOT_CORE`, `TIMEOUT`, `OUTCOME_UNKNOWN`, `REPLY_INVALID`, `CORE_REJECTED`). No MQTT, no network socket, no subprocess, no shell, no containment/CUT/RESTORE. It also carries the bounded `check-socket` used by the unit's `ExecStartPre=`.
- **Production detector (`aegis_soc/production_detector.py`):** same three rules and thresholds as the legacy `detector.py` (a parity test pins them); its only output is the sink. Per-address cooldown, token bucket below the Core's limit, bounded tables, and it exits after three consecutive transport failures so a missing/untrusted socket cannot become a retry storm. The legacy lab `detector.py` is unchanged and remains the only MQTT `aegis/attacker_ip` publisher; the Core, supervisor and legacy detector do not import the new modules. `MQTT_ATTACKER_TOPIC_USED_IN_PRODUCTION = NO`.
- **Detector unit (`deploy/aegis-idea3-detector.service.example`):** `Requires=`/`After=aegis-idea3-core.service`, `ExecStartPre` bounded socket check, `Restart=no`, `RestrictAddressFamilies=AF_UNIX`, only `CAP_DAC_OVERRIDE`, no EnvironmentFile/credentials/writable paths, no shell. Its only placeholder is `User=@AEGIS_ALERT_SOURCE_UID@`.
- **Identity (not decided here): `F1_ALERT_SOURCE_IDENTITY = OWNER_INPUT_REQUIRED`.** The uid is a frozen, owner-supplied, non-secret canonical decimal that must equal `AEGIS_ALERT_SOURCE_UID`; `p4-f1-alert-source.py` has no default and refuses mismatches. **Finding (proven from the merged code, not changed):** the Core creates the socket Core-owned `0600` in a `0700` runtime directory, so only root (CAP_DAC_OVERRIDE) or the Core account itself can connect. The package therefore refuses the Core account (`ALERT_SOURCE_IS_CORE_ACCOUNT`) and any uid the mode contract cannot serve (`ALERT_SOURCE_CANNOT_REACH_SOCKET`). A dedicated non-root source account would need a separate owner-approved Core change (socket/directory group access); it is not made here.
- **Core env contract (`p4-l7-core-env.py`, example comment):** `AEGIS_ALERT_SOURCE_UID` joined the canonical allowlist as an optional owner-supplied key. `render`/`check` take `--alert-source-uid`; a present key is always format-validated (canonical decimal, 0..4294967294), duplicates are refused, a supplied value must match exactly, and absent-without-flag keeps every existing L7 render/check byte- and verdict-identical. Secret keys stay forbidden; unrelated fixed settings are unchanged.
- **Start order and rollback (`p4-f1-alert-source.py`):** `start-detector` (live-gated: `AEGIS_F1_LIVE_AUTHORIZED=YES` + root) enforces identity, `core.env` verified, Core active with a MainPID whose `/proc/<pid>/environ` carries the uid (proves it restarted after `core.env` changed), `alert.sock` Core-owned `0600` in a Core-owned non-writable directory, and only then issues exactly one `systemctl start` of the detector unit. The backend allow-list is `show` of the Core and `start`/`stop` of the detector unit only: no Core restart/stop/start, no daemon-reload, no enable. `stop-detector` is one bounded `systemctl stop` of the detector unit only and fails closed without retry. It never touches the Core, `core.env`, ESP32 or containment, and never sends CUT or RESTORE.
- **L7u: `L7U_INTEGRATION_IMPLEMENTED = OWNER_POLICY_REQUIRED`.** L7u was not modified. Adding a fourth owned `core.env` line sourced from a still-undecided owner uid (and the detector start order inside its journaled transaction) is a new owner policy that is not authorized. Tests instead prove the engine and the key coexist: an installed key is preserved byte-for-byte by apply with exactly one restart, exact rollback restores a key-bearing `core.env` bytes/metadata, and L7u never names or starts the detector unit.
- **Release:** the builder gained `production_detector` as a third entrypoint (its closure adds `alert_sink`; stdlib only), with the two pinned module-set tests updated deliberately. Scratch release `f1-deploy-pkg-b83d559a` (not installed): 52 files, 28 modules, `requirements.txt` byte-identical (`paho-mqtt==2.1.0`), F1 ingress (`AlertIngress`, `AlertServer`, `on_production_alert`, `ALERT_SOURCE_UID`) present, no new dependency.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/alert_sink.py` — NEW production sink and socket check.
- `IDEA3-AEGIS_Lockdown/aegis_soc/production_detector.py` — NEW production detector.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-detector.service.example` — NEW unit template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1-alert-source.py` — NEW render/verify/ordered start/bounded stop tool.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-core-env.py` — optional `AEGIS_ALERT_SOURCE_UID` contract and `--alert-source-uid`.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.env.example` — comment block only (no active line).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-build-release.py` — third release entrypoint.
- `IDEA3-AEGIS_Lockdown/tests/test_f1_alert_sink.py` — NEW, 71 tests (sink, real `AlertServer` end-to-end, detector).
- `IDEA3-AEGIS_Lockdown/tests/test_f1_alert_source_package.py` — NEW, 125 tests (identity, unit, core.env, ordering, rollback, L7u coexistence).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py`, `tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py` — module-set and entrypoint pins updated for the third entrypoint.
- `IDEA3-AEGIS_Lockdown/README.md` — F1 deployment package paragraph.

## Verification evidence

All evidence is local and simulated (fake hosts/backends, temporary AF_UNIX sockets; no host, broker, Core or device). Scratch Python: system 3.14.7 venv with `paho-mqtt==2.1.0` from the owner's offline wheelhouse (the host's system `paho-mqtt` is 1.6.1).

- `pytest tests/test_core_alert_ingress.py -q` — pass: `60 passed`.
- `pytest tests/test_detector.py -q` — pass: `6 passed`.
- `pytest tests/test_f1_alert_sink.py tests/test_f1_alert_source_package.py -q` — pass: `196 passed`.
- `pytest tests/test_pr11_phase4_l7_core_env_helper.py -q` — pass: `79 passed` (existing L7 core-env tests preserved).
- `pytest tests/test_pr11_phase4_l7u_*.py -q` — pass: `233 passed` (engine, governance, runtime contract, builder runtime).
- `pytest tests/test_core_recovery.py tests/test_core_recovery_security.py -q` — pass: `109 passed, 1 xfailed` (the pre-existing strict R5 marker).
- Combined regression group (the above plus all L7 handler/runner/builder/guard/installer tests, Core, D4, restore authority, dispatch, containment, runtime, production runtime, credentials, broker config, protocol store, paths) — pass: `1766 passed, 1 xfailed`.
- Environment note, not a code result: with the host's `paho-mqtt` 1.6.1 the 17 `test_pr11_phase4_l7_runner_flow.py` tests fail their own pinned-python gate; they fail identically on an unmodified older main worktree and pass (31/31) once `paho-mqtt==2.1.0` is present.
- Real scratch release build `p4-l7-build-release.py build ... --release-id f1-deploy-pkg-b83d559a` against `l7u-wheelhouse` — pass: `L7_RELEASE_BUILD=PASS`, 52 files, `SOURCE_TREE_DIRTY=NO`. No install.
- `p4-l7-build-release.py verify <release> --expect-owner self` — pass: `L7_RELEASE_VERIFY=PASS`.
- L7u preflight guard, fixture-only (`load_guard().check(...)` and the four Recovery runtime files) — pass; L7u was not run.
- `ruff check` on the changed Python files — pass (the two pre-existing `PLW1510` findings in `test_pr11_phase4_l7_release_builder.py` exist unchanged on `origin/main`).
- `bash -n` — not applicable: no shell file changed.
- `systemd-analyze verify --man=no` on the rendered detector unit — pass (rc 0), also run as a skippable test.
- `git diff --check` — pass. `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings). `node scripts/validate-collaboration-policy.mjs` against the prepared Draft PR body and exact changed-file list — pass. Changed-content secret scan (private-key, cloud-key, GitHub-token, JWT, Slack, Google-key and password patterns over the added lines) — pass: 0 hits.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added a narrow section after the F1 section: `F1_DEPLOYMENT_PACKAGE_REPOSITORY_IMPLEMENTED = YES`, `F1_DEPLOYMENT_PACKAGE_LOCAL_VERIFIED = YES`, `F1_PRODUCTION_DEPLOYED = NO`, `F1_REAL_DETECTOR_ACCEPTANCE = NO`, `CORE_RESTARTED = NO`, `RECOVERY_LIVE = NOT_RUN`, `F1_ALERT_SOURCE_IDENTITY = OWNER_INPUT_REQUIRED`, `L7U_INTEGRATION_IMPLEMENTED = OWNER_POLICY_REQUIRED`. No existing section was rewritten.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Not deployed and never run live: no detector has sent an alert to a real Core socket; `F1_REAL_DETECTOR_ACCEPTANCE = NO`.
- Owner decisions still required before any deployment: the source identity (`OWNER_INPUT_REQUIRED`), and — if a dedicated non-root account is wanted — a Core change to the socket/directory access that the merged contract (`0600` socket, `0700` directory) does not allow; the L7u integration (`OWNER_POLICY_REQUIRED`); and who installs the rendered unit and `core.env` line in the governed stage.
- Detection input is the system journal read through a constant `journalctl` argv as the detector account; journal access for a non-root source is part of that unmade identity decision.
- The unit is never installed or enabled by this change; `start-detector`/`stop-detector` act only with `AEGIS_F1_LIVE_AUTHORIZED=YES` and root and have only run against fakes.
- The first protected/gateway attacker address R3 dead end, R5 and break-glass are unchanged and still deferred.
