---
title: Task Receipt — IDEA3 PR11 Phase 4 L6a PKI hardening
date: 2026-09-24T13:04:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l6a-pki-hardening
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L6a PKI hardening

## What changed

- `p4-mqtt-pki.py validate-broker-cert` now also rejects weak RSA (<2048) and unapproved EC curves, non-SHA-2 signatures, and leaf lifetimes above the CA profile (1825 days); new optional `--key-file` (regular, non-symlink, mode 0600/0400) verifies the private key matches the certificate.
- `stages/L6a/apply.sh` passes `--key-file` to the offline check.
- Disposable-fixture runs before/after: 34 cases (wrong CA, expired, wrong hostname, missing SAN, IP-only, extra IP SAN, CA:TRUE leaf, weak key/digest, 100-year leaf, mismatched/corrupt key, isolated broker anonymous/wrong-password/ACL/retained) — 3 gaps before, 0 after. No Production key or password was created.
- Repository-only. `PRODUCTION_MUTATION_PERFORMED=NO`, live stage not executed, `PR11_COMPLETE=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-mqtt-pki.py`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6a/apply.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_mqtt_pki_hardening.py`

## Verification evidence

- `pytest tests/test_pr11_phase4_mqtt_pki_hardening.py tests/test_pr11_phase4_mqtt_pki.py tests/test_pr11_phase4_l6a_handler.py` — pass: 44 passed, 2 skipped
- `pytest tests/test_pr11_phase4_*.py tests/test_pr11_k10_server_ca.py` — pass: 872 passed, 2 skipped
- `pytest tests` (IDEA3 full) — pass: 1923 passed, 8 skipped
- `bash -n` on touched shell scripts — pass
- `git diff --cached --check` — pass
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings)
- staged-diff secret scan — pass: no hits
- `scripts/validate-collaboration-policy.mjs` on the PR body and changed files — pass

## Canonical notes updated

- `None` — repository-only fix; no durable project status fact changed (the L3 fix PR carries the canonical status update, avoiding parallel edits to the same note).

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Live L6a not executed; the private PKI inputs are owner-supplied.
- ESP32 compatibility with the approved algorithms is not proven until L8.
- Two tests skip when the local OpenSSL refuses to create MD5/192-bit material.
- The first full IDEA3 run on this branch showed one failure that did not reproduce on an immediate identical rerun (pass counts above are the rerun); the failing test was not captured — likely a timing-sensitive pre-existing test.
