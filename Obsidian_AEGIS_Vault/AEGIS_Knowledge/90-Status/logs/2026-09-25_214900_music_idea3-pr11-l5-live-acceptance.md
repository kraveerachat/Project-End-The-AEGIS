---
title: Task Receipt — IDEA3 PR11 Phase 4 L5 live acceptance
date: 2026-09-25T21:49:00+07:00
owner: music
area: idea3
branch: docs/idea3-pr11-l5-live-acceptance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L5 live acceptance

> [!important] Documentation-only closeout of owner-run L5 Attempt #4. The live run mutated Production and passed; this repository task performs no Production mutation. L5 is left APPLIED, L4 is untouched, Pboo_5G autoconnect remains `no`, and L6a is NOT started.

## Task

Close out the successful AEGIS IDEA3 PR11 Phase 4 L5 trusted-NTP live acceptance while preserving the complete failed-attempt history and the exact evidence boundary.

## Branch / base

- Branch: `docs/idea3-pr11-l5-live-acceptance`
- Base / successful live main: `87a1b6a252c5d862f3da9176c710151095579c0a`
- Main had not advanced beyond that SHA when this closeout branch was created.

## Successful live evidence

- Evidence root: `/home/kittipat/Workspace/idea3-p4-evidence/2026-09-25-l5-20260925-212812`
- Runner: `/home/kittipat/Workspace/idea3-p4-evidence/l5-owner-run/run-l5-owner.sh`
- Runner SHA-256: `74d42d13c3d480e4e80fea5c10798111b65257678b74bd315274c4dfbfa77a8f`
- Probe: `/home/kittipat/Workspace/idea3-p4-evidence/l5-owner-run/ntp-probe.py`
- Probe SHA-256: `099a048860e976ee5ee61bf16deba5d9fa795796aa27d7746907090142932a12`
- Render directory: `/home/kittipat/Workspace/idea3-p4-evidence/l5-render-20260925-201919-main87a1b6a2`
- Rendered chrony config SHA-256: `20e283e4616fadeb3f2ae9438b17e3351b7af354844a911038a47089af3a35fe`
- Rendered T6 contract SHA-256: `3d0b94b36d05b209d87800d5bc1cdb58a8a782162b1b4fab9796cd901be730e5`
- Trusted upstream: `2.arch.pool.ntp.org`

## Authorization

Attempt #4 used owner comment ID `5833985188`:

`https://github.com/kraveerachat/Project-End-The-AEGIS/pull/215#issuecomment-5833985188`

Authorization and K3 were valid for exactly one supervised live mutation. Production mutation occurred, therefore Attempt #4 authorization is consumed. No automatic retry exists or is needed.

## Historical attempt register

| Attempt | Evidence | Result | Authorization | Acceptance truth |
|---|---|---|---|---|
| #1 | `2026-09-25-l5-20260925-174630` | FAIL | CONSUMED | `L5_LIVE_ACCEPTANCE=NOT_PROVEN` |
| #2 | `2026-09-25-l5-20260925-191827` | FAIL | CONSUMED | readiness timeout `KERNEL_UNSYNCED`; root cause later proven and remediated by PR #215 |
| #3 | `2026-09-25-l5-20260925-205740` | FAIL | CONSUMED | APPLY/VERIFY/TrustedClock passed, but external-witness ingestion failed; `L5_LIVE_ACCEPTANCE=NOT_PROVEN`; rollback/residue/S10/compare passed |
| #4 | `2026-09-25-l5-20260925-212812` | PASS | CONSUMED | the only run with `L5_LIVE_ACCEPTANCE=PROVEN` |

Attempt #3 remains a failed consumed attempt. Its Windows witness files were produced by PowerShell `Tee-Object` as UTF-16LE with CRLF; the frozen runner did not properly ingest the AP `TARGET` field. Do not rewrite Attempt #3 as PASS.

## Attempt #4 live result

### PRE

- TrustedClock `SYNCED`
- `maxerror_us=74000`
- `adjtimex_ret=0`
- `status=0x2001`
- `sta_unsync=0`
- `time_error=0`
- `CAPTURE_PRE=COMPLETE`
- `SHA256=PASS`

### APPLY

- `PRODUCTION_MUTATION_PERFORMED=YES`
- `L5_CLOCK_READY=YES`
- `reason=OK`
- `waited_s=5.01`
- `L5_APPLY=PASS`
- `CHRONYD_STATUS=ACTIVE`
- `TIMESYNCD_STATUS=INACTIVE`
- `NTP_LISTENER_ADDRESS=10.77.30.1:123`

Post-apply clock:

- state `SYNCED`
- `maxerror_us=21992`
- `adjtimex_ret=0`
- `status=0x0`
- `sta_unsync=0`
- `time_error=0`

### VERIFY

- `L5_VERIFY=PASS`
- `CHRONYD_ACTIVE=YES`
- `TIMESYNCD_INACTIVE=YES`
- `TRUSTED_CLOCK_STATE=SYNCED`

## External witness evidence

The same physical Windows laptop was used sequentially from two distinct network perspectives.

AP perspective:

