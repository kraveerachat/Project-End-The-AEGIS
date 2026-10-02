---
title: Task Receipt — IDEA3 L34 V8 AP-profile timestamp false-positive fix (repository only)
date: 2026-10-02T17:35:00+07:00
owner: music
area: idea3
branch: fix/idea3-l34-v8-profile-timestamp-false-positive
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L34 V8 AP-profile timestamp false-positive fix (repository only)

## What changed

- Fixed the V8 persistent-profile canonicalizer `l34_v8_profile_canonical` so it also ignores `[connection]/timestamp`, but ONLY when the value is a non-negative decimal integer. A `timestamp` in any other section, a non-numeric value, or any other unknown key still changes the canonical set.
- Why: the one-shot live V8 attempt on 2026-10-02 (main `9f5a0114`, consumed_at `2026-10-02T09:50:11Z`) failed with `L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT:aegis-idea3-ap.nmconnection` after the single `nmcli connection modify`, and the rollback proof failed with the same invariant (S-11 HOLD). A human-owner read-only canonical diff proved the only difference was `> [connection]/timestamp=1790896283` (profile `600 root:root`, `psk_lines=1` unchanged). libnm's own keyfile writer emits that NetworkManager-maintained last-activation epoch after the daemon rewrites an activated profile.
- Regression-first: new libnm-writer fixtures and tests were written first and failed (10 failures) against the old library with the exact live error; the one-line fix turned them green.
- This task is repository/local verification only. It is NOT a live V8 success. No Production mutation, no host recovery, no V8 retry, no Core restart, no Auth/K3 created. The consumed V8 authorization, marker and evidence (`2026-10-02-l34-v8-20261002-165006`) are historical and untouched.
- Closeout state: `BASELINE_FIX_IN_THIS_PR=NO`, `HOST_RECOVERY_IN_THIS_PR=NO`, `SUCCESSOR_LIVE_ATTEMPT=BLOCKED_PENDING_BASELINE_RECONCILIATION`; the consumed V8 attempt is not reusable.
- Separate finding (no code change): the post-hold host tuple (phy `00`, p2p-dev present, `wpa_supplicant` active) is classified `MIXED_OR_UNRECOGNIZED` by `l34_baseline_classify`, while `l34_p2p_rollback_safe` and `l34_wpa_safe_state` accept it for rollback. A new stage cannot start from that state unless the host is first returned to a supported baseline (owner-governed) or a separately reviewed classifier extension is merged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-v8-lib.sh` — `l34_v8_profile_canonical` excludes numeric `[connection]/timestamp`; comment updated.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — simulator option `profile_modify_adds_timestamp` (libnm order: timestamp after interface-name).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v8_profile_canonical.py` — timestamp regression, bypass negatives, protected-value controls with timestamp present, rollback-direction test, handler-level apply/verify/rollback cases, updated exclusion-count test, gi-conditional fixture provenance test.
- `IDEA3-AEGIS_Lockdown/tests/fixtures/l34_v8/profile-libnm-autoconnect-yes-timestamp.nmconnection` — libnm-writer output (timestamp=1790896283).
- `IDEA3-AEGIS_Lockdown/tests/fixtures/l34_v8/profile-libnm-autoconnect-no-timestamp.nmconnection` — libnm-writer output (timestamp=1790896283).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l34-v8-post-v7-persistent-ap-recovery-design.md` — canonicalization section and live S-11 amendment.

## Verification evidence

- RED: `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_l34_v8_profile_canonical.py` (tests only, old library) — fail: 10 failed, 70 passed; failure text `L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT:aegis-idea3-ap.nmconnection`.
- GREEN: same command after the fix — pass: 80 passed (system Python with libnm/gi, so the byte-for-byte libnm fixture tests ran).
- `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_l34_v8_profile_canonical.py tests/test_pr11_phase4_l34_v8_post_v7_persistent_ap_recovery.py tests/test_pr11_phase4_l34_v8_owner_run_flow.py tests/test_pr11_phase4_l34_v8_scope_contract.py` — fail: 299 passed, 1 failed (`test_exactly_one_v8_receipt_exists_and_states_the_non_claims`, caused by this receipt's first filename matching the original V8 task's receipt glob; receipt renamed to `…_music_idea3-v8-profile-timestamp-false-positive.md`), then re-run below.
- Final focused run after the helper rename and receipt rename: `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_l34_v8_profile_canonical.py` — pass: 80 passed. L3/L4/V8 suites: `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_l34_*.py tests/test_pr11_phase4_l3_*.py tests/test_pr11_phase4_l4*.py` — pass: 1474 passed.
- `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_l34_v8_scope_contract.py` (after the receipt rename) — pass: 59 passed. `~/.venvs/aegis-idea3-core/bin/python -m pytest -q tests/test_pr11_phase4_l34_v8_profile_canonical.py` — pass: 77 passed, 3 skipped (no gi in that venv).
- `~/.venvs/aegis-idea3-core/bin/python -m pytest -q tests` (full IDEA3 regression, from `IDEA3-AEGIS_Lockdown/`) — pass: 5674 passed, 11 skipped, 0 failed (28m51s).
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-v8-lib.sh` — pass. `node scripts/validate-collaboration-policy.mjs` (PR #299 body + changed files) — pass. `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass (2 existing canvas warnings). Secret-pattern and generated-artifact scan of the 8 changed paths — none found (fixtures carry only the fake `NOT-A-REAL-PSK-FIXTURE`).
- `git diff --check` — pass.
- Environmental note: the system Python has paho-mqtt 1.x, so `tests/test_pr11_phase4_broker_validate.py::test_validator_authenticates_both_rendered_identities` fails there; it fails identically on untouched main and passes on the paho 2.x venv.
- Classifier probe (pure functions, no host access): observed hold tuple → `L34_BASELINE_MIXED_OR_UNRECOGNIZED`; FRESH and RESIDUAL tuples classify as before.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the V8 live-attempt FAILED / S-11 HOLD section (root cause proven, host recovery not performed, consumed attempt historical) and corrected the stale V8 NOT_RUN statements.

## Shared surfaces touched

- `None` — task stayed inside the idea3 area.

## Integration requests

- None — valid only when no cross-scope/shared path changed. A later owner decision is needed (not part of this PR): how the host returns to a supported baseline, or whether to extend the baseline classifier.

## Known limitations

- Repository/local verification only; V8 live acceptance, L3/L4/L6b acceptance and K12 reboot persistence are NOT claimed.
- The host remains in SAFE_HOLD; the on-disk AP profile still carries the NetworkManager `timestamp` line and the host baseline is currently unsupported by the classifier.
- A new live attempt needs a fresh governed stage or runner freeze, a fresh preflight and a fresh same-day Auth/K3.
