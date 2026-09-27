---
title: Task Receipt — IDEA3 PR11 Phase 4 L6c "Immutable Release Install" governed stage
date: 2026-09-27T18:16:56+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l6c-release-install-governance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L6c "Immutable Release Install" governed stage

> [!important] Repository design/implementation only
> **L6c was NOT executed and NOT authorized. No Production mutation, no sudo, no host `systemctl`, no A-L6c/K3/A-L7/D6 or Production secret created, no L8, no ESP32.** `L6C_LIVE_EXECUTED = NO`, `A_L6C_CREATED = NO`, `L7_LIVE_EXECUTED = NO`, `A_L7_CREATED = NO`, `L8_STARTED = NO`.
> Base: main `0c538552997c1be5d52df716a07a5a204ba9cd39` (PR #230 merged; PR #202 closed unmerged as superseded).

## Owner decision implemented

`PRE_L7_RELEASE_INSTALL_GOVERNANCE = SEPARATE_G15_STAGE`, `CANONICAL_STAGE_ID = L6c`, `CANONICAL_STAGE_NAME = Immutable Release Install`, `AUTHORIZATION = A-L6c`, `K3 = FRESH_STAGE_L6c`. A-L7 is never created, consumed, or reused by L6c, and vice versa — proven structurally via `p4-stage-gate.sh`'s `stage=` field match, not invented.

## Authority audit (before this change)

No `L6c` existed anywhere (scripts, docs, tests, owner-run tooling). `P4_STAGES` went `... L6a L6b L7 ...`. The gap was already recorded: the L7 design (§7/§8, 2026-09-27) and PR #208's own receipt both named "an owner decision on the release installer" / "the release/venv installer" as open. No name collision with `L6c`.

## What changed

1. **G-15 observability gap closed first, then hardened in pre-merge review.** `p4-l0-capture.sh` was blind to `/opt/aegis-idea3/releases/<id>` — RED proof: 18 failed (`tests/test_pr11_phase4_l6c_capture_gap.py`, against the unmodified capture/compare). The first implementation added fixed parent-presence keys and `host.aegis_idea3.release_catalog`; pre-merge review then found that hashing only `RELEASE-SHA256SUMS` did not prove actual bytes or metadata. Final contract: new read-only `p4-l6c-tree-digest.py` hashes the actual deterministic tree state (relative path, type, uid, gid, mode, and actual bytes for regular files), detects payload/mode/owner/add/remove/symlink/special drift without changing `RELEASE-SHA256SUMS`, opens regular files no-follow with inode/metadata stability checks, rescans the tree, and fails closed on observed races/unreadable entries. Evidence still records only `<release-id>:<digest>`. `ALLOW_L6C_RELEASE_FILE` approves only the addition of one named id; mutation/removal of an existing release always fails.
2. **L6c registered:** `P4_STAGES` now `... L6a L6b L6c L7 ...`; `p4_stage_gaps L6c = none` (derived, not copied from L7's G-11/G-12, since L6c never provisions a key or credential); `p4_stage_auth_extra L6c` has no extra field (no `d6_notice`).
3. **Handler:** `stages/L6c/apply.sh|verify.sh|rollback.sh` + `allow-keys.txt` (exactly the two new `host.path` keys) + `allow-listeners.txt` (empty). Calls the already-merged `p4-l7-install-release.py`/`p4-l7-release-guard.py` without duplicating their predicates; journals the exact mutation boundary before the one installer call; never touches `current`, a pre-existing release, credentials, `core.env`, systemd, the Core service, the L6b broker, IDEA2, ESP32 or L8.
4. **Owner runner:** `p4-l6c-run-lib.sh` + `owner-run/run-l6c-owner.sh` (unpinned: main SHA, release id, expected source SHA; one attempt per `A-L6c`). Final pre-merge order is all read-only gates → baseline/evidence setup (including the release allow file) → PRE capture plus SHA256 validation → `L6C-ATTEMPT-CONSUMED` → immediate apply. Failed PRE capture/checksum leaves the marker absent and Production unchanged. Any failure after mutation gets one bounded rollback and strict zero-drift PRE→RB; failed rollback proof exits 3/S-11 HOLD; no retry.
5. **L7 relationship:** `L6C_RELEASE_INSTALL = PROVEN` is documented as a prerequisite FACT, not an authorization; L7's own `l7_release_gate` still independently re-runs the release guard read-only. A fresh `A-L7`/K3 remain required and are never combined with L6c's records.
6. **Installer parent contract corrected before merge.** The old installer unconditionally repaired existing parent modes. Final `_ensure_parent_dirs()` validates every existing ancestor before mutation (directory, not symlink, not group/other-writable), never chmods/chowns it, and preserves uid/gid/mode; adding a legitimate child may naturally advance parent mtime. Only missing stage-owned parents are created at reviewed mode `0755`. Higher ancestors are still checked when `releases/` already exists.
7. **Rollback live ownership corrected before merge.** `stages/L6c/rollback.sh` now mirrors verify: fixture root expects any owner, live/default expects root. Ownership drift is refused instead of deleted.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — `P4_STAGES`, `p4_stage_gaps L6c`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh`, `p4-l6c-tree-digest.py` — actual tree-state release-catalog capture.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — `ALLOW_L6C_RELEASE_FILE` + relational rule.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6c/apply.sh|verify.sh|rollback.sh|allow-keys.txt|allow-listeners.txt` — new handler.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l6c-run-lib.sh`, `owner-run/run-l6c-owner.sh` — new owner runner and corrected PRE/consume/apply ordering.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-install-release.py` — validate every existing parent, create only missing parents, never repair existing metadata.
- `IDEA3-AEGIS_Lockdown/tests/l6c_support.py`, `test_pr11_phase4_l6c_capture_gap.py`, `test_pr11_phase4_l6c_handler.py`, `test_pr11_phase4_l6c_runner.py`, `test_pr11_phase4_l6c_runner_flow.py`, `test_pr11_phase4_l7_release_installer_helper.py` — tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — L6c added to the ordered stage-registry fixtures.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md` — new design.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` — cross-reference note (§8 amendment area); no historical text rewritten.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — new L6c section.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new dated section (this receipt); historical sections unedited.

## Verification evidence

- `pytest` RED-first (G-15 capture gap, before implementation) — fail: 18 failed, 4 passed.
- `pytest tests/test_pr11_phase4_l6c_capture_gap.py` — pass: 33 passed.
- `pytest tests/test_pr11_phase4_l6c_handler.py` — pass: 63 passed.
- `pytest tests/test_pr11_phase4_l6c_runner.py` — pass: 33 passed.
- `pytest tests/test_pr11_phase4_l6c_runner_flow.py` — pass: 22 passed.
- `pytest tests/test_pr11_phase4_l7_release_installer_helper.py` — pass: 49 passed.
- `pytest tests/test_pr11_phase4_l7_release_guard_helper.py` — pass: 42 passed.
- `pytest tests/test_pr11_phase4_l6c_capture_gap.py tests/test_pr11_phase4_l6c_handler.py tests/test_pr11_phase4_l6c_runner.py tests/test_pr11_phase4_l6c_runner_flow.py tests/test_pr11_phase4_l7_release_installer_helper.py tests/test_pr11_phase4_l7_release_guard_helper.py` — pass: 242 passed after pre-merge fixes.
- `pytest tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_runner_flow.py` — pass: 333 passed after pre-merge fixes (localhost fixtures only; no live L7).
- `pytest tests/test_pr11_phase4_harness.py` — pass: 222 passed.
- `pytest tests -k phase4` — pass: 2500 passed, 2 skipped, 1108 deselected.
- `pytest tests` (full IDEA3 suite) — pass: 3602 passed, 8 skipped.
- `bash -n` on every changed shell script — pass. `py_compile` on every changed/new Python file — pass. `git diff --check` — pass (no whitespace errors). Full-diff secret-pattern scan — pass: no unexpected match.
- `node scripts/validate-vault.mjs` — pass, 2 pre-existing canvas warnings only.
- `node scripts/validate-collaboration-policy.mjs` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L6c governed-stage section.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None. PR #202 remains closed, unmerged, untouched.

## Known limitations

- Live-only, unproven offline: the real installer's `os.rename` on the live filesystem, real root ownership, and the real owner-run pre-gate sequence end to end. Fixture/local tests do not prove live filesystem/root semantics.
- The tree digest detects and fails closed on observed mutation races, but it is not an atomic filesystem snapshot; a sufficiently privileged ABA mutation wholly between checks cannot be excluded without snapshot support. The live contract therefore requires the root-owned immutable release tree to be quiescent during capture.
