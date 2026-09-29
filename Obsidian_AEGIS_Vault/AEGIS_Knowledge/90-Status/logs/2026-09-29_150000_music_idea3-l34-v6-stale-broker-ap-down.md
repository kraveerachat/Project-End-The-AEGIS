---
title: Task Receipt — IDEA3 L34 V6 stale-broker/AP-down reactivation (repository only)
date: 2026-09-29T15:00:00+07:00
owner: music
area: idea3
branch: fix/idea3-l34-v6-stale-broker-ap-down
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L34 V6 stale-broker/AP-down reactivation (repository only)

## What changed

- New governed V6 reactivation `l34-v6-stale-broker-ap-down` (baseline `STALE_BROKER_AP_DOWN`), repository only: `apply.sh`, `verify.sh` (with the frozen 6 x 5 s soak), `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`, plus the owner runner `run-l34-v6-stale-broker-ap-down-owner.sh` (unpinned template that refuses to run as committed). BASE_MAIN `a888457e1ae415d9ec5d70b88bc4bb34514516f6` (PR #250 and PR #251 in ancestry).
- The TLS proof reuses the unchanged `p4-l7-broker-probe.py` once against `10.77.30.1:8883` (no `openssl`, no MQTT bytes, never `127.0.0.1`).
- The broker is never commanded. Apply, verify, every soak sample and rollback prove `MainPID`/`NRestarts`/`InvocationID` equal PRE plus the exact stale 8883 pair; any change is `S11_HOLD_ESCALATE`, never a repair. Normal apply issues no `reset-failed`; rollback may issue one exact-unit `reset-failed` only if the journaled `DNSMASQ_START` left that unit failed. Journal kinds are exactly the four frozen ones. Legacy `:1883` must stay byte-identical and no new plaintext `:1883` may appear.
- Owner-runner consume order: pre-gates, handler PREFLIGHT_ONLY, PRE capture + hash, final broker-tuple equality, atomic consume, full handler preflight, production-mutation marker, first mutation. A PRE capture failure does not consume the attempt.
- V1–V5 are byte-identical (pinned by hash); the shared gate library and simulator were only appended to.
- No Production mutation, no service command against the real host, no live authorization or K3 created, no L4 execution or retry, no L6c/L7, no ESP32 access, no PR252/PR238/PR249 edits. Not merged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v6-stale-broker-ap-down/apply.sh` — V6 apply handler.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v6-stale-broker-ap-down/verify.sh` — read-only verification and 6 x 5 s soak.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v6-stale-broker-ap-down/rollback.sh` — journal-driven rollback with the broker-preservation proof.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v6-stale-broker-ap-down/allow-keys.txt` — dnsmasq and target-interface keys only; no broker key.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v6-stale-broker-ap-down/allow-listeners.txt` — dnsmasq's three AP listeners only.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-v6-stale-broker-ap-down-owner.sh` — owner-run template with the V6 scope and consume ordering.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — additive `l34_v6_*` functions only.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — additive V6 simulation knobs (all default to V1–V5 behaviour).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v6_stale_broker_ap_down.py` — V6 handler matrix.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v6_owner_run_flow.py` — real-runner control-flow simulation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v6_scope_contract.py` — scope, real stage-gate parse, V1–V5 byte-identity pins.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-29-idea3-pr11-phase4-l34-v6-stale-broker-ap-down-design.md` — frozen V6 design.

## Verification evidence

- `pytest tests/test_pr11_phase4_l34_v6_stale_broker_ap_down.py` — pass: 86 passed (baseline, V3/V4/V5 rejection, unstable PID/NRestarts/InvocationID, stale pair missing/extra, dnsmasq exact PRE, listener presence, broker/openssl static bans, apply ordering, TLS pass/fail/timeout, dnsmasq start-failure + conditional reset-failed rollback, broker-change HOLD without repair, rollback twice, unrelated Wi-Fi escalation, legacy :1883, allow files, soak).
- `pytest tests/test_pr11_phase4_l34_v6_owner_run_flow.py tests/test_pr11_phase4_l34_v6_scope_contract.py` — pass: 51 passed (consume ordering, PRE-capture failure does not consume, second use rejected, rollback exit 1/3, real stage-gate parse, V1–V5 byte-identity pins, pre-V6 library prefix pin).
- `pytest tests/test_pr11_phase4_l34_*.py` excluding V6 (V1–V5 regression, PR250 semantics) — pass: 543 passed.
- `pytest tests/test_pr11_phase4*.py` (full Phase 4 suite, includes the PR251 registry test and all V6 files) — pass: 2785 passed, 2 skipped.
- `bash -n` on the V6 apply/verify/rollback, the V6 runner and the shared library — pass.
- `shellcheck` — not run: the binary is not installed on this host and no repository workflow or test invokes it (the `# shellcheck` lines in tests are directives only).
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass: 2 pre-existing canvas warnings.
- No live command was run: no Production mutation, no service/NM/nft/rfkill command against the real host, no live authorization, no L4/L6c/L7, no ESP32.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — V6 repository implementation, baseline, guarantees and remaining limits.

## Shared surfaces touched

- None — task stayed inside `idea3`.

## Integration requests

- None — valid: no cross-scope path changed. Before any live use: owner freeze/re-pin of the V6 runner, a fresh same-day V6 authorization + K3, and the still-open IDEA2 owner (Pub) decision on S10 while the IDEA2 baseline is unhealthy (unchanged by this task).

## Known limitations

- Repository/simulator only; nothing is proven live. The simulator models a stale bound socket by keeping the broker's listener rows independent of the AP state.
- The unchanged probe requires `--repo-root`, so the live probe call carries it in addition to the four frozen arguments.
- Live timings (3 x ~5 s stability, 6 x 5 s soak, 20 s probe timeout) are frozen in the handlers; only stubbed fixture runs may shorten them.
- PRE→POST compare still fails S10 while the IDEA2 baseline is unhealthy (policy untouched).
