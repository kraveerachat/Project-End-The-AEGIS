---
title: Task Receipt — IDEA3 R1I-only governed successor runner
date: 2026-10-09T12:00:00+07:00
owner: music
area: idea3
branch: codex/idea3-r1i-successor
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1I-only governed successor runner

## What changed

- Added the distinct R1I-SUCCESSOR-20261009 repository runner for a future
  separately authorized G6 execution.
- The runner is limited to the exact existing INPUT-only AEGIS_NEWCONN
  nftables producer. It binds fresh authorization to current main, runner,
  and contract digests; captures the complete ruleset immediately before
  mutation; rejects existing or foreign R1I material; proves post-state
  preservation; and performs only narrowly owned rollback.
- No Production, nftables, Core, detector, incident, Recovery, MQTT, relay,
  ESP32, or Kali action occurred.

## Source files changed

- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-successor/r1i_successor.py —
  distinct one-shot authority, independently pinned trusted-main authority,
  foreign AEGIS_NEWCONN detection, snapshot, apply, verify, and rollback runner.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-successor/r1i-successor.nft —
  exact reviewed R1I contract.
- IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_successor.py — hermetic mocked-nft
  regression coverage.
- IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-09-idea3-r1i-successor-contract.md —
  authorization, scope, preservation, and rollback contract.
- IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-10-09-idea3-r1i-successor.md —
  implementation plan and verification boundary.
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-09_120000_music_idea3-r1i-successor.md —
  this immutable receipt.

## Verification evidence

- Final implementation/evidence checkpoint: 0133c9d6 (the receipt-bearing
  commit follows this checkpoint, per the development-session workflow).
- Historical evidence correction: the original receipt recorded 13 focused
  passes at the earlier checkpoint. The corrected PR #416 head independently
  reproduced 18 passes before this final bounded remediation; the final
  remediation adds trusted-main and foreign-log regressions, superseding that
  count below without rewriting the historical claim.
- \`PYTHONDONTWRITEBYTECODE=1 pytest -q IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_successor.py\` — pass: 24 passed.
- \`PYTHONDONTWRITEBYTECODE=1 pytest -q IDEA3-AEGIS_Lockdown/tests/r1i -rs\` — fail:
  49 passed, 1 pre-existing historical stage-registry assertion failed, 7
  skipped because private user/network namespace tests require unavailable
  nft in this environment.
- Independent reviewer evidence reported 55 passed, 1 pre-existing failure,
  0 skipped in an environment where those namespace prerequisites were
  available; both outcomes are retained as environment-dependent evidence.
- \`pytest -q IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py\` — pass:
  89 passed.
- \`pytest -q IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py --maxfail=1\`
  — fail: 58 passed before the pre-existing CTv stage-set assertion.
- \`python3 -m py_compile IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-successor/r1i_successor.py\` — pass.
- bash -n — not applicable; successor implementation is Python-only.
- \`node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge\`
  — pass with 2 pre-existing canvas owner-data warnings.
- \`git diff --cached --check\` — pass.
- No privileged or live Production command was run.

## Canonical notes updated

- None — current IDEA3 canonical status remains historical and is not
  rewritten; this receipt and the contract document record the new Draft PR
  implementation.

## Shared surfaces touched

- None — implementation and tests stay inside the IDEA3 ownership boundary;
  the required receipt is append-only governance evidence.

## Integration requests

- IDEA3 owner and temporary GitHub integration reviewer: independently review
  the fresh authorization binding, complete ruleset preservation comparison,
  one-shot marker durability, and narrow rollback before considering any G6
  Production authorization. Do not merge or execute this runner from this PR.

## Known limitations

- Hermetic mocked-nft tests do not prove Production nft syntax normalization or
  live rule installation. Those remain future G6 evidence gates.
- Future G6 requires authenticated HTTPS access to the fixed official GitHub
  main-ref endpoint; lookup failure is fail-closed before marker or nft use.
- The Core socket, detector, incident state, Recovery state, and historical
  R1I/F1 attempts are intentionally unchanged and are not re-accepted here.
