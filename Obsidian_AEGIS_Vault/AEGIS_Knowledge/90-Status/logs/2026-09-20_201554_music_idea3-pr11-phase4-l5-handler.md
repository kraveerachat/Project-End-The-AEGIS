---
title: Task Receipt — IDEA3 PR11 Phase 4 L5 Core-local trusted NTP runtime handler
date: 2026-09-20T20:15:54+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-phase4-l5-handler
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L5 Core-local trusted NTP runtime handler

## What changed

- Registered the reviewed L5 stage handler (`stages/L5/`) under the G-15 handler framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`) for Core-local trusted NTP runtime serving per approved operational design OD-L5-01 through OD-L5-05.
- Implemented runtime-only service handoff: L5 mutates `ActiveState` only (`systemctl stop systemd-timesyncd`, `systemctl start chronyd`). `UnitFileState` is strictly untouched and protected for both services. Zero `systemctl enable` or `systemctl disable`.
- Implemented atomic `/etc/chrony.conf` configuration lifecycle (`root:root`, mode `0640`): stages replacement in a same-directory temporary file (`mktemp ${target_conf}.tmp.XXXXXX`), validates rendered directives against the T6 contract before activation, performs write durability sync, and executes atomic rename (`mv -f`). Pre-existing file captures exact bytes, uid, gid, and mode.
- Implemented read-only `chronyd.service` config-path preflight: inspects unit definitions, drop-in overrides, and ExecStart; fails closed with `CONFIG_PATH_AUTHORITY_MISMATCH` if any alternate `-f <path>` argument is present.
- Implemented strict time synchronization boundaries: requires pre-handoff `systemd-timesyncd.service` active and running with `TrustedClock = SYNCED` and `maxerror <= 1,000,000 us`. Bounded holdover during handoff <= 300 s. Final post-apply state MUST be `SYNCED` with `maxerror <= 1,000,000 us`. Final `HOLDOVER`, `UNTRUSTED`, or `UNKNOWN` fails closed immediately.
- Enforced strict listener policy: requires `udp <AEGIS_AP_ADDRESS>:123`, permits loopback-only `udp 127.0.0.1:323` and `udp [::1]:323` if observed; strictly forbids wildcard (`0.0.0.0`, `[::]`), non-AP NTP, non-loopback 323, and TCP/123.
- Implemented idempotent rollback: `stages/L5/rollback.sh` stops `chronyd.service`, restores captured pre-L5 `/etc/chrony.conf` bytes, uid, gid, and mode without normalization (or removes `/etc/chrony.conf` if absent pre-L5), restores captured pre-L5 `systemd-timesyncd.service` runtime `ActiveState` without modifying `UnitFileState`, and verifies `TrustedClock = SYNCED`.
- Preserves existing L2, L3, L4, and L6b registrations and contracts. L4 AP addressing/DHCP/DNS, L2 firewall rules, forwarding disable (`net.ipv4.ip_forward=0`), zero NAT/masquerade, and existing network routes remain intact.
- Enforced complete fixture/live separation: fixture mode writes only beneath `AEGIS_P4_FS_ROOT` and executes zero live host mutations.
- No live L5 execution was performed; no Production, network, service, timesyncd, chronyd, or /etc mutation occurred.

Approved design authority:
- Commit: `bb0472f3c437f5572b24528255b87f4342a7b1de`
- Subject: `docs(idea3): approve PR11 Phase4 L5 operational design`

Implementation commit:
- Commit: `7f6d41f6fb4fe6cfff8d4759fa8c13579eae0460`
- Subject: `feat(idea3): add PR11 Phase4 L5 runtime handler`

Closeout files created/updated in this session:
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-20_201554_music_idea3-pr11-phase4-l5-handler.md` (this receipt)

```text
L2_HANDLER                   = REGISTERED
L3_HANDLER                   = REGISTERED
L4_HANDLER                   = REGISTERED
L5_HANDLER                   = REGISTERED
L6A_HANDLER                  = NOT_REGISTERED
L6B_HANDLER                  = REGISTERED

L2                           = NOT RUN
L3                           = NOT RUN
L4                           = NOT RUN
L5                           = NOT RUN
L6A                          = NOT RUN
L6B                          = NOT RUN

PRODUCTION_MUTATION          = NO
NETWORK_MUTATION             = NO
REAL_NTP_MUTATION            = NO
REAL_TIMESYNCD_MUTATION      = NO
REAL_CHRONYD_MUTATION        = NO
L5_LIVE_AUTHORIZED=NO
LIVE_L5=NOT_RUN
PHASE4_RUNTIME_COMPLETE      = NO
PHASE4_LIVE_READINESS        = NOT READY
```

## Source files changed

