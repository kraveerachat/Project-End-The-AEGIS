---
title: Task Receipt — IDEA3 L8p attempt 2 reconciliation contract (repository only)
date: 2026-10-04T06:49:14+07:00
owner: music
area: idea3
branch: fix/idea3-l8p-attempt2-reconciliation-contract
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8p attempt 2 reconciliation contract (repository only)

> [!important] Repository implementation only. IMPLEMENTED != DEPLOYED. This task performed **no** reconciliation and **no** cleanup on the real attempt-2 evidence tree, created **no** Authorization/K3, frozen runner, attempt marker or acceptance receipt, and performed no ESP32, serial, flash, reset, MQTT, CUT/RESTORE, service, NTP or Production action. The real attempt-2 directories were never referenced by the tests (hermetic fixtures under `tmp_path` only). Reading the real owner-run log and directory metadata was read-only and only to make the fixtures faithful.

```text
BASE_SHA=d3337baa480031ce59c3c527bb70db579dd4ea0d
OWNER_DECISION=ATTEMPT2_SPECIFIC_HOST_ONLY_BOUNDED_RECONCILIATION_APPROVED
PHYSICAL_RECOVERY_REQUIRED_BEFORE_RECONCILIATION=NO
DEVICE_RETRY_ALLOWED=NO
DEVICE_MUTATION=NO
ESP32_ACTION=NO
PRODUCTION_SERVICE_MUTATION=NO
HOST_SIDE_EVIDENCE_TREE_MUTATION=BOUNDED (deletion of exactly l8p-work/nvs.csv and l8p-work/nvs.bin only)
ATTEMPT2_SPECIFIC_TOOL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reconciliation/reconcile-l8p-attempt2.py
DEVICE_CAPABILITY_PRESENT=NO
LIVE_RECONCILIATION_EXECUTED=NO
REAL_ATTEMPT2_EVIDENCE_MODIFIED=NO
ATTEMPT2_CONSUMED=YES
ATTEMPT2_FIRST_HARDWARE_WRITE=STARTED
L8P_PROVISIONING_STILL=NOT_PROVEN
PRODUCTION_MUTATION_PERFORMED=NO
ESP32_TOUCHED=NO
```

Terminology: the approved procedure is a host-only bounded reconciliation, not a "read-only" one: it intentionally deletes the two temporary secret-bearing work artifacts. (The decision was first worded "read-only / host-only"; only the wording was corrected.) This receipt records the repository implementation only. Attempt 2's formal result stays NOT_PROVEN until the owner runs the merged tool successfully; the final closeout receipt is a separate, later, immutable record and must state `ORIGINAL_RUNNER_FULL_SUCCESS_LINE=NO` and `RECONCILIATION_RESULT=PASS`. No whole-line L8p result field is written here.

## What changed

