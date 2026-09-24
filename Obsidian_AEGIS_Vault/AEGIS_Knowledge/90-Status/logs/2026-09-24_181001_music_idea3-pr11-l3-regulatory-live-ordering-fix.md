---
title: Task Receipt — IDEA3 PR11 Phase 4 L3 regulatory live-ordering fix
date: 2026-09-24T18:10:01+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l3-regulatory-live-ordering
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3 regulatory live-ordering fix

## What changed

- Repository-only design fix after the second L3 live attempt (owner-run, after PR #203). Live facts as reported by the owner: the exact rfkill fix worked (id 1, `rfkill_pre_state=1`, exact unblock, state verified unblocked), but phy0 stayed self-managed `country 00`, so `L3_APPLY=FAIL reason=REGULATORY_DOMAIN_MISMATCH`. Rollback PASS, PRE→RB compare PASS (0/0/0), `PRESERVATION_S10=PASS`. `L3_PRODUCTION_MUTATION=YES` (scope: target rfkill soft state only), `ROLLBACK_COMPLETE=YES`, `POST_ROLLBACK_RESIDUE=NO`. `L3_LIVE_ACCEPTANCE=NOT_PROVEN`. No third live retry; this task performed no Production mutation.
- `CURRENT_ORDERING_SATISFIABLE=NO`: the old contract (unblock → require phy `TH` → install → activate) cannot pass on this hardware state.
- Selected MODEL B: the target phy must report `TH` or the `00` world default AND the approved channel must be unrestricted on that phy (exists, not disabled, no No-IR/passive, no radar/DFS, not indoor-only). Checked once (poll removed) before the profile is installed and again right after activation together with "AP type on exactly the approved channel"; on a post-activation mismatch apply takes its own connection down and fails, and the unchanged reviewed rollback follows. No `iw reg set`, no addressing/DHCP/NAT.
- Comparator: target phy `00→00`, `TH→TH`, approved `00→TH` pass; everything else (global, other phys, `TH→00`, other countries, rule-table change without the approved transition) stays protected drift. The required `00→TH` semantic is removed.
- Stale `TH` premise withdrawn in the prerequisite spec (E-04, OD-03) and the T5 design; canonical status updated. Immutable older receipts untouched.
- Regulatory lifecycle classification recorded in the status note (PROVEN_LIVE / UPSTREAM_DOCUMENTED / INFERENCE / NOT_PROVEN).

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l3-regulatory.sh` — new read-only regulatory/channel gate.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/apply.sh` — gate before install, verification after activation, poll removed.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/verify.sh` — effective channel/regulatory verification.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — target phy `00` accepted; comments.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/allow-transitions.txt` — comment-only contract documentation (active lines unchanged).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — comparator contract.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_regulatory_live.py` — new RED→GREEN tests (fake `iw` reproducing the live state).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_regulatory.py`, `test_pr11_phase4_l3_handler.py`, `test_pr11_phase4_l3_rfkill.py` — old-contract tests updated.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-17-idea3-pr11-phase4-runtime-prerequisites.md`, `2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md` — stale `TH` premise corrected.

## Verification evidence

- New tests before the fix (RED) — fail: 26 failed (helper absent; comparator rejected target `00→00` with `REGULATORY_TARGET_NOT_APPROVED`; old TH-only poll present).
- `pytest tests/test_pr11_phase4_l3_regulatory_live.py tests/test_pr11_phase4_l3_regulatory.py tests/test_pr11_phase4_l3_rfkill.py tests/test_pr11_phase4_l3_handler.py` — pass: 131 passed.
- `pytest tests -k phase4` — pass: 935 passed, 1093 deselected.
- `pytest tests` (full IDEA3, sequential) — pass: 2022 passed, 6 skipped; no flake observed.
- Read-only run of the gate against the real host `iw` (`l3_reg_gate wlp0s20f3 6`) — pass: `country=00 phy=phy0`, channel 6 unrestricted (radio soft-blocked after rollback).
- `bash -n` on every `deploy/pr11-phase4/**/*.sh`, `git diff --check` — pass.
- Vault, collaboration-policy and secret-scan results are listed in the PR description.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — second-attempt facts, corrected regulatory premise, selected design; earlier "NOT PROVEN" bullet marked superseded.

## Shared surfaces touched

- None — task stayed inside `idea3` (`IDEA3-AEGIS_Lockdown/**` and its canonical note).

## Integration requests

- None — valid: no cross-scope path changed. Owner decision M-14 APPROVED MODEL_B (recorded in the status note; not a legal-equivalence or compliance claim: `00` is not claimed equal to `TH`). Still NOT_PROVEN: AP activation changing the phy country to `TH`, and any conclusion on transmit-power limits under `00` (22 dBm listed; L3 does not set TX power).

## Known limitations

- Not run live: whether AP activation changes the MCC to `TH`, and whether `wifi.reg.sha256` stays identical with the AP up (the comparator fails closed if the rule text changes while the country stays `00`).
- Live evidence directories are root-owned and were not readable by the agent; live facts are the owner's report, cross-checked only by read-only `iw`/`rfkill` on the host afterwards.
- L3 live acceptance remains NOT_PROVEN; a third retry needs merge of this PR, fresh same-day authorization/K3 and a new PRE.
