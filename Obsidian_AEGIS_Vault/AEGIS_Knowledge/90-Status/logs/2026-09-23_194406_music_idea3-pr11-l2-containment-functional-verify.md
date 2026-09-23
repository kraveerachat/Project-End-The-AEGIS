---
title: Task Receipt — IDEA3 PR11 L2 containment functional verifier
date: 2026-09-23T19:44:06+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l2-containment-functional-verify
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 L2 containment functional verifier

## What changed

- A repository-side L2 dynamic IPv4 containment functional verifier
  (`verify-containment-functional.sh`) was added. It proves the behavioral
  part of the L2 dynamic IPv4 containment contract that the existing
  static `verify.sh` does not prove: block, repeated-block idempotency,
  membership listing, observed traffic denial, unblock, repeated-unblock
  idempotency, observed traffic restoration, audit evidence, no unrelated
  table mutation, and idempotent rollback.
- The verifier exercises the real `aegis_soc.ip_containment` module
  (`ContainmentService`, `ContainmentServer`, `ContainmentClient`,
  `NftBlockSet`) against a real `nft` binary, inside two disposable,
  unprivileged network namespaces it creates and destroys itself.
- Functional contract items 07, 08, 09, 10, 11, 12, 13, 14, 15, 17 were
  verified PASS on the final pre-receipt tree (fresh run, see "Verification
  evidence" below).
- No `sudo`/root was used anywhere in this verifier or its tests.
- No live host firewall was mutated.
- No Production mutation was performed.

```text
SOURCE_IMPLEMENTED=YES
LOCAL_VERIFIED=YES
PRODUCTION_MUTATION_PERFORMED=NO
LIVE_HOST_ACCEPTANCE=NO
L2_LIVE_HOST_VERIFIED=NO
PR11_COMPLETE=NO
```

## Source files changed

1. `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L2/verify-containment-functional.sh` (new) — the functional verifier.
2. `IDEA3-AEGIS_Lockdown/tests/test_l2_containment_functional_verify.py` (new) — TDD coverage for the verifier.
3. `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l2_handler.py` (modified) — registers the new script in `REQUIRED_HANDLER_FILES`.
4. `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` (modified) — registers the new script for `test_only_reviewed_stage_handlers_are_registered`.

## Verification evidence

Fresh final-tree verification, run after fast-forwarding this branch to its
current remote head (`df834d2f`) and merging current `origin/main`
(`0051cceb`), from `IDEA3-AEGIS_Lockdown/` unless noted:

- `PYTHONDONTWRITEBYTECODE=1 ~/.venvs/aegis-idea3-core/bin/python3 -m pytest -p no:cacheprovider -q tests/test_l2_containment_functional_verify.py` — **passed**: 8 passed in 3.68s.
- `bash deploy/pr11-phase4/stages/L2/verify-containment-functional.sh` — **passed**: `L2_CONTAINMENT_FUNCTIONAL_VERIFY=PASS`; items `07,08,09,10,11,12,13,14,15,17` all `PASS`; `LIVE_HOST_ACCEPTANCE=NO`; `PRODUCTION_MUTATION_PERFORMED=NO`.
- `PYTHONDONTWRITEBYTECODE=1 ~/.venvs/aegis-idea3-core/bin/python3 -m pytest -p no:cacheprovider -q tests/` — **passed**: 1890 passed, 6 skipped in 125.88s.
- `git diff --check` (repository root, post-merge tree) — **passed**: no output, exit 0.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` (repository root) — **passed**: "Vault validation passed with 2 warning(s)." (both warnings are pre-existing, on unrelated `.canvas` files, not touched by this task).

Development evidence already preserved in PR #185 (distinct from the fresh
final-tree verification above, recorded here for continuity):

- TDD RED: the new test file was proven 8/8 failing with the script
  temporarily moved aside, then restored to 8/8 GREEN.
- Negative control: a disposable, uncommitted copy of the script with its
  drop-first `blocked_ipv4` rule removed correctly fails `ITEM_09` (traffic
  denial); the tracked script itself was never modified.

## Canonical notes updated

- None — `idea3-status.md` is intentionally not modified by PR #185 because
  canonical PR11 documentation is being reconciled separately; this task's
  durable task record is this immutable receipt.

## Shared surfaces touched

- None — all PR185-owned changes are IDEA3 paths plus this music-owned receipt.

## Integration requests

- None — no cross-scope/shared path is changed by PR185.

## Known limitations

- Live-host contract items 1-6 and 16 remain outside this repository-side
  verifier — they require a separate, explicitly authorized L2 live task.
- Item 18 (Core event-routing policy) remains covered by the existing
  `tests/test_runtime.py`, not this new functional script.
- L2 live-host verification remains separate owner-authorized work.
- This PR does not claim Production deployment, live acceptance, or PR11
  completion: `PRODUCTION_MUTATION_PERFORMED=NO`, `LIVE_HOST_ACCEPTANCE=NO`,
  `L2_LIVE_HOST_VERIFIED=NO`, `PR11_COMPLETE=NO`.
