---
title: Task Receipt — IDEA3 Real Detector Acceptance / R1 repository package
date: 2026-10-05T10:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-r1-real-detector-acceptance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Real Detector Acceptance / R1 repository package

> [!important] Repository work only. R1 repository implementation != live acceptance. No sudo, no Production mutation, no detector/Core start/stop/restart, no alert injection, no `alert.sock` write, no ESP32/device action.

## Authoritative result fields

```text
F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN
R1_VERIFIED=NOT_CLAIMED
RECOVERY_R1_R8_PROVEN=NO
RECOVERY_R2_R8_EXECUTED=NO
LVR_PROVEN=NO
L8_ACCEPTANCE=NO
L9_PROVEN=NO
R1_OBSERVER_VERIFIER_IMPLEMENTED=YES
R1_OWNER_RUNNER_TEMPLATE=NOT_CREATED
NEW_STAGE_REQUIRED=YES
SYNTHETIC_ALERT_ACCEPTED=NO
DIRECT_SOCKET_INJECTION_ACCEPTED=NO
PRODUCTION_MUTATION_PERFORMED=NO
CORE_RESTARTED=NO
DETECTOR_RESTARTED=NO
ESP32_TOUCHED=NO
```

## What changed

- `aegis_soc/production_detector.py`: the alert journal line gains `rule=<ssh_bruteforce|port_scan|syn_flood>`. Alert payload (v1) and behaviour are unchanged.
- `aegis_soc/recovery_core.py`: `AlertIngress` durably writes `ALERT_ACCEPTED uid pid attacker_ip action` (SO_PEERCRED values) per alert that reached binding. Best-effort; never changes the response.
- `aegis_soc/r1_acceptance.py` (new): read-only baseline/final capture and fail-closed verifier; reuses `recovery_evidence` (`_open_ro`, `_AuditStore`, `_r1`) unmodified.
- Tests: `tests/test_r1_acceptance.py` (59), two cases in `tests/test_core_alert_ingress.py`.

## Findings

- **Provenance:** before this change nothing durable separated a real detector rule match from a direct write by the detector uid. The kernel-attested peer pid (Core) must now equal the detector baseline MainPID and the journald `_PID` of the detector's own alert line. Residual: in-process code in the detector is the existing trust boundary.
- **Stage:** NEW_STAGE_REQUIRED=YES for the owner runner only. `P4_STAGES` has no registered stage for it, `p4_stage_mutates` has no non-mutating class except L0, and consumed F1 authorization must not be reused. `PROPOSED_STAGE_ID=R1A` (after F1, before Recovery R2+). REQUIRED_GOVERNANCE_CHANGES: register the stage in `p4-lib.sh`, define its authorization/K3 keys and mutation class (observation-only), add runner + gates, require this PR's merge and the F1 attempt #2 closeout receipt. Not done without an owner decision.
- **Live prerequisite:** Production Core runs release `c2238375` and was not restarted; it lacks `ALERT_ACCEPTED` and the detector lacks `rule=`. The change must be deployed and both units restarted under governed stages before a live observation can pass.
- **Live DB reads:** the verifier needs a consistent copy; `consistent_snapshot` uses the SQLite online backup from a `mode=ro` source (the live Core uses WAL).

## Verification evidence

- `python -m pytest tests/test_r1_acceptance.py tests/test_core_alert_ingress.py tests/test_f1_alert_sink.py tests/test_f1_detector_journal_source_repair.py tests/test_recovery_evidence.py tests/test_core_recovery.py tests/test_core_restore_policy.py -q` — pass: 506 passed.
- `node scripts/validate-vault.mjs` — pass (two pre-existing owner-data Canvas warnings).
- `node scripts/validate-collaboration-policy.mjs` with the task event and changed-files list — pass.
- `git diff --check` — pass.

## Source files changed

See PR file list; notes: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` and this receipt.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`

## Shared surfaces touched

None outside IDEA3 and its status note.

## Integration requests

None. Owner decision needed: register stage `R1A` (or another id) before any runner.

## Known limitations

Nothing live was observed; `simulate` mode and hermetic fixtures never claim R1.
