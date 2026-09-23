---
title: Task Receipt — IDEA3 PR11 S10 window-delta criterion
date: 2026-09-23T21:30:43+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-s10-window-delta-criterion
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 S10 window-delta criterion

This receipt records completion of the REPOSITORY TASK (PR #189), not Pub's review.

## What changed

- Historical absolute Tunnel `NRestarts` is retained as evidence and never normalized.
- Absolute historical `NRestarts > 0` is no longer by itself a current-health failure.
- IDEA2 §10 preservation uses a BEFORE/AFTER window delta.
- Restart increase, MainPID change, new failure class, `:18002`/`:8077` loss, or unhealthy baseline remain fail-closed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — absolute NRestarts rule removed from tunnel-health verdict
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — window-delta criterion summary line
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — criterion documented
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — cases A–F
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — canonical status
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-23_213043_music_idea3-pr11-s10-window-delta-criterion.md` — this receipt

## Verification evidence

- `pytest -q tests/test_pr11_phase4_harness.py` — PASS: 174 passed
- Full PR11 suite — PASS: 885 tests
- `bash -n deploy/pr11-phase4/p4-l0-capture.sh` — PASS
- `bash -n deploy/pr11-phase4/p4-compare.sh` — PASS
- `git diff --check origin/main...HEAD` — PASS
- Collaboration guardrails history: the Draft run before Ready passed. The premature Ready run failed ONLY because this receipt was absent ("A final Obsidian task receipt is required ... found 0"); that is an expected governance failure, not a source/test failure. PR was restored to Draft.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — current facts:
  - FRESH_DISK_USE=88%
  - FRESH_IDEA2_OBSERVATION_SECONDS=821
  - ENGINE_NRESTARTS=0->0
  - TUNNEL_NRESTARTS=15->15
  - TUNNEL_MAINPID_UNCHANGED=YES
  - LISTEN_8077=YES
  - LISTEN_18002=YES
  - MONITOR_HEALTHZ=PASS

## Shared surfaces touched

- None — no IDEA1 source/runtime, IDEA2 source/runtime, or shared runtime files changed. The criterion observes IDEA2 state but the implementation remains IDEA3-owned.

## Integration requests

- Pub / IDEA2 owner (`pubpup2006p-design`) must review PR #189.
- IDEA2_OWNER_ACCEPTANCE=PENDING_PR_REVIEW
- S10_IDEA2_CAVEAT=OPEN_PENDING_OWNER_ACCEPTANCE
- Pub approval of PR #189 is the written IDEA2-owner acceptance gate for the window-delta criterion. Kla review may occur normally but does not substitute for it.
- L1_LIVE_EXECUTION=NOT_RUN
- PRODUCTION_MUTATION=NO

## Known limitations

- Pub approval has not yet occurred.
- §10 final owner acceptance is not yet claimed.
- L1 has not run; no A-L1 issued; no fresh K3 issued for L1.
- Phase 4 live execution remains blocked until all later gates are satisfied.
- No Production mutation occurred in this task.
