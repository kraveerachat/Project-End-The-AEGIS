---
title: Task Receipt — IDEA3 PR11 Phase 4 L3/L4 POST-L6b/L6c reactivation (V4) — repository design/implementation
date: 2026-09-28T04:16:18+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l34-v4-post-l6b-reactivation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3/L4 POST-L6b/L6c reactivation (V4) — repository design/implementation

> [!important] Repository design/implementation only. No Production mutation, no sudo, no host reads requiring
> mutation. **No A-L4/K3 created, no runner frozen or executed, no live reactivation performed.** L6b/L6c live
> acceptance is unchanged and never mutated by this design. No ESP32, no L7.
> Base: main `40fb7c251304de09f6f1518c96e9479e672e4bfe`.

## Design gap closed

`owner-run/run-l34-reactivation-owner.sh` (V1/V2/V3) models only the two proven PRE-L6b baselines (`FRESH`,
`RESIDUAL`), both requiring the NM radio disabled, and unconditionally `reset-failed`+`start`s
`aegis-idea3-dnsmasq.service` while requiring the L6b broker `inactive`. A real post-reboot host observation, taken
after L6b and L6c are both live-accepted, showed radio already enabled, target already `disconnected`, dnsmasq
already `active/running`, and the L6b broker already `active/running` with both `8883` listeners bound — a THIRD,
distinct baseline incompatible with V1/V2/V3 in three independent ways (radio, dnsmasq precondition, broker
precondition), confirmed directly from source (`l34_baseline_classify`, `l34_service_pre_gate`) and from real,
read-only host inspection, not assumed.

## What changed

1. **New V4 baseline predicates** added to `p4-l34-reactivation-lib.sh` (existing V1/V2/V3 functions byte-for-byte
   unchanged): `l34_v4_baseline_gate`, `l34_v4_rfkill_ready_gate`, `l34_v4_service_active_gate`,
   `l34_v4_identity_snapshot`/`_unchanged`, `l34_v4_broker_listeners_gate`, `l34_v4_dnsmasq_listeners_gate`,
   `l34_v4_ap_profile_autoconnect`, `l34_v4_autoconnect_pre_gate`.
2. **New, narrowly-scoped handlers** `reactivation/l34-v4-post-l6b/{apply,verify,rollback}.sh` +
   `allow-keys.txt`/`allow-listeners.txt` — `reactivation/l34/` (V1/V2/V3) untouched. The ENTIRE V4 mutation is:
   temporarily disable `wlp0s20f3` device autoconnect, exactly one `nmcli connection up aegis-idea3-ap ifname
   wlp0s20f3`, restore autoconnect. No rfkill, no NM radio, no dnsmasq/broker service command anywhere in these
   files (grep-proven).
3. **New owner-run template** `owner-run/run-l34-v4-post-l6b-owner.sh` (unpinned, `PIN_MAIN_SHA`), a distinct
   one-attempt marker (`L34-V4-REACTIVATION-ATTEMPT-CONSUMED`) and a distinct authorization scope string
   (`L3_L4_RUNTIME_REACTIVATION_V4_POST_L6B: ...`) so a V3 authorization can never authorize V4 and vice versa.
4. **Preservation envelope:** dnsmasq and the L6b broker are treated identically — never started/stopped/restarted
   in either the success or rollback path; PRE/POST/rollback MainPID and NRestarts must be identical; their exact
   expected listeners are verified present, never created. Rollback fails closed and escalates (never manipulates)
   if an unrelated Wi-Fi profile activates during the down transition.
5. **Test-only, backward-compatible extension** to `tests/l34_sim.py` (an `ap_profile_autoconnect` state key, a
   `connection.autoconnect` query, broker `:8883` listener simulation keyed off the existing
   `identities["aegis-idea3-mosquitto.service"]` entry, and the exact `sport = :8883` filtered `ss` query form) —
   all default to prior no-op values, so no V1/V2/V3 test's behavior changed.
6. New design doc:
   `docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-v4-post-l6b-reactivation-design.md`.

## RED-first evidence

Every new gate/handler was proven against the real, unmodified library/handler code before any V4 predicate existed
(iterative RED→GREEN during authoring); the final regression run below is GREEN with zero known-failing cases.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — new V4 predicates appended only.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v4-post-l6b/{apply,verify,rollback}.sh`,
  `allow-keys.txt`, `allow-listeners.txt` — new.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-v4-post-l6b-owner.sh` — new.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — extended, backward-compatible.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v4_post_l6b.py` — new (31 tests).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-v4-post-l6b-reactivation-design.md` — new.
- this receipt.

## Verification evidence

- `pytest tests/test_pr11_phase4_l34_v4_post_l6b.py` — pass: 31 passed.
- `pytest tests/test_pr11_phase4_l34_reactivation.py tests/test_pr11_phase4_l34_nm_radio.py tests/test_pr11_phase4_l34_v3_handlers.py tests/test_pr11_phase4_l34_v3_preservation.py` — pass: 456 passed (V1/V2/V3 regression, no weakening).
- `pytest tests/test_pr11_phase4_harness.py` — pass: 222 passed.
- `pytest tests/test_pr11_phase4_l6b_handler.py tests/test_pr11_phase4_l6b_runner.py` — pass: 198 passed.
- `bash -n` on every changed/new shell script — pass. `git diff --check` — pass.
- See the PR body for the full Phase 4 bundle count, vault validation and collaboration-policy validation results.

## Canonical notes updated

- None — a new design doc and new repository files; no status/receipt file elsewhere was touched.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None.

## Known limitations

- Never executed against a real host: proven only against the deterministic simulator (`tests/l34_sim.py`). A real
  live V4 attempt is the first real-root proof, and requires a fresh A-L4/K3 with the exact V4 scope, which this
  task does not create.
- The owner-run template's PRE→POST comparator wiring (`p4-compare.sh` with `allow-keys.txt`/`allow-listeners.txt`)
  is written but not exercised end-to-end against a real or simulated `p4-l0-capture.sh` bundle in this task's test
  suite — the RED-first tests focus on the handler/library gate logic itself, which is where the safety-critical
  precondition/mutation/preservation logic lives.
