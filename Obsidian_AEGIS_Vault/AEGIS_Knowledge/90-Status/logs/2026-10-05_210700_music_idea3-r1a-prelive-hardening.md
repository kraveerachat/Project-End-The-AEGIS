---
title: Task Receipt — IDEA3 R1A pre-live hardening (M2 durability, M6 frozen-runner authority)
date: 2026-10-05T21:07:00+07:00
owner: music
area: idea3
branch: fix/idea3-r1a-prelive-durability-runner-trust
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1A pre-live hardening (M2 durability, M6 frozen-runner authority)

## What changed

- **M2:** the canonical one-attempt marker and window record (path unchanged, `/var/lib/aegis-idea3-governance`) are forced durable (file, then containing directory) by an explicit fail-closed barrier before the state machine proceeds. A failed barrier after the marker exists is a consumed fail-closed outcome (no window, no observation, no retry); a failed window-record barrier never lets FINAL or VERIFY run. A newly created canonical directory's parent entry is made durable before any marker exists.
- **M6:** a dedicated freeze/verify tool derives the frozen runner as the exact reviewed template (the `EXPECTED_MAIN` Git object, replacement objects disabled) plus ONLY the 19 allowlisted pin substitutions, refuses anything else, creates the file exclusively, and (root only) protects it root-owned, not writable, under trusted ancestors. The Authorization's runner SHA-256 binding is unchanged. The committed runner template is byte-unchanged. Second follow-up (same PR): the snapshot tool had the same weakness, so both production snapshot builders now prove the destination path before root creates anything (fd-anchored creation, then the full check again) and `snapshot`, `control-snapshot`, `check` and `control-check` have no `--trust-root` option (production trust root is the literal `/`; a narrower root is a user-namespace-only test seam). Follow-up repair (same PR): the production frozen-runner ancestor authority runs all the way to `/` with no `--trust-root` option (a narrower root exists only as a user-namespace-only test seam the real root namespace refuses), and a `--root-owned` freeze proves the destination path BEFORE root creates anything (exclusive, parent-relative, never through a symlink, then the full verify again).
- Repository implementation only. Nothing was executed live, no authorization or K3 was created and no live runner was frozen.

## Result and boundary

- `R1A_PRELIVE_HARDENING_REPOSITORY_IMPLEMENTED=YES`
- `R1A_LIVE_EXECUTED=NO`
- `R1A_ATTEMPT_CONSUMED=NO`
- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`
- `R1_VERIFIED=NOT_CLAIMED`
- `RECOVERY_R1_R8_PROVEN=NO`
- `PRODUCTION_MUTATION_PERFORMED=NO`

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/r1a tests/test_r1_acceptance.py tests/r1i` — pass: 405 passed (117 new: 8 durability, 66 runner-freeze, 43 snapshot-freeze; the earlier 288 are unchanged).
- `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_harness.py tests/test_pr11_phase4_f1u_stage.py tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — pass: 694 passed (full files).
- Mutation controls — pass: removing the marker file barrier, the marker directory barrier, the window-record barrier, or making sync failures ignorable each fails the durability tests; disabling template equivalence, the exact-main pin check, the scrubbed `GIT_*` environment, replacement-object protection, the unknown-pin refusal, exclusive create, the non-writable check or pin-value validation each fails the freeze tests. The follow-up repair's controls (pre-write path proof, ancestor proof, parent-symlink check, post-create verify, half-set seam, seam refusal in the real root namespace, default `/`) are each caught; two defense-in-depth guards (the `lexists` pre-check, which `O_EXCL` backs up, and the parent-fd inode recheck, a race guard) have no hermetic test. The snapshot-freeze controls (pre-write trusted-parent proof, symlink-parent refusal, post-create verify in both builders, production trust root `/`, reintroduced `--trust-root` option, seam refusal in the real root namespace, half-set seam, raw-text and path-level canonical destination checks, root requirement) are each caught; the `lexists` pre-check is outcome-equivalent because the fd-relative `mkdir` also refuses a dangling symlink. One mutant (the runner FILE's own owner uid check) survives hermetically because the ancestor-chain check shadows it and a mixed-owner file cannot be created without real root.
- `bash -n` on every touched shell file and `python3 -m py_compile` on the new tooling and tests — pass.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with the two known pre-existing canvas owner-data warnings.
- `git diff --check` — pass; forbidden-action scan of the R1A shell files and secret scan of the added lines — pass.
- No Production command was run; tests never touched the real canonical path.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-r1a-run-lib.sh` — `r1a_fsync`/`r1a_durable` barriers in the marker and window-record sequences.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1a-acceptance/r1a_runner_freeze.py` — new freeze/verify tool.
- `IDEA3-AEGIS_Lockdown/tests/r1a/test_r1a_durability.py` and `test_r1a_runner_freeze.py` — new behavioural tests.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` and the R1A design spec — durability contract, runner-freeze authority and the owner workflow.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — status section.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-05_210700_music_idea3-r1a-prelive-hardening.md` — this receipt.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — R1A pre-live hardening implemented in the repository, not executed; claim boundary preserved.

## Shared surfaces touched

- None — all paths are inside the IDEA3/Music-owned boundary.

## Integration requests

- Human IDEA3 owner and temporary reviewer Kla: review the new freeze tool and the durability sequence. Before any Authorization/K3 the owner proves `RUNNER_TEMPLATE_AUTHORITY=PASS`, `RUNNER_ONLY_APPROVED_PINS_CHANGED=PASS`, `RUNNER_ROOT_OWNED=PASS`, `RUNNER_NONWRITABLE=PASS` and records `RUNNER_SHA256` (workflow in the Phase-4 README, section 17). Run the tool from an export of the exact reviewed main, not an editable worktree.

## Known limitations

- Design is not live proof: the durability barriers use coreutils `sync` and have never run against the real root path, and no runner has been frozen or run live.
- Remaining non-blocking minors from earlier reviews are not addressed here: event-straddling semantics, Authorization scope redesign, general PATH/environment hardening, the EVID path refactor, the host interpreter and standard library not being snapshotted, and the very small check-to-use window.
- No raw Production evidence, secret, runner or authorization content was committed.
