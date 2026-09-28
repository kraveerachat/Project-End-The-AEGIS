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
> This receipt is the SOLE task receipt for PR #231. It was updated in place, before the PR's merge, to fold in the
> pre-merge correctness fixes below — this PR has not yet merged, so this remains a single, not-yet-final receipt for
> a single still-open task; `edit_policy: append-by-new-file` governs receipts that already exist on `main`, not a
> receipt this same open PR itself introduced. A task Pull Request may add at most one final Obsidian task receipt.

## Owner decision implemented

`PRE_L7_RELEASE_INSTALL_GOVERNANCE = SEPARATE_G15_STAGE`, `CANONICAL_STAGE_ID = L6c`, `CANONICAL_STAGE_NAME = Immutable Release Install`, `AUTHORIZATION = A-L6c`, `K3 = FRESH_STAGE_L6c`. A-L7 is never created, consumed, or reused by L6c, and vice versa — proven structurally via `p4-stage-gate.sh`'s `stage=` field match, not invented.

## Authority audit (before this change)

No `L6c` existed anywhere (scripts, docs, tests, owner-run tooling). `P4_STAGES` went `... L6a L6b L7 ...`. The gap was already recorded: the L7 design (§7/§8, 2026-09-27) and PR #208's own receipt both named "an owner decision on the release installer" / "the release/venv installer" as open. No name collision with `L6c`.

## What changed

