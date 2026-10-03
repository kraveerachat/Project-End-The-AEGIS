---
title: Task Receipt — IDEA3 post-NTP forensic fix (capture read-only, final NTP gates; repository only)
date: 2026-10-03T18:05:00+07:00
owner: music
area: idea3
branch: fix/idea3-post-ntp-capture-readonly-and-l8p-ntp-gates
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 post-NTP forensic fix (capture read-only, final NTP gates; repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. **Nothing was executed live**: no time daemon was started/stopped, `timedatectl show-timesync` was never run on the host, no serial/esptool/ESP32 access, no MQTT publish, no CUT/RESTORE, no relay/uplink wiring, no Authorization/K3/attempt marker/frozen runner/evidence directory created, no Production authorization. The consumed 2026-10-03 NTP evidence directory was read, not modified.

```text
BASE_SHA=0ab80a1a7d9ff2b45dbcdfb021aba900841cd128
OLD_NTP_ATTEMPT_STATUS=CONSUMED
OLD_NTP_ATTEMPT_APPLY=PASS
OLD_NTP_ATTEMPT_PRE_POST_VERIFY=PASS
OLD_NTP_ATTEMPT_FINAL_READINESS=INVALIDATED_NOT_PROVEN_AFTER_POST_CAPTURE
OLD_NTP_ATTEMPT_REUSABLE=NO
SUCCESSOR_REQUIRED=YES
NTP_RUNTIME_READY_FOR_L8P=NO
K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN
L8P_LIVE_EXECUTED=NO
ESP32_TOUCHED=NO
PRODUCTION_MUTATION_PERFORMED=NO
```

## What changed

- **Root cause (confirmed from code; journal timing consistent; not reproduced live):** the POST `p4-l0-capture.sh` ran `timedatectl show-timesync`, which activates a stopped `systemd-timesyncd`; `chronyd.service` has `Conflicts=systemd-timesyncd.service`, so chronyd stopped (journal: chronyd exit 17:19:00.476, timesyncd start .478, during the POST capture). `p4-lib.sh` treats `show-timesync` as read-only, true only while timesyncd already runs. The NTP runner then printed PASS from the stale pre-POST VERIFY output, and the host ended timesyncd active / chronyd inactive / no UDP :123 without a reboot.
- **A. Capture:** timesyncd-specific properties are queried only while `systemd-timesyncd` is `active`/`running` (guarded `systemctl show`); otherwise `time.timesyncd.{ServerName,SystemNTPServers,FallbackNTPServers}` record `TIMESYNCD_INACTIVE_NOT_QUERIED` and no timesync command is issued. Config FILE records are unchanged. `time.timesyncd.FallbackNTPServers` joins the NTP reactivation allow list (`stages/L5` is untouched by contract).
- **C. NTP runner:** PASS and `NTP_RUNTIME_READY_FOR_L8P=YES` now require a FINAL read-only `ntpreact_runtime_ready_gate` after the POST capture, compare and identity check; failure rolls back.
- **D. L8p runner:** `l8p_ntp_runtime_gate` runs in the pre-gates and again after the PRE capture, before the attempt marker (no attempt, serial access, reset or first write if NTP is absent).
- **Also fixed:** `ntpreact_alt_config_gate` misread an inherited ERR-trap line as a `-f` token in `set -E` runners (`|| true` in the process substitution); `NTPREACT_SUDO` lets an unprivileged runner read the root-owned config.
- **E. Unchanged:** disk gate, receipt gate, one-shot semantics, S10, secret handling, L8p no-CUT/no-RESTORE boundary.
- **F. Old attempt:** recorded as consumed; APPLY and pre-POST VERIFY true history; final readiness invalidated; never reusable.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh`, `p4-ntp-reactivation-lib.sh`, `p4-l8p-run-lib.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l8p-owner.sh`, `run-pre-l8p-ntp-runtime-reactivation-owner.sh` (inert templates)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/pre-l8p-ntp-runtime-reactivation/allow-keys.txt`, `README.md` (11.1)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-03-idea3-pre-l8p-ntp-runtime-reactivation-design.md` (section 7)
- Tests: `…_pre_l8p_ntp_reactivation.py` allow-catalog invariant amended (one approved extra key); new `tests/test_pr11_phase4_capture_timesyncd_readonly.py`; extended `…_l8p_owner_runner.py`, `…_pre_l8p_ntp_reactivation_owner_run_flow.py`; capture SHA-256 pin updated in `…_dnsmasq_unit_repair_reboot_and_scope.py`, `…_l34_v6_clock_stabilization.py`, `…_l34_v8_scope_contract.py`

## Verification evidence

- `pytest tests -k "pr11_phase4 or pr11_phase2 or firmware_contract"` — first full run: 4569 passed, 5 skipped, 1 failed (the NTP allow-catalog subset invariant); that test was then amended to permit exactly `time.timesyncd.FallbackNTPServers` and `pytest tests/test_pr11_phase4_pre_l8p_ntp_reactivation.py` — PASS, 96 passed. Targeted: `tests/test_pr11_phase4_capture_timesyncd_readonly.py` PASS (19), `…_l8p_owner_runner.py` PASS (124), `…_pre_l8p_ntp_reactivation_owner_run_flow.py` PASS (67). Simulated host only.
- The new capture tests FAIL on the old capture (14 failures) and PASS on the repaired one.
- `bash -n` on every changed `.sh` — PASS. `git diff --cached --check` — PASS.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS after this section (0 errors; 2 pre-existing canvas warnings).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "post-NTP forensic fix" section.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None

## Known limitations

- Simulated-host proof only; no new live NTP attempt exists. A new governed NTP attempt needs a new exact-main frozen runner, a brand-new same-day AUTH_DIR/Authorization/K3 and owner authorization.
- `stages/L5` is unchanged by contract, so a hypothetical L5 rerun with timesyncd stopped would flag `time.timesyncd.FallbackNTPServers` (fail-closed).
- A narrow race remains between the guard probe and the query if timesyncd stops in between; it cannot occur while the approved runtime is steady.
- Observed on the host: `/` at 81% used versus the L8p runner's 80% disk gate; not changed here.