Implementation commit (`7f6d41f6fb4fe6cfff8d4759fa8c13579eae0460`):
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/allow-keys.txt` (mode 100644) — exact approved keys for L5 stage (chronyd and timesyncd runtime states, chrony leap status, /etc/chrony.conf file capture attributes).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/allow-listeners.txt` (mode 100644) — exact approved listeners for L5 stage (`udp <AEGIS_AP_ADDRESS>:123`, loopback `udp 127.0.0.1:323`, loopback `udp [::1]:323`).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/apply.sh` (mode 100755) — L5 trusted NTP activation handler with read-only chronyd config-path check, timesyncd/TrustedClock preflights, atomic config placement, and runtime service handoff.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/verify.sh` (mode 100755) — read-only verification of chrony config, service states, final SYNCED TrustedClock, listeners, and L4/L2 preservation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/rollback.sh` (mode 100755) — idempotent L5 rollback handler restoring pre-L5 /etc/chrony.conf bytes/metadata and timesyncd runtime ActiveState while proving SYNCED.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l5_handler.py` (mode 100644) — comprehensive 47 test cases for L5 handler, allowlists, failure rollbacks, and negative controls.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` (mode 100644) — updated reviewed stage registry to `{"L2", "L3", "L4", "L5", "L6b"}` and shifted unregistered live failure test to `L6a`.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l4_handler.py` (mode 100644) — updated registration matrix assertion to expect deterministic `status_map["L5"] == "REGISTERED"`.

Closeout documentation files (uncommitted):
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updated handler registration status and added L5 handler documentation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — recorded canonical L5 handler registration facts, test evidence, and safety boundaries.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-20_201554_music_idea3-pr11-phase4-l5-handler.md` — this immutable task receipt.

## Verification evidence

- Bash syntax validation (`bash -n` on all L5 scripts, shared framework scripts, and gate tools): PASS.
- Focused L5 pytest (`test_pr11_phase4_l5_handler.py`): 47 passed.
- T6 NTP pytest (`test_pr11_phase4_ntp.py`): 26 passed.
- Trusted time pytest (`test_trusted_time.py`): 13 passed.
- L4 handler pytest (`test_pr11_phase4_l4_handler.py`): 51 passed.
- Phase 4 harness pytest (`test_pr11_phase4_harness.py`): 160 passed.
- Private AP network pytest (`test_private_ap_contract.py`): 4 passed.
- All Phase 4 test suite (`test_pr11_phase4_*.py`): 405 passed, 0 failed, 0 skipped.
- Diff check (`git diff --check`): PASS (clean).
- BASH stage registration probe:
  - `L2   REGISTERED`
  - `L3   REGISTERED`
  - `L4   REGISTERED`
  - `L5   REGISTERED`
  - `L6a  NOT_REGISTERED`
  - `L6b  REGISTERED`

Repository acceptance state:
```text
L5_DESIGN_APPROVED          = YES
L5_HANDLER_REGISTERED       = YES
L5_REPOSITORY_IMPLEMENTED   = YES
L5_CANDIDATE_HARDENING      = PASS
FULL_PHASE4_REGRESSION      = PASS
```

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records repository-only L5 handler registration, test results, verification evidence, unchanged live boundaries, and the open IDEA2 preservation caveat.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updates stage rollback handlers summary to `L2, L3, L4, L5, L6b REGISTERED` and adds the L5 handler scope/boundary documentation.

## Shared surfaces touched

The collaboration policy classifies the following changed paths as cross-scope surfaces requiring integration review:

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/allow-keys.txt`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/allow-listeners.txt`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/apply.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/rollback.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/verify.sh`
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-20-idea3-pr11-phase4-l5-operational-design.md`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l4_handler.py`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l5_handler.py`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`

Cross-area behavior:

- L4 runtime implementation itself was NOT modified.
- IDEA1 mutation = NO
- IDEA2 mutation = NO

## Integration requests

- Human code-owner review required.
- Human merge required.
- L5_PR_OPENED = YES: Draft PR #162 exists for human review. The PR remains Draft until collaboration guardrails pass; Ready for Review and merge remain human-review steps.
- This receipt does not authorize live L5.
- Future live L5 remains separately gated by:
  - L2, L3, and L4 live PASS
  - fresh same-day A-L5 authorization
  - fresh K3 key
  - owner-supplied trusted upstream NTP server value
  - external physical AP-side NTP query evidence (`UDP <AEGIS_AP_ADDRESS>:123` valid response)
  - external non-AP query evidence establishing `SERVICE_NOT_EXPOSED_TO_NON_AP`
  - resolution or formally accepted reconciliation of the open IDEA2 §10 caveat
  - all standard stop conditions.

## Known limitations

- Provenance disclosure: `RED_FIRST_PROVEN=NO`. There is no retained evidence proving that the L5 focused tests were observed failing before the candidate handler files were created. The candidate was therefore treated as untrusted existing work, independently audited, corrected for deterministic regression behavior, subjected to hardening review, and accepted only after the complete repository verification passed.
- L5 handler repository registration does not prove live execution.
- L5 remains NOT RUN.
- L6a remains unregistered.
- L2, L3, L4, and L6b are registered but remain NOT RUN.
- IDEA2 §10 preservation caveat remains open and blocking.
- PHASE4_RUNTIME_COMPLETE remains NO.
- PHASE4_LIVE_READINESS remains NOT READY.
