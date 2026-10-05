---
title: Task Receipt — IDEA3 R1A real detector acceptance stage
date: 2026-10-05T07:18:19+07:00
owner: music
area: idea3
branch: feat/idea3-r1a-real-detector-acceptance-stage
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1A real detector acceptance stage

## What changed

- Registered the owner-approved `R1A` Phase-4 stage after `R1I` and before `L8`, and added its first-class stage surface, an evidence-preserving rollback, a one-attempt state machine, predecessor receipt gates and an inert owner-run template. Repository implementation only: nothing was executed live and nothing touched Production.
- The stage observes only. It generates no traffic, alert, journal line, Core socket write or database write. The existing fail-closed `r1_acceptance` verifier is the authority and is unchanged.

## Owner-approved governance and boundary

- `R1A_STAGE_ID_OWNER_APPROVED=YES`
- `R1A_GOVERNANCE_CLASS=MUTATING`
- `R1A_ONE_ATTEMPT=YES`
- `R1A_NO_RETRY=YES`
- `R1A_GENUINE_EXTERNAL_EVENT_REQUIRED=YES`
- `R1A_SYNTHETIC_ALERT_ALLOWED=NO`
- `R1A_REAL_EVIDENCE_ROLLBACK_ALLOWED=NO`
- `R1I_MUST_REMAIN_INSTALLED=YES`
- `R1A_REPOSITORY_IMPLEMENTED=YES`
- `R1A_LIVE_EXECUTED=NO`
- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`
- `R1_VERIFIED=NOT_CLAIMED`
- `RECOVERY_R1_R8_PROVEN=NO`
- `PRODUCTION_MUTATION_PERFORMED=NO`

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/r1a tests/test_r1_acceptance.py tests/r1i` — pass: 166 passed in 4.55s.
- `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_harness.py tests/test_pr11_phase4_f1u_stage.py tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — pass: 694 passed (full files; the shared-registration, stage-list and shared-digest-pin tests are included).
- `bash -n` on every new shell file (three stage handlers, the run library and the owner-run template) — pass.
- Forbidden-action scan of the executable lines of every R1A file (systemctl start/stop/restart, nft add/delete/flush, sqlite INSERT/UPDATE/DELETE, logger, nmap, nc, curl, ssh, socat, scapy, Core alert socket, rm, R1I removal, blocked_ipv4) — pass: none present; only read-only `systemctl show`, `journalctl -o json --no-pager` and `nft list` forms exist.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with the two known pre-existing canvas owner-data warnings.
- `git diff --check` — pass.
- Collaboration policy and changed-content secret scan — see PR checks; both were run locally before the push and passed.
- No Production command was run during this task.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — additive R1A registration (stage list, operational-order comment, `R1A) echo none`).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/R1A/` — canonical handlers (apply, verify, rollback) and allow files.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-r1a-run-lib.sh` — marker, predecessor gates, host gates and the attempt state machine.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1a-owner.sh` — inert pinned owner-run template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — stage order and the R1A contract (section 16).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-05-idea3-r1a-real-detector-acceptance-stage-design.md` — design.
- `IDEA3-AEGIS_Lockdown/tests/r1a/test_r1a_stage.py` — hermetic R1A tests.
- `IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py`, `tests/r1i/test_r1i_input_instrumentation.py`, `tests/test_pr11_phase4_f1u_stage.py`, `tests/test_pr11_phase4_harness.py` — "R1A unregistered" assertions updated to the approved registration.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — stage-list assertion and the one shared `p4-lib.sh` digest pin updated.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — R1A repository-implementation section.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-05_071819_music_idea3-r1a-real-detector-acceptance-stage.md` — this receipt.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — R1A implemented in the repository, not executed; claim boundary preserved.

## Shared surfaces touched

- None — all paths are inside the IDEA3/Music-owned boundary (the shared Phase-4 harness lives under IDEA3-AEGIS_Lockdown).

## Integration requests

- Human IDEA3 owner and temporary GitHub reviewer Kla: review the additive stage registration. Re-pin reasoning: the only digest pin that depends on `p4-lib.sh` bytes is the shared pin in the dnsmasq scope test; it changed solely because of the three approved additive edits. Nothing else was re-pinned.
- Do not freeze a runner, create authorization or K3, or run R1A without a separate owner decision.

## Known limitations

- Design intent is not live proof: the owner runner has never been frozen or run, the gates were exercised with hermetic stubs only, and no genuine external event has been observed. `R1A_LIVE_EXECUTED=NO`.
- R1A fails closed on any L2/`blocked_ipv4` change. The production alert path (AlertIngress → `on_production_alert` → `bind_incident`) does not contain or mutate the host, so `BLOCKED_IPV4_EXPECTED_DELTA=NO` and `L2_CONTAINMENT_EXPECTED_DELTA=NO`.
- A real incident, audit row or journal evidence produced during a future R1A is never deleted, closed or edited to restore PRE.
- No raw Production evidence, secret, runner or authorization content was committed.