1. **G-15 observability gap closed first, then hardened in pre-merge review.** `p4-l0-capture.sh` was blind to `/opt/aegis-idea3/releases/<id>` — RED proof: 18 failed (`tests/test_pr11_phase4_l6c_capture_gap.py`, against the unmodified capture/compare). The first implementation added two fixed `host.path.*` presence keys and a `host.aegis_idea3.release_catalog` fingerprint key computed as `<id>:sha256(that release's own RELEASE-SHA256SUMS)`. Independent pre-merge review found this proved only that the sums file's own bytes were unchanged — not the actual payload or metadata. Final contract: new read-only `p4-l6c-tree-digest.py` computes ONE sha256 per release over every entry's ACTUAL current relative path, type, uid, gid, permission bits, and (for regular files) real byte content, in deterministic order, never following a symlink (its target string is hashed instead) and never reading a special file's content. Regular files are opened with `O_NOFOLLOW`; the opened descriptor's inode/metadata must match the preceding `lstat` and stay stable through the read, and the whole tree is rescanned after hashing — any observed identity/metadata race, or any unreadable entry, makes the digest `UNREADABLE` (fail-closed), never silently omitted. This is deliberately not claimed as an atomic filesystem snapshot: a sufficiently privileged ABA mutation that changes and fully restores an entry entirely between checks cannot be excluded without real snapshot support, so the live contract also requires these root-owned immutable release trees to be quiescent while captured. `host.tsv` still records only `<id>:<digest>` — never file contents, never an individual path. A new opt-in `ALLOW_L6C_RELEASE_FILE` (mirroring `ALLOW_TRANSITIONS_FILE`/`ALLOW_DYNAMIC_TRANSITIONS_FILE`) names the ONE exact new release id a run may add; the relational rule in `p4-compare.sh` unconditionally requires every release id present in BEFORE to remain identical in AFTER, or the change is `RELEASE_CONTENT_DRIFT`/`RELEASE_REMOVED` — never a silently approved key-level pass.
2. **L6c registered:** `P4_STAGES` now `... L6a L6b L6c L7 ...`; `p4_stage_gaps L6c = none` (derived, not copied from L7's G-11/G-12, since L6c never provisions a key or credential); `p4_stage_auth_extra L6c` has no extra field (no `d6_notice`).
3. **Handler:** `stages/L6c/apply.sh|verify.sh|rollback.sh` + `allow-keys.txt` (exactly the two new `host.path` keys) + `allow-listeners.txt` (empty). Calls the already-merged `p4-l7-install-release.py`/`p4-l7-release-guard.py` without duplicating their predicates; journals the exact mutation boundary before the one installer call; never touches `current`, a pre-existing release, credentials, `core.env`, systemd, the Core service, the L6b broker, IDEA2, ESP32 or L8. **Rollback's live ownership contract, corrected in pre-merge review:** `rollback.sh` originally hard-coded `--expect-owner any` when re-proving the target via the real release guard, even live, where the installed-release contract is root-owned — weaker than `verify.sh`. Fixed: rollback now derives `owner_expect` the identical way `verify.sh` does (`any` under a fixture root, `root` by live default — the exact same two lines, verified byte-identical between the two files by a dedicated parity test), so a live rollback can never be tricked into deleting a tree whose ownership drifted away from root; ownership/metadata drift is refused rather than deleted.
4. **Owner runner, and its PRE-capture/consume ordering corrected in pre-merge review:** `p4-l6c-run-lib.sh` + `owner-run/run-l6c-owner.sh` (unpinned: main SHA, release id, expected source SHA; one attempt per `A-L6c`, `L6C-ATTEMPT-CONSUMED`). The original ordering consumed the one-shot authorization BEFORE PRE evidence capture, so a failed PRE capture (or a failed SHA256 validation of it) still burned the attempt. Final, corrected ordering: ALL read-only gates — receipts through L6b, persistent L6b broker health, release-source guard + on-main proof, target-absent, disk ≥ 20% free on `/` and `/opt`, IDEA2 §10 precondition, valid fresh A-L6c/K3, baseline service/listener snapshots, evidence-directory creation, the release allow file (deterministic local setup) — complete first; PRE capture and its SHA256 validation run next; `l6c_consume_attempt` runs only once PRE capture has fully passed, immediately followed by apply once. A failed PRE capture now dies with an explicit message naming that the authorization was NOT consumed and evidence is preserved; the attempt marker stays absent; no automatic retry. After apply: verify → POST capture → strict PRE→POST with the exact L6c allow files → secret scan → S10 preservation → persistent closeout; any failure after the first mutation → exactly one bounded rollback → RB capture → zero-drift PRE→RB (no allow files) → exit 3 (S-11 HOLD) if rollback or that proof fails. Never invokes L7 apply, creates A-L7, uses L7 input, creates a credential/`core.env`, touches `current`, installs/starts/enables the Core unit, touches ESP32, sends a command, repairs L6b, or restarts Twingate/modifies IDEA1/IDEA2.
5. **L7 relationship:** `L6C_RELEASE_INSTALL = PROVEN` is documented as a prerequisite FACT, not an authorization; L7's own `l7_release_gate` still independently re-runs the release guard read-only. A fresh `A-L7`/K3 remain required and are never combined with L6c's records.
6. **Installer parent-directory contract, corrected in pre-merge review.** `p4-l7-install-release.py` originally `mkdir(parents=True, exist_ok=True)` + unconditionally `chmod`'d `/opt/aegis-idea3` and `/opt/aegis-idea3/releases`, even when either already existed before this attempt — violating the rule that a parent directory is stage-owned only when this attempt itself had to create it. Fixed: `_ensure_parent_dirs()` walks the full ancestor chain from `releases_dir` up to `host_root`, then validates EVERY existing ancestor in that chain (not merely the first one found) before creating any missing one — a real directory, never a symlink, never group/other-writable (refusal codes `PARENT_DIR_NOT_A_DIRECTORY` / `PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER` / `DESTINATION_PARENT_OUTSIDE_HOST_ROOT`) — and leaves it byte/metadata-identical (uid/gid/mode preserved; a legitimate child addition may naturally advance an ancestor's mtime, which is not a repair). Each missing ancestor gets the exact reviewed mode `0o755`. No generic "repair" path exists.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — `P4_STAGES`, `p4_stage_gaps L6c`; python3 read-only allowlist extended for the tree-digest helper.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh`, `p4-l6c-tree-digest.py` — actual tree-state release-catalog capture (new helper).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — `ALLOW_L6C_RELEASE_FILE` + relational rule.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6c/apply.sh|verify.sh|rollback.sh|allow-keys.txt|allow-listeners.txt` — new handler; `rollback.sh` owner-check contract corrected to match `verify.sh`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l6c-run-lib.sh`, `owner-run/run-l6c-owner.sh` — new owner runner; PRE-capture/consume ordering corrected.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-install-release.py` — `_ensure_parent_dirs()` validates every existing ancestor, creates only missing ones, never repairs.
- `IDEA3-AEGIS_Lockdown/tests/l6c_support.py`, `test_pr11_phase4_l6c_capture_gap.py`, `test_pr11_phase4_l6c_handler.py`, `test_pr11_phase4_l6c_runner.py`, `test_pr11_phase4_l6c_runner_flow.py`, `test_pr11_phase4_l7_release_installer_helper.py` — tests (the last two authored during pre-merge review).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — L6c added to the ordered stage-registry fixtures.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md` — design, including a section documenting the four pre-merge fixes.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` — cross-reference note (§8 amendment area); no historical text rewritten.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — L6c section, updated for the pre-merge fixes.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new dated section (this receipt), updated in place with the fix bullet; historical sections unedited.

