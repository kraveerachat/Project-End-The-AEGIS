---
title: Task Receipt — IDEA3 PR11 Phase 4 L7 live preparation (owner-runner readiness audit and remediation)
date: 2026-09-27T13:03:06+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l7-live-preparation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L7 live preparation (owner-runner readiness audit and remediation)

> [!important] Repository preparation only
> **L7 was NOT executed and NOT authorized. No Production mutation, no sudo, no host `systemctl`, no authorization or K3 created or consumed, no L8, no ESP32.** The L7 runner is committed as an unpinned template that refuses to run. `L7_LIVE_EXECUTED = NO`, `L7_LIVE_AUTHORIZED = NO`, `L7_LIVE_ACCEPTANCE = NOT PROVEN`, `L8_STARTED = NO`.
> Base: main `1328f66cb126531a77a627a761df697a1d902c87` (after PRs #226/#227/#228/#229). The L7 design's §1 markers (`L7_HANDLER_REGISTERED=NO`, predecessor `*_LIVE=NOT_RUN`) are historical design-time state and were not used as current truth.

## Audit result: the merged L7 handlers were NOT sufficient for a safe live L7

Read-only host facts used (no mutation): no `/opt/aegis-idea3`, no L7 credentials/core.env/unit; `aegis-idea3` account present (uid 952, gid 950); `/etc/aegis-idea3/pki` present (`root:aegis-idea3 0750`); L6b broker persistent.

Gaps found (each fixed, RED-first): (1) credentials dir `root:root 0700` vs D4 credential owned by the Core account — the service could not read it; (2) 3-line `core.env` without broker address, device id, CA path or TLS server name; (3) the Core cannot verify the DNS-only broker certificate when connecting to the AP IP ("IP address mismatch", reproduced on a throwaway broker); (4) the Core CA copy under `pki/` did not exist and the L6b CA is unreadable by the Core account; (5) no release existence or provenance proof, dangling `current` possible; (6) no unit verification, no `enable`, no stability proof; (7) rollback defaulted a missing prestate to "did not exist" and could delete pre-existing files, used `rm -rf`, never disabled/cleared failed unit state (PRE→RB drift, the L6b lesson); (8) rollback would leave `/var/lib` and `/var/log/aegis-idea3` created by systemd (PRE→RB drift); (9) verify's listener check was a no-op and it proved no status, environment, LoadCredential, connection or journal property; (10) the previous negative tests were vacuous (fixture root never set, "forbidden" key not forbidden); (11) no owner-run path existed. Details: design §7.

## What changed

- Rewrote `stages/L7/apply.sh`, `verify.sh`, `rollback.sh` to the L6b standard (journal-before-create, exact ownership plan, exact clean prestate, verified unit, `enable --now`, journal-driven rollback with `reset-failed <Core unit only>` and a proven `not-found/inactive/dead/success` end state, archive-then-remove of stage-caused runtime dirs). Ownership: credentials dir `root:aegis-idea3 0750`; four LoadCredential secrets `root:root 0600`; `restore.credential` `aegis-idea3:aegis-idea3 0600`; `core.env` `root:aegis-idea3 0640`; CA copy and unit `root:root 0644`.
- New tools: `p4-l7-release-guard.py`, `p4-l7-core-env.py`, `p4-l7-broker-probe.py`, `p4-l7-run-lib.sh`, unpinned `owner-run/run-l7-owner.sh`.
- Core change: `AEGIS_MQTT_TLS_SERVER_NAME` (verification stays fully on).
- `allow-keys.txt` +2 keys (pki CA copy); `allow-listeners.txt` still empty. Design §7, README and status note updated.

## Frozen-runner contract

Unpinned (`PIN_MAIN_SHA`, `PIN_RELEASE_ID`) and refuses to run; frozen outside the repository; normal user only; one attempt per authorization (`L7-ATTEMPT-CONSUMED`); all read-only gates before consumption; PRE capture → apply once → verify → POST capture → strict PRE→POST with the exact L7 allow files → secret scan → S10 preservation → persistent closeout; any failure after the first mutation → one bounded rollback → RB capture → zero-drift PRE→RB (no allow files); exit 3 (S-11 HOLD) if rollback or that proof fails; no automatic retry; never creates a secret, installs the release, starts L8, touches an ESP32, sends a relay command, repairs a predecessor or modifies IDEA1/IDEA2.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt` — reconciled L7 handlers.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-release-guard.py`, `p4-l7-core-env.py`, `p4-l7-broker-probe.py`, `p4-l7-run-lib.sh`, `owner-run/run-l7-owner.sh` — new.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py`, `aegis_soc/mqtt_client.py`, `aegis_soc/runtime.py`, `deploy/aegis-idea3-core.env.example` — TLS server name.
- `IDEA3-AEGIS_Lockdown/tests/l7_support.py`, `test_pr11_phase4_l7_handler.py` (rewritten), `test_pr11_phase4_l7_runner.py`, `test_pr11_phase4_l7_runner_flow.py`, `test_pr11_phase4_l7_release_guard_helper.py`, `test_pr11_phase4_l7_core_env_helper.py`, `test_mqtt_tls_server_name.py` — tests.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`, `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — documentation.

## Verification evidence

- `pytest` RED-first (before implementation) — fail: TLS server name 14 failed / 1 passed; release guard 41 failed / 1 passed; core.env tool 31 failed / 20 passed (negative tests pass trivially without the tool); L7 handler 177 failed / 19 passed on the old handlers; runner/lib 98 failed / 6 passed.
- `pytest tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_runner_flow.py` — pass: 353 passed
- `pytest tests -k phase4` — pass (see PR description for the exact count)
- `pytest tests` (full IDEA3 suite) — pass: 3313 passed, 8 skipped
- `git diff --check` — pass; `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings)

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L7 live preparation section (repository only).

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None — no cross-scope or shared path changed. Open PRs #202 (same L7 handler files, superseded by this work) and #208 (release builder, complementary) are unmerged and are not imported; the owner should close or rebase #202 after review.

## Known limitations

- **No release is installed on the host and no installer exists** (`/opt/aegis-idea3` absent); the builder is the open PR #208. Owner input (OV-09 keys, OV-11 PIN, MQTT password, D4 restore credential), Pub D6 notice, fresh same-day A-L7 and K3, IDEA2 §10 fresh state at run time and disk headroom are still required.
- Live-only, unproven offline: real `systemd-analyze verify`, `runuser`, `reset-failed`/`daemon-reload` semantics, `ss -p` output, the Core's real broker connection and heartbeat gating, and root ownership installs. Full Core preflight is the service's own (fail-closed at start); the handler proves its inputs statically.
