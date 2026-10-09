---
title: Task Receipt — IDEA3 governed dnsmasq unit live-repair package (repository only)
date: 2026-10-03T01:25:00+07:00
owner: music
area: idea3
branch: fix/idea3-dnsmasq-governed-live-repair
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 governed dnsmasq unit live-repair package (repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. **No live repair was executed**: no authorization or K3 record was created or reused, no runner was frozen, no attempt marker or evidence directory exists, nothing was installed, reloaded, reset, started or restarted on the host, no network or NetworkManager change, no Core restart, no reboot, no ESP32.

```text
PR305_REPOSITORY_FIX=MERGED
LIVE_REPAIR_EXECUTED=NO
REBOOT_VERIFICATION_EXECUTED=NO
K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN
L8P_LIVE_EXECUTED=NO
RECOVERY_R1_R8=NOT_RUN
LVR=NOT_RUN
L8=NOT_RUN
ESP32_TOUCHED=NO
```

## What changed

- Pre-gate (read-only): `origin/main` was exactly `1579712866ef0e83c5b949b0afed7a7969e0f80f`; PR #305's merge `827251f2478f03822c42ab43eadb50f73005d432` is an ancestor; the only later change is IDEA2 PR #298 (10 IDEA2 files, none of the IDEA3 dnsmasq repair surfaces). The runner is not pinned to either SHA: it stays inert (`PIN_MAIN_SHA`) until the owner freeze workflow pins the merge commit of this PR.
- Governance discovery first: no current governed mechanism can do only this repair. `stages/L4` renders the whole AP network; V1–V3 and V4–V8 require the unit to already satisfy the corrected L34 authority (V8 refuses the old unit at its own gate); V7/V8 are historical, one-shot and never replayed; no consumed authorization, K3, marker or evidence is reused; no L-number was invented. A task-specific package follows the existing owner-run / frozen-runner / one-shot-marker / PRE-APPLY-VERIFY-POST-compare / journal-rollback conventions. See the design spec.
- New package `dnsmasq-unit-boot-order-repair`: the only live mutation it can ever authorize is render the canonical template with the fixed approved values → atomic unit install → `daemon-reload` → `reset-failed` + `start` (failed/start-limit-hit baseline) or one `restart` (running baseline) of `aegis-idea3-dnsmasq.service`. It refuses (before any write) on wrong main, stale or foreign Auth/K3/marker, an unresolved template, any AP/profile/config mismatch, an unexpected installed unit (only the exact old digest is replaced), pending `NeedDaemonReload`, unhealthy Core/broker, non-zero forwarding or NAT.
- Authorization/K3, attempt, evidence, rollback (before/after the unit replacement), the verify lines and the explicit terminal verdict are specified in the design spec section 5–6.
- **Reboot verification is a separate, read-only procedure** (`verify-dnsmasq-boot-order-after-reboot.sh` + `reboot-verify.sh`): it never reboots or mutates, records `K12_PERSISTENCE_OBSERVED` and, separately, `K12_FORMALLY_PROVEN=NO` (no canonical K12 acceptance contract exists in the repository), and leaves `K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN`.
- The new package adds no direct consumer of `l34_dnsmasq_unit_gate` (a wrapper in its own library calls it), so PR #305's pinned consumer set and every shared/historical file stay byte-identical (pinned by the new scope test).

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-dnsmasq-repair-lib.sh` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/apply.sh` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/verify.sh` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/rollback.sh` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/reboot-verify.sh` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/allow-keys.txt` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/allow-keys-rollback.txt` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/allow-listeners.txt` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/allow-dynamic-transitions-failed-post.txt` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/allow-dynamic-transitions-failed-rollback.txt` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-dnsmasq-unit-boot-order-repair-owner.sh` (new, inert as committed)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/verify-dnsmasq-boot-order-after-reboot.sh` (new, inert as committed, read-only)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — section 10 (appended)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-03-idea3-dnsmasq-unit-boot-order-governed-repair-design.md` (new)
- `IDEA3-AEGIS_Lockdown/tests/dnsmasq_repair_sim.py` (new; wraps the unchanged `l34_sim.py`)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair.py` (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_owner_run_flow.py` (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` (new)

## Verification evidence

- RED first: the three new test files were written before any implementation; the first handler run then passed 80 (4 static tests deselected until the runner/reboot files existed). A mutation check (removing the AP preflight gate; removing the rollback `daemon-reload`) was caught by the tests and the originals restored.
- `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_pr11_phase4_dnsmasq_unit_repair.py tests/test_pr11_phase4_dnsmasq_unit_repair_owner_run_flow.py tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` + the PR305/L34 overlap suites (ap_network, dnsmasq_boot_order, l34_dnsmasq_unit_authority, l34_nm_radio, l34_reactivation, l34 v3-v8 handlers/flows/scope/profile, l4_handler, l4_live_values, l4_reactivation_gate, harness) in one same-day run — pass: 1893 passed, 3 skipped, 0 failed (25m28s).
- `bash -n` on every new script — pass; `git diff --check` — pass; `node scripts/validate-vault.mjs` — pass (2 existing canvas warnings). The collaboration-policy check runs in CI against the PR body.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new section for this package; the stale "Draft PR, not merged" clause of the PR #305 section replaced with "merged as PR #305 (`827251f2`)". No historical receipt was edited.

## Shared surfaces touched

- `None` — task stayed inside its selected area (all code is under `IDEA3-AEGIS_Lockdown/`; no gateway, compose, database, CI or Core knowledge file changed).

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Simulated-host proof only (stub `systemctl`/`nmcli`/`iw`/`ip`/`nft`/`ss`/`systemd-analyze`); `IMPLEMENTED != DEPLOYED`. The first real `systemd-analyze verify` / `daemon-reload` / L0 capture of this package has not happened; an unforeseen dnsmasq capture key would fail the PRE→POST compare and trigger the (tested) rollback.
- The records carry `stage=L4` (the only gate-name for the AP/dnsmasq layer); this is not an L4 acceptance claim.
- The runner and reboot-verification wrapper are inert until the owner freeze workflow pins the merge commit of this PR; this PR does not create the authorization, K3, frozen copy or reboot approval. Independent review and merge are required first.
- L34/V5–V8 reactivation remains blocked on the host until the owner separately authorizes and runs the repair, then separately verifies the reboot; `K12_AUTOMATIC_REBOOT_PERSISTENCE` stays `NOT_PROVEN`.
