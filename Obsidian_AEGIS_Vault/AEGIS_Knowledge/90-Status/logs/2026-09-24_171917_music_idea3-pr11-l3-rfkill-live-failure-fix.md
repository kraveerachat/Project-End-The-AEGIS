---
title: Task Receipt — IDEA3 PR11 Phase 4 L3 rfkill live-failure fix
date: 2026-09-24T17:19:17+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l3-rfkill-live-failure
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3 rfkill live-failure fix

## What changed

- Follow-up to the first L3 live attempt (owner-run, fail-closed at `REGULATORY_DOMAIN_MISMATCH`, rollback PASS, PRE→RB compare PASS, S10 PASS). The failed attempt is recorded in the canonical status; L3 live acceptance stays NOT_PROVEN and **no live retry occurred**.
- Proven defect (read-only diagnostics on the live host): util-linux `rfkill` 2.42.3 rejects `rfkill --output SOFT 1` (identifier valid only after a command, exit 1). The handler discarded stderr, treated the empty state as not blocked, wrote `rfkill_pre_state=0` and never ran `rfkill unblock`; its hard-block guard also passed on an empty string.
- Fix: new `p4-l3-rfkill.sh` (exact sysfs-bound id, exact `rfkill list <id>` row, fail closed on any anomaly or hard block, pre-state before the exact-id unblock, post-unblock verification, exact-id restore in rollback). L3 apply/rollback source it.
- Regulatory lifecycle for this self-managed Intel AX203 phy is documented as NOT_PROVEN (no change to the gate, timeout or owner requirement).
- `PRODUCTION_MUTATION_PERFORMED=NO` (this task), `L3_LIVE_RETRY=NO`, `PR11_COMPLETE=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l3-rfkill.sh` — new exact-id rfkill helper
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/apply.sh`, `stages/L3/rollback.sh` — use the helper
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_rfkill.py` — new (24 behavioural cases with a util-linux-grammar fake)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_handler.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_regulatory.py` — structural assertions follow the helper

## Verification evidence

- `pytest tests/test_pr11_phase4_l3_rfkill.py` before the implementation — RED: 21 failed, 3 passed (2 passing cases document the live mechanism)
- `pytest tests/test_pr11_phase4_l3_rfkill.py tests/test_pr11_phase4_l3_handler.py tests/test_pr11_phase4_l3_regulatory.py` — pass: 103 passed
- `pytest tests/test_pr11_phase4_*.py tests/test_pr11_k10_server_ca.py` — pass: 943 passed
- `pytest tests` (IDEA3 full, sequential) — first run 1 failed, 1993 passed, 6 skipped: `tests/test_local_restore.py::test_closing_the_channel_cancels_an_incomplete_client_before_returning` (1-second shutdown wait under load; file untouched by this task; passes 5/5 in isolation) — classified pre-existing timing flake; identical rerun pass: 1994 passed, 6 skipped
- `bash -n` on `p4-l3-rfkill.sh`, `stages/L3/apply.sh`, `stages/L3/rollback.sh` — pass
- `git diff --cached --check`, `node scripts/validate-vault.mjs` (2 pre-existing canvas warnings), staged-diff secret scan, `scripts/validate-collaboration-policy.mjs` — pass (see PR)
- Read-only live diagnostics (no state change): `rfkill --version`, `rfkill --noheadings --output SOFT 1` (usage error, rc 1), `rfkill --noheadings --output ID,TYPE,SOFT,HARD list 1`, `/sys/class/rfkill/rfkill1/{soft,hard,type,index}`, `iw phy`, `ethtool -i`, `modinfo iwlwifi`, `nmcli device show`, `journalctl -k`, NetworkManager journal

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — first L3 live attempt (fail-closed, rollback PASS, S10 PASS, acceptance NOT_PROVEN), proven rfkill root cause, fix, remaining regulatory uncertainty

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Whether the current ordering (unblock → target phy `TH` → profile install → activation) is satisfiable for this self-managed phy is NOT_PROVEN; a retry may fail closed again at the regulatory gate (rollback re-blocks the radio) and would then give the first real evidence.
- The live-only rfkill branch is verified against a fake that implements the util-linux grammar, not against the real binary during apply.
- Live evidence from the failed attempt (PRE/RB bundles, work dir) is root-only and owner-reported; it was not modified.
