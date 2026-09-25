---
title: Task Receipt — IDEA3 PR11 L4 dnsmasq loopback exclusion
date: 2026-09-25T13:30:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l4-dnsmasq-except-lo
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 L4 dnsmasq loopback exclusion

## Live evidence (Retry #3, read-only reference)

- Evidence path: `/home/kittipat/Workspace/idea3-p4-evidence/2026-09-25-l4-20260925-105259`
- `L4_APPLY = PASS`, `L4_VERIFY = PASS`; approved listeners observed: `listen.tcp.10.77.30.1:53`, `listen.udp.10.77.30.1:53`, `listen.udp.0.0.0.0%wlp0s20f3:67`.
- Canonical PRE->POST compare FAILED only on four out-of-scope loopback DNS listeners: `listen.tcp.127.0.0.1:53`, `listen.tcp.[::1]:53`, `listen.udp.127.0.0.1:53`, `listen.udp.[::1]:53`.
- Rollback `PASS`; PRE->RB compare `PASS`; S10 preservation `PASS`.
- `L4_LIVE_ACCEPTANCE = NOT_PROVEN`.

## Root cause

dnsmasq rendered with `interface=<AP_IF>` + `bind-interfaces` implicitly also binds loopback (documented dnsmasq behavior when `--interface` is used), which is outside the merged L4 allow-listeners contract.

## What changed

- `stages/L4/apply.sh`: rendered `dnsmasq-ap.conf` adds `except-interface=lo` (keeps `interface=`, `bind-interfaces`; no `listen-address`).
- `stages/L4/verify.sh`: requires exact line `except-interface=lo` (`DNSMASQ_EXCEPT_INTERFACE_LO_MISSING`).
- `allow-listeners.txt` NOT changed; loopback listeners are NOT allowed.
- `tests/test_pr11_phase4_l4_handler.py`: new render regression, verify negative test, and allowlist test hardened (exactly three entries, no `127.0.0.1` / `[::1]`).

## Verification evidence

- `pytest tests/test_pr11_phase4_l4_handler.py -k "excludes_loopback or except_interface or allowlist_contains"` before implementation — RED: 2 failed, 1 passed
- `pytest tests/test_pr11_phase4_l4_handler.py` — pass: 53 passed
- `pytest tests -k phase4` — fail (pre-existing only): 7 failed, 1079 passed (base bf0d1546: 7 failed, 1077 passed; same 7 failures, in `test_pr11_phase4_broker_validate.py` and `test_pr11_phase4_l6a_handler.py`, pre-existing and unrelated).
- `pytest tests` (full) — fail (same pre-existing only): 7 failed, 2165 passed, 7 skipped (same 7 pre-existing failures).
- `bash -n` on apply.sh and verify.sh — pass
- `git diff --check` — pass

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L4/apply.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L4/verify.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l4_handler.py`

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L4 dnsmasq loopback exclusion section added (conservative status).

## Shared surfaces touched

- None outside the IDEA3 boundary; no IDEA1/IDEA2, Twingate, NetworkManager, nftables, rfkill, regulatory or ESP32 change.

## Integration requests

- Human review and merge of the PR; then a fresh authorized L4 live retest (not performed here).

## Known limitations

- Fix is proven by repository tests only; live effect on the listener set is untested until L4 retest.
- 7 pre-existing unrelated failures (broker_validate, l6a_handler) exist on base.

## Status

- `L4_REPOSITORY_FIX_IMPLEMENTED = YES` (tests above)
- `LIVE_RETEST_REQUIRED = YES`
- `L4_LIVE_ACCEPTANCE = NOT_PROVEN`
- `NEXT_LIVE_STAGE = L4_RETEST`
- No Production/runtime mutation; L4 live runner and L1/L2/L3 not run; PR not merged.