- host `Kittipat`
- SSID `AEGIS-IDEA3`
- local address `10.77.30.11`
- target `10.77.30.1`
- `AP_WITNESS_RESULT=PASS`
- `mode=4`
- `leap=0`
- `stratum=2`
- `rtt_s=0.0015`
- `offset_s=-0.6936`

Non-AP perspective:

- host `Kittipat`
- SSID `Pboo_5G`
- local address `192.168.1.134`
- target `192.168.1.144`
- `NONAP_WITNESS_RESULT=SERVICE_NOT_EXPOSED_TO_NON_AP`
- reason `HOST_REACHABLE_BY_ICMP_BUT_NTP_SILENT`

Final witness verdict:

- `SAME_PHYSICAL_CLIENT_TWO_DISTINCT_NETWORK_PERSPECTIVES=YES`
- `AP_WITNESS=PASS`
- `NONAP_WITNESS=SERVICE_NOT_EXPOSED_TO_NON_AP`
- `CORE_SERVERSTATS_RX_DELTA=1`

## POST / preservation

- `CAPTURE_POST=COMPLETE`
- `SHA256=PASS`
- `FINDINGS_NEW_OR_WORSENED_DRIFT=0`
- `FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0`
- `FINDINGS_INCOMPARABLE=0`
- `FINDINGS_APPROVED_CHANGE=4`
- `FINDINGS_INFO=3`
- `DRIFT_RESULT=PASS`
- `PRESERVATION_S10=PASS`
- `COMPARE_RESULT=PASS`

`COMPARE_LOCAL_PRODUCTION_MUTATION_PERFORMED=NO` is comparator-local only. The authoritative whole-run truth is:

`RUN_PRODUCTION_MUTATION_PERFORMED=YES`

Final TrustedClock:

- state `SYNCED`
- `maxerror_us=500`
- `adjtimex_ret=0`
- `status=0x2001`
- `sta_unsync=0`
- `time_error=0`

Regulatory evidence is preserved exactly as `phy0=TH`, `global=00`. This receipt does not claim that `global=00` equals `TH`.

L0 IDEA2 evidence is also preserved without promotion:

- `process_active=YES`
- `tunnel_healthy=NO_FAILURE_OBSERVED`
- `runtime_healthy=NOT_PROVEN`

## Configuration left applied

Exactly these active chrony directives are expected:

```text
server 2.arch.pool.ntp.org iburst
bindaddress 10.77.30.1
allow 10.77.30.0/28
rtcsync
```

`rtcfile` is forbidden. The RTC side effect from `rtcsync` is owner-accepted.

L4 remained untouched and APPLIED. Core `Pboo_5G` connection UUID `0e545f6e-5f66-4b02-83b7-39cbbed47088` remains `autoconnect=no`; no automatic restoration is authorized.

## Comparator policy preserved

Exactly three rollback-only comparator allowances remain:

- `svc.systemd-timesyncd.service.MainPID`
- `svc.systemd-timesyncd.service.ExecMainStartTimestamp`
- `svc.chronyd.service.ExecMainStartTimestamp`

`ServerName` is not a fourth allowance; it remains governed by the constrained informational policy.

## Future hardening observation

The frozen runner's comments imply UTF-16 witness tolerance, but its normalizer does not fully strip the UTF-16 BOM. This mismatch was intentionally not changed before Attempt #4 because changing the frozen runner hash would invalidate the authorization basis. Attempt #4 used ASCII witness files and passed. This is future hardening only and is not mixed into L5 acceptance.

## Exact closeout truth

```text
L5_LIVE_EXECUTED=YES
L5_APPLY=PASS
L5_VERIFY=PASS
L5_POST_CAPTURE=COMPLETE
L5_PRE_POST_COMPARE=PASS
L5_S10_PRESERVATION=PASS
L5_LIVE_ACCEPTANCE=PROVEN

ATTEMPT1_STATUS=FAIL_CONSUMED
ATTEMPT2_STATUS=FAIL_CONSUMED
ATTEMPT3_STATUS=FAIL_CONSUMED
ATTEMPT4_STATUS=PASS_CONSUMED

L4_STATE=APPLIED
L5_STATE=APPLIED
PBOO_AUTOCONNECT_STATE=no
L6A_STARTED=NO
```

## Files changed by this closeout

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- this new immutable receipt

No implementation, runtime, network, systemd, chrony, NetworkManager, L4, or L6a file is changed.

## Production safety

```text
CLOSEOUT_TASK_PRODUCTION_MUTATION=NO
L5_LIVE_RUN_PRODUCTION_MUTATION=YES
L5_ROLLBACK_PERFORMED=NO
L5_LEFT_APPLIED=YES
L4_MUTATION_BY_CLOSEOUT=NO
L6A_STARTED=NO
```

## Validation boundary

Repository validations must be run on the closeout branch before human merge, including vault validation, collaboration-policy validation if required by repository policy, and `git diff --check`. This receipt does not invent local command results that were not run in this connector-backed closeout session.

## Final state

`L5_LIVE_ACCEPTANCE = PROVEN`

Next recommended phase after human-reviewed closeout merge:

`L6A_PREPARATION`

Do not start L6a in this task. Human merge only.