## Verification evidence

- `pytest` RED-first (G-15 capture gap, before implementation) — fail: 18 failed, 4 passed.
- Focused L6c (final, post pre-merge fixes): **242 passed** — `test_pr11_phase4_l6c_capture_gap.py` 33 passed; `test_pr11_phase4_l6c_handler.py` 63 passed; `test_pr11_phase4_l6c_runner.py` 33 passed; `test_pr11_phase4_l6c_runner_flow.py` 22 passed; `test_pr11_phase4_l7_release_installer_helper.py` 49 passed; `test_pr11_phase4_l7_release_guard_helper.py` 42 passed.
- L7 regression (no regression from the L6c fixes): **333 passed** — `test_pr11_phase4_l7_handler.py` 198, `test_pr11_phase4_l7_runner.py` 104, `test_pr11_phase4_l7_runner_flow.py` 31.
- `pytest tests/test_pr11_phase4_harness.py` — pass: 222 passed.
- `pytest tests -k phase4` — pass: 2500 passed, 2 skipped, 1108 deselected; 0 failed, 0 errors.
- `pytest tests` (full IDEA3 suite) — pass: 3602 passed, 8 skipped; 0 failed, 0 errors.
- `bash -n` (every changed shell script) — pass. `py_compile` (every changed/new Python file) — pass. `git diff --check` — pass (no whitespace errors).
- `node scripts/validate-vault.mjs` — pass, 2 pre-existing canvas warnings only.
- Full-diff secret scan — 0 real secrets.
- See the PR body for the collaboration-policy validation result against the full PR diff.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L6c governed-stage section.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None. PR #202 remains closed, unmerged, untouched.

## Known limitations

- No release is installed on the real host; the release-install workflow itself was proven only in fixtures.
- Live-only, unproven offline: the real installer's `os.rename` on the live filesystem, real root ownership, and the real owner-run pre-gate sequence end to end.
- The owner-change / chmod-owner scenario in the tree-state digest fix is proven by a direct unit test on the metadata-serialization helper rather than a real `chown`, since this unprivileged test process cannot exercise a real ownership change; the digest's sensitivity to `st_uid` is otherwise identical to its proven sensitivity to mode, which IS proven with a real `chmod`.
- The tree-state digest detects and fails closed on an observed mutation race (proven by a TOCTOU symlink-swap test), but it is not an atomic filesystem snapshot: a sufficiently privileged ABA mutation that changes and fully restores an entry entirely between checks cannot be excluded without real filesystem snapshot support. The live contract therefore also requires these root-owned immutable release trees to be quiescent while captured.
