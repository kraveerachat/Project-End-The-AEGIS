---
title: Task Receipt — IDEA3 R1I successor canonical state path compatibility fix
date: 2026-10-09T16:00:00+07:00
owner: music
area: idea3
branch: codex/idea3-r1i-state-path-fix
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1I successor canonical state path compatibility fix

## What changed

- Changed the successor live canonical directory to the isolated
  `/var/lib/aegis-idea3-r1i-successor` path.
- Preserved the derived `authorization.txt` and `state/` paths and the
  existing R1I-SUCCESSOR-20261009 marker identity.
- Documented the separation from the service-owned `/var/lib/aegis-idea3`
  Core tree and retained root-owned, non-symlink, non-writable ancestry
  requirements.
- Added hermetic regressions for derived paths, foreign/symlink/group-writable
  ancestry rejection, and no marker consumption during path validation.
- No Production directory was created or modified; no Core state was migrated.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-successor/r1i_successor.py` — isolated live canonical directory constant.
- `IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_successor.py` — canonical path and trusted ancestry regressions.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-09-idea3-r1i-successor-contract.md` — canonical state-path contract.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-10-09-idea3-r1i-successor.md` — implementation-plan path and provisioning boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-09_160000_music_idea3-r1i-state-path-fix.md` — this immutable receipt.

## Verification evidence

- Red regression before the source fix: `1 failed, 1 passed` on the old nested canonical path.
- `PYTHONDONTWRITEBYTECODE=1 pytest -q IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_successor.py` — PASS: 39 passed.
- `PYTHONDONTWRITEBYTECODE=1 pytest -q IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — PASS: 89 passed.
- `PYTHONDONTWRITEBYTECODE=1 pytest -q IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py --maxfail=1` — FAIL after 58 passed at the unchanged pre-existing `CTv` stage-registry assertion.
- `python3 -m py_compile IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-successor/r1i_successor.py IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_successor.py` — PASS.
- `node --test tests/vaultStructure.test.mjs` — PASS: 1 test.
- `node --test tests/collaborationPolicy.test.mjs` — FAIL: the fixture subprocess cannot resolve the repository collaboration validator from its temporary working directory; no policy files were changed.
- `git diff --check` — PASS.
- No live nftables, Core, Detector, Production, hardware, network, or authorization action occurred.

## Canonical notes updated

- None — the successor contract and plan carry the durable path correction; the existing IDEA3 status note was not rewritten for this bounded source task.

## Shared surfaces touched

- None — all implementation, test, contract, plan, and receipt paths remain within IDEA3 ownership.

## Integration requests

- IDEA3 owner and independent security/governance reviewer must verify the new canonical directory provisioning and exact-head security regression before any future G6 authorization. Production provisioning and execution remain separate and unauthorized.

## Known limitations

- The isolated Production directory remains absent by design and was not created in this repository-only task.
- The unchanged CTv stage-registry assertion and collaboration-policy fixture failure remain separately documented; neither was modified or normalized.
- No Production deployment, nft execution, Core restart, Detector activation, incident mutation, Recovery action, relay command, ESP32 access, or G6 execution occurred.
