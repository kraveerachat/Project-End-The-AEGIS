---
title: Task Receipt — IDEA3 PR11 L34 V5 post-L6b degraded reactivation design
date: 2026-09-28T18:09:05+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l34-v5-post-l6b-degraded
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 L34 V5 post-L6b degraded reactivation design

## What changed

- Live staged Recovery validation (PR #238) found a real post-reboot host state that neither the existing V3
  (`reactivation/l34/`) nor V4 (`reactivation/l34-v4-post-l6b/`) governed reactivation runner supports: AP
  interface `wlp0s20f3` down/address absent, `aegis-idea3-dnsmasq.service` failed, and
  `aegis-idea3-mosquitto.service` crash-looping (`activating`/`auto-restart`) because its AP-facing 8883
  listener cannot bind while the AP address is absent.
- Added a new, narrowly-scoped governed reactivation operation, V5, covering exactly this degraded baseline:
  the same wifi/rfkill/radio topology precondition as V4 (reused verbatim), the exact V3 dnsmasq
  reset-failed+start recovery (reused verbatim), and a new bounded read-only wait for the L6b broker to
  recover on its own via its own already-configured systemd auto-restart — no start/stop/restart/reset-failed
  command is ever issued against the broker.
- Repository-only: no A-L4/K3 authorization record was created, no runner was frozen or executed, no live
  system was touched. `LIVE_EXECUTED=NO`, `PRODUCTION_MUTATION=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — appended `L34_V5_BROKER_CONF` and
  `l34_v5_broker_crashloop_gate`; every existing V1/V2/V3/V4 function is byte-for-byte unchanged.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v5-post-l6b-degraded/{apply,verify,rollback}.sh` —
  new handlers for the V5 operation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v5-post-l6b-degraded/{allow-keys,allow-listeners}.txt`
  — new comparator approval lists (no edit to the shared `p4-compare.sh`).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-v5-post-l6b-degraded-owner.sh` — new unpinned
  owner-run template (`EXPECTED_MAIN=PIN_MAIN_SHA`, refuses to run until the owner freeze+authorize workflow).
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — extended, backward-compatible (`broker_mode` defaults to
  `"identity"`, preserving every existing V1/V2/V3/V4 test's simulated behavior unchanged) with a
  `broker_mode="crashloop_until_ap"` state machine for the new baseline.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v5_post_l6b_degraded.py` — new, 29 tests (TDD: written
  before the handlers, then implemented to green).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-28-idea3-pr11-phase4-l34-v5-post-l6b-degraded-reactivation-design.md`
  — full design record, including why V3/V4 do not apply, the exact mutation sequence, preservation and
  rollback model, and authorization scope.

## Verification evidence

- `bash -n` on every new/changed shell file — pass (apply.sh, verify.sh, rollback.sh, owner-run script,
  p4-l34-reactivation-lib.sh).
- `pytest tests/test_pr11_phase4_l34_v5_post_l6b_degraded.py -q` — pass: 29 passed.
- `pytest tests/test_pr11_phase4_l34_v4_post_l6b.py tests/test_pr11_phase4_l34_nm_radio.py tests/test_pr11_phase4_l34_v5_post_l6b_degraded.py tests/test_pr11_phase4_l34_reactivation.py tests/test_pr11_phase4_l34_v3_handlers.py -q`
  — pass: 406 passed, 0 failed (full existing V1/V2/V3/V4/regulatory L34 suite still green after the
  `l34_sim.py` extension).
- `node scripts/validate-vault.mjs` — pass (see below).
- `git diff --check` — pass: no whitespace errors.

## Canonical notes updated

- `None` — this receipt is the durable record of the new design; no other canonical note changed.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — append-only extension shared by
  V1/V2/V3/V4/V5; full existing 222-test regression for that file re-run and confirmed green before and after.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — extended shared test simulator; same regression re-run confirms no
  existing test's behavior changed.

## Integration requests

- Owner (music): review this design and, if accepted, perform the owner-only freeze workflow (pin
  `EXPECTED_MAIN`, record the frozen runner's SHA-256) and issue a fresh same-day A-L4/K3 authorization pair
  with the exact V5 scope string before any live run. This PR does not request or perform that step.

## Known limitations

- The live host observation in this session directly confirmed dnsmasq's and the broker's PRE-state, but not
  `nmcli radio wifi`/rfkill state on the AP host itself (Twingate/SSH path was verified instead). V5's own
  `l34_v4_baseline_gate`/`l34_v4_rfkill_ready_gate` calls are the actual, independent, read-only proof of that
  part of the baseline at run time; if it does not match, the runner refuses cleanly before any mutation.
- `K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN`, unchanged from V3/V4.
