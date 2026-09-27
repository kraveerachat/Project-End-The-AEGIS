---
title: Task Receipt — IDEA3 PR11 Phase 4 L6c "Immutable Release Install" — pre-merge correctness fixes
date: 2026-09-27T19:35:34+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l6c-release-install-governance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L6c — pre-merge correctness fixes (addendum to PR #231)

> [!important] Repository-only fix, same open PR, not yet merged
> Four correctness issues found in independent review of PR #231 (`feat(idea3): add governed L6c immutable release
> install stage`) were fixed on the SAME branch/PR before merge. **PR #231 was NOT merged, was NOT auto-merged, and
> remains open.** No Production mutation, no sudo against the real host, no live L6c/L7 run, no A-L6c/K3/A-L7/D6 or
> Production secret created, no ESP32/L8 touched, no restart of Twingate, no edit to IDEA1/IDEA2, no new PR opened, and
> no already-merged historical receipt was rewritten (this is a new file, per `edit_policy: append-by-new-file`,
> addending the still-open PR #231's own not-yet-merged receipt at
> `90-Status/logs/2026-09-27_181656_music_idea3-pr11-l6c-release-install-governance.md`, which itself was left
> byte-for-byte unmodified, since that receipt's own `edit_policy: append-by-new-file` forbids editing it in place
> regardless of PR merge state).
> `L6C_LIVE_EXECUTED = NO`, `A_L6C_CREATED = NO`, `L7_LIVE_EXECUTED = NO`, `A_L7_CREATED = NO`, `L8_STARTED = NO`,
> `PR231_MERGED = NO`.

## Old head → new head

- Old PR #231 head: `e8e7e2a455ef8c0f83c1ffeb4e7926e3d56706b4`.
- Base main (unchanged): `0c538552997c1be5d52df716a07a5a204ba9cd39`.
- New head: recorded in the PR body / `git log -1` at push time (see PR #231 itself for the exact SHA after this push).

## What changed

**1. PRE-capture/consume ordering.** Before: `owner-run/run-l6c-owner.sh` ran pre-gates → `l6c_consume_attempt` →
create evidence dir → PRE capture → apply, so a failed PRE capture (or a failed SHA256 validation of it) still burned
the one-shot `A-L6c` authorization. After: ALL read-only gates — baseline snapshots, evidence-directory creation, the
release allow file (deterministic local setup), PRE capture, and its SHA256 validation — complete first;
`l6c_consume_attempt` runs only once PRE capture has fully passed, immediately followed by apply, with no further
fallible external read-only gate in between. A failed PRE capture now dies with an explicit message naming that the
authorization was NOT consumed and evidence is preserved. Proof: new `tests/test_pr11_phase4_l6c_runner_flow.py` (22
tests — ordering, failed-PRE-leaves-marker-absent for both a capture failure and a SHA256-validation failure,
successful-PRE-then-consume-creates-marker-before-apply (both by call-order and by static text-index), the fake apply
handler itself refuses to run before the marker exists, apply-cannot-precede-the-marker, the release allow file is
proven prepared before PRE and never rewritten between consume and apply, a second attempt after success still fails
closed, no automatic retry, rollback-exactly-once-after-the-first-mutation, a failed rollback holds and never
retries) plus corrected ordering assertions in `tests/test_pr11_phase4_l6c_runner.py`.

**2. Installer mutating a pre-existing parent directory.** Before: `p4-l7-install-release.py` unconditionally
`mkdir(parents=True, exist_ok=True)` + `chmod`'d `/opt/aegis-idea3` and `/opt/aegis-idea3/releases`, even when either
already existed before this attempt — a parent directory is only stage-owned when this attempt itself had to create
it (`L6C_MUTATION_BOUNDARY`). After: a new `_ensure_parent_dirs()` walks the full ancestor chain from `releases_dir`
up to `host_root` first, then validates EVERY existing ancestor in that chain (not merely the first one found) before
creating any missing one — a real directory, never a symlink, never group/other-writable (new refusal codes
`PARENT_DIR_NOT_A_DIRECTORY` / `PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER` / `DESTINATION_PARENT_OUTSIDE_HOST_ROOT`) — and
left byte/metadata-identical (uid/gid/mode preserved; a legitimate child addition may naturally advance an ancestor's
mtime, which is not a repair). Each missing ancestor gets the exact reviewed `PARENT_DIR_MODE = 0o755`. No generic
"repair" path exists. Proof: 10 new tests in `tests/test_pr11_phase4_l7_release_installer_helper.py` (pre-existing
releases/opt dirs with unusual-but-acceptable modes survive with uid/gid/mode unchanged; group/other-writable
ancestors refuse before any mutation and are left untouched, including an unsafe `opt` that sits ABOVE an already-safe
`releases`; a non-directory ancestor refuses; a symlinked `opt` refuses even when what it resolves to is a real,
untouched directory; newly-created ancestors get the exact mode even when both levels are missing; no
`os.chmod(releases_dir`/`os.chown`/`shutil.chown` appears in the source) — 49 passed total (was 39).

**3. Release-catalog fingerprint blind to real drift.** Before: `host.aegis_idea3.release_catalog` recorded
`<id>:sha256(RELEASE-SHA256SUMS)` — proof only that the sums file's own bytes were unchanged, not the actual payload
or metadata. It could not detect a payload edit, a chmod/chown, a directory-mode change, or a symlink/special file
planted in the tree, as long as `RELEASE-SHA256SUMS` itself was left alone. After: new, read-only
`p4-l6c-tree-digest.py` computes ONE sha256 per release over every entry's relative path, type, uid, gid, permission
bits, and (for regular files) the real file's SHA256, in deterministic path order, never following a symlink (its
target string is hashed instead) and never reading a special file's content. Regular files are opened with
`O_NOFOLLOW`; the opened file descriptor's inode/metadata must match the preceding `lstat` and remain stable through
the read, and the entire tree is rescanned after hashing to detect an entry that changed identity or metadata during
the scan — any such race, or any unreadable entry, makes the digest `UNREADABLE` (fail-closed). This is deliberately
not claimed as an atomic filesystem snapshot: a sufficiently privileged ABA mutation that changes and fully restores
an entry entirely between checks cannot be excluded without real snapshot support, so the live contract also requires
these root-owned immutable release trees to be quiescent while captured — documented explicitly in the helper's own
docstring, the design doc, and the README rather than left as a silent gap. `p4-l0-capture.sh` calls it once per
release id through the same exact-argv `python3` allowlist pattern already used for the L5 clock helper. `host.tsv`
still records only `<id>:<digest>`; the comparator rule in `p4-compare.sh` is unchanged conceptually. Proof, in every
case WITHOUT touching `RELEASE-SHA256SUMS`: real end-to-end capture+compare tests for a payload byte edit, a file
chmod, a directory-mode change, an added file, a removed file, a planted symlink, and a planted fifo are all caught as
`RELEASE_CONTENT_DRIFT`; an unchanged existing release plus one newly-named release still passes; PRE→RB exact
restoration still passes with zero allowances; a direct unit test on the metadata-serialization helper proves it is
owner-sensitive without needing real chown privileges; a monkeypatched TOCTOU test proves a payload file that is
deleted and replaced by a symlink to an outside path between the initial scan and the hashing pass is caught as
`Unreadable` rather than silently followed. `tests/test_pr11_phase4_l6c_capture_gap.py`: 33 passed (was 22).

**4. Live rollback's weakened owner check.** Before: `stages/L6c/rollback.sh` called the release guard with a
hard-coded `--expect-owner any`, even live, where the installed-release contract is root-owned — weaker than
`verify.sh`. After: rollback derives `owner_expect` the identical way `verify.sh` does (`any` under a fixture root,
`root` by live default — the exact same two lines, verified byte-identical between the two files by a dedicated
parity test), so a live rollback can never be tricked into deleting a tree whose ownership drifted away from root.
Proof: new tests in `tests/test_pr11_phase4_l6c_handler.py` (owner check never hard-coded to `any`; rollback's
derivation matches verify's exactly; fixture rollback still works and still removes only the stage-created release;
metadata drift is refused rather than deleted) — 63 passed total (was 54).

## Source files changed

- `deploy/pr11-phase4/owner-run/run-l6c-owner.sh` — PRE-capture/consume ordering; release allow file moved to
  deterministic pre-PRE setup.
- `deploy/pr11-phase4/p4-l7-install-release.py` — `_ensure_parent_dirs()` validates the full ancestor chain,
  `PARENT_DIR_MODE`, three refusal codes (`PARENT_DIR_NOT_A_DIRECTORY`, `PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER`,
  `DESTINATION_PARENT_OUTSIDE_HOST_ROOT`).
- `deploy/pr11-phase4/p4-l6c-tree-digest.py` — new, read-only tree-state digest helper, with `O_NOFOLLOW` +
  inode/metadata-stability checks and a post-hash rescan to fail closed on an observed race.
- `deploy/pr11-phase4/p4-l0-capture.sh` — release-catalog capture now calls the tree-digest helper.
- `deploy/pr11-phase4/p4-lib.sh` — `p4_ro_allowed` python3 allowlist extended for the new helper.
- `deploy/pr11-phase4/stages/L6c/rollback.sh` — owner-check contract matches `verify.sh`.
- `tests/test_pr11_phase4_l6c_runner_flow.py` — new (22 tests).
- `tests/test_pr11_phase4_l6c_runner.py`, `tests/test_pr11_phase4_l7_release_installer_helper.py`,
  `tests/test_pr11_phase4_l6c_capture_gap.py`, `tests/test_pr11_phase4_l6c_handler.py` — extended.
- `docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md` — new §10 documenting all
  four fixes; `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new bullet in the existing L6c section;
  `deploy/pr11-phase4/README.md` — L6c section updated.

## Verification evidence

- `pytest tests/test_pr11_phase4_l6c_capture_gap.py` — passed: 33 passed (was 22).
- `pytest tests/test_pr11_phase4_l6c_handler.py` — passed: 63 passed (was 54).
- `pytest tests/test_pr11_phase4_l6c_runner.py tests/test_pr11_phase4_l6c_runner_flow.py tests/test_pr11_phase4_l7_release_guard_helper.py` — passed: 97 passed.
- `pytest tests/test_pr11_phase4_l7_release_installer_helper.py` — passed: 49 passed (was 39).
- `pytest tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_runner_flow.py` — passed: 333 passed (no regression from these fixes).
- `pytest tests -k phase4` — passed: 2500 passed, 2 skipped, 1108 deselected.
- `pytest tests` (full IDEA3 suite) — passed: 3602 passed, 8 skipped.
- `bash -n` on every changed shell script — passed. `py_compile` on every changed/new Python file — passed. `git diff --check` — passed (no whitespace errors). Full-diff secret-pattern scan (private-key markers, `password=`/`token=`/`secret=`/PIN/PSK patterns) — passed: no match.
- `node scripts/validate-vault.mjs` — passed, 2 pre-existing canvas warnings only.
- `node scripts/validate-collaboration-policy.mjs` on the updated PR body/diff — passed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new bullet under the existing L6c section (no
  historical section rewritten).

## Shared surfaces touched

- None — the fix stayed inside IDEA3, on the same already-open PR #231.

## Integration requests

- None. PR #202 remains closed, unmerged, untouched. No cross-IDEA request made by this fix round.

## Known limitations

- The original receipt's "Known limitations" flagged exactly two gaps closed by this fix round: no full end-to-end
  runner-flow simulation for L6c (now `test_pr11_phase4_l6c_runner_flow.py`, 22 tests), and the ordering risk that
  became Issue 1 above.
- The owner-change / chmod-owner scenario in the tree-state digest fix (Issue 3) is proven by a direct unit test on
  the metadata-serialization helper rather than a real `chown`, since this unprivileged test process cannot exercise
  a real ownership change; the digest algorithm's sensitivity to `st_uid` is otherwise identical to its sensitivity to
  mode, which IS proven with a real `chmod`.
- The tree-state digest detects and fails closed on an observed mutation race, but it is not an atomic filesystem
  snapshot: a sufficiently privileged ABA mutation that changes and fully restores an entry entirely between checks
  cannot be excluded without real filesystem snapshot support. The live contract therefore also requires these
  root-owned immutable release trees to be quiescent while captured.