- **One-off tool, not a generic mechanism:** `reconcile-l8p-attempt2.py` takes only `--evidence-root`, `--freeze-dir`, `--input-dir` and is hard-bound to run id `l8p-20261004-041840`, the attempt-2 evidence and freeze directory names, the frozen runner SHA-256 `f4804bb6…dfe8` and the pinned firmware digest. Standard library only; no device library, esptool, serial, MQTT, subprocess, network, sudo, service or NetworkManager code (a static test pins this and the single fixed-name deletion site).
- **Pre-cleanup forensic gates (all must pass before anything is deleted):** frozen runner digest; consumed marker, Authorization and K3 present and identical to the evidence copies; exactly one canonical 12-field `l8p-l8p-20261004-041840.json` (0600, run id, firmware digest, flash / NVS readback / firmware readback / boot PASS, failure boundary NONE); the historical `owner-run.log` shape (all required lines, both PASS compare/S10 results, the original 2-hit scan, the NOT_PROVEN statement, and the original runner's full-success line absent); PRE/POST/RB `SHA256SUMS`; the first-write marker; and the secret classification of the entire evidence tree with the same >= 8-byte semantics as `l8p_secret_scan`: exactly nvs.csv (wifi.psk, mqtt.pass, k_c2d, k_d2c) and nvs.bin (wifi.psk, mqtt.pass); only path, size and class names are printed.
- **Preservation manifest and cleanup:** in-memory manifest (path, mode, size, SHA-256) of every other file and every directory; removal of exactly `l8p-work/nvs.csv` and `l8p-work/nvs.bin` (canonical evidence root, real canonical `l8p-work`, regular non-symlink files, fixed names, no wildcard or recursion).
- **Post-cleanup proofs:** manifest identical (`OTHER_EVIDENCE_CHANGED=NO`), unchanged full-tree scan with ZERO hits, captures and JSON re-verified, first-write and consumed markers present. Fail closed on any failure, including on a second run over an already reconciled tree.
- **Review fixes (PR #329):** (1) consumed marker: one read-only check of the real attempt-2 auth directory found `L8p-ATTEMPT-CONSUMED` PRESENT (regular file, 0600, 33 bytes; `REAL_CONSUMED_MARKER_PRESENT=YES`); an earlier truncated listing of mine had suggested otherwise. The requirement stays, is tightened to the real shape (`consumed_at=<UTC>`, 0600, non-symlink), and the tool still never creates or repairs it (`MARKER_FABRICATED=NO`); no fallback was added. (2) The canonical note's receipt links carried an unexpanded shell placeholder; both the section for this task and the same defect in the already-merged attempt-2 section now name the real immutable receipts, and a test guards it. (3) Cleanup errors fail closed: `os.unlink` and any filesystem error produce a controlled `L8P_ATTEMPT2_RECONCILIATION=FAIL phase=...` with the exact mutation state and no authoritative field; an unwritable work directory is refused before the first removal.
- **Result semantics:** on full success it prints the narrow reconciliation results (`L8P_ATTEMPT2_RECONCILIATION=PASS`, device action NONE, secret work removed, scan PASS, evidence preserved, `ORIGINAL_RUNNER_FULL_SUCCESS_LINE=NO`) plus the reconciled facts `L8P_LIVE_EXECUTED=YES` / `L8P_PROVISIONING=PASS`, which are NEW owner-approved results and not claims about the historical runner.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reconciliation/reconcile-l8p-attempt2.py` (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_attempt2_reconciliation.py` (new, hermetic)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l8p-device-provisioning-only.md` (section 9)
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`

## Verification evidence

- `pytest -q -p no:cacheprovider tests -k "pr11_phase4 or pr11_phase2 or firmware_contract"` — PASS, 4767 passed, 5 skipped, 0 failed, run once on the pre-review tree (based on `origin/main` `d3337baa`); the review fixes are isolated to the one-off tool, its tests and docs, so the full suite was not rerun (`FULL_OVERLAP_RERUN=NO`).
- `pytest tests/test_pr11_phase4_l8p_attempt2_reconciliation.py` — PASS after the review fixes (see the PR body for the count): marker real-shape and refusal cases, injected deletion errors, post-cleanup filesystem errors, the canonical-note placeholder guard, plus the earlier 96 cases.
- `pytest` on L8p owner runner / provisioning / esptool interpreter / L8 handler / p4 harness — PASS after the review fixes (post-review fast compatibility; counts in the PR body).
- `python3 -m py_compile` on the tool, `bash -n` on the L8p scripts, `git diff --check` — PASS.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS (0 errors; 2 pre-existing canvas warnings).
- `scripts/validate-collaboration-policy.mjs` — PASS, run locally against the PR body and the changed paths.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "L8p attempt 2 reconciliation contract" section.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None

## Known limitations

- Hermetic fixtures only: nothing here proves the real attempt-2 tree will satisfy every gate; the tool refuses (changing nothing) if it does not. Its first real execution is a separate, owner-run step.
- A single-purpose tool: any other attempt needs its own reviewed decision. The old Authorization/K3 and runner remain non-reusable and no new attempt is authorized.
