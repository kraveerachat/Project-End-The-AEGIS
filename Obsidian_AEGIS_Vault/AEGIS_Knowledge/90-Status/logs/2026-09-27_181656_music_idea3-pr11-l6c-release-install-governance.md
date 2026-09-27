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

1. **G-15 observability gap closed first.** `p4-l0-capture.sh` was blind to `/opt/aegis-idea3/releases/<id>` — RED proof: 18 failed (`tests/test_pr11_phase4_l6c_capture_gap.py`, against the unmodified capture/compare). Fixed: two new fixed `host.path.*` presence keys, one new deterministic non-secret `host.aegis_idea3.release_catalog` fingerprint key (`<id>:<sha256 of that release's own RELEASE-SHA256SUMS>`), and a new opt-in `ALLOW_L6C_RELEASE_FILE` relational rule in `p4-compare.sh` that approves ONLY the addition of the one named new release id and unconditionally fails a mutation or removal of any existing release. GREEN: 22 passed.
2. **L6c registered:** `P4_STAGES` now `... L6a L6b L6c L7 ...`; `p4_stage_gaps L6c = none` (derived, not copied from L7's G-11/G-12, since L6c never provisions a key or credential); `p4_stage_auth_extra L6c` has no extra field (no `d6_notice`).
3. **Handler:** `stages/L6c/apply.sh|verify.sh|rollback.sh` + `allow-keys.txt` (exactly the two new `host.path` keys) + `allow-listeners.txt` (empty). Calls the already-merged `p4-l7-install-release.py`/`p4-l7-release-guard.py` without duplicating their predicates; journals the exact mutation boundary before the one installer call; never touches `current`, a pre-existing release, credentials, `core.env`, systemd, the Core service, the L6b broker, IDEA2, ESP32 or L8.
4. **Owner runner:** `p4-l6c-run-lib.sh` + `owner-run/run-l6c-owner.sh` (unpinned: main SHA, release id, expected source SHA; one attempt per `A-L6c`, `L6C-ATTEMPT-CONSUMED`; every gate before consumption; bounded rollback with zero-drift PRE→RB; exit 3 S-11 HOLD on a failed rollback proof; no retry).
5. **L7 relationship:** `L6C_RELEASE_INSTALL = PROVEN` is documented as a prerequisite FACT, not an authorization; L7's own `l7_release_gate` still independently re-runs the release guard read-only. A fresh `A-L7`/K3 remain required and are never combined with L6c's records.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — `P4_STAGES`, `p4_stage_gaps L6c`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — release-catalog capture fix.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — `ALLOW_L6C_RELEASE_FILE` + relational rule.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6c/apply.sh|verify.sh|rollback.sh|allow-keys.txt|allow-listeners.txt` — new handler.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l6c-run-lib.sh`, `owner-run/run-l6c-owner.sh` — new owner runner.
- `IDEA3-AEGIS_Lockdown/tests/l6c_support.py`, `test_pr11_phase4_l6c_capture_gap.py`, `test_pr11_phase4_l6c_handler.py`, `test_pr11_phase4_l6c_runner.py` — new tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — L6c added to the ordered stage-registry fixtures.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md` — new design.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` — cross-reference note (§8 amendment area); no historical text rewritten.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — new L6c section.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new dated section (this receipt); historical sections unedited.

## Verification evidence

- `pytest` RED-first (G-15 capture gap, before implementation) — fail: 18 failed, 4 passed.
- `pytest tests/test_pr11_phase4_l6c_capture_gap.py` — pass: 22 passed.
- `pytest tests/test_pr11_phase4_l6c_handler.py tests/test_pr11_phase4_l6c_runner.py` — pass: 92 passed (handler tests were authored after an already-written handler; the first run showed 39 failures, all traced to test-fixture defaults and test-authoring mistakes, not handler defects, and fixed before this count).
- `pytest tests/test_pr11_phase4_harness.py` — pass: 222 passed.
- See the PR body for the Phase 4 bundle and full IDEA3 suite counts, `git diff --check`, vault validation, collaboration-policy validation, and the full-diff secret scan.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L6c governed-stage section.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None. PR #202 remains closed, unmerged, untouched.

## Known limitations

- The L6c owner-runner test coverage is gate-library and static-contract level; unlike L7's dedicated sandboxed control-flow simulation (`test_pr11_phase4_l7_runner_flow.py`), no equivalent full end-to-end runner simulation was written for L6c in this task, due to time constraints. The gate ordering, one-attempt marker, and rollback-flow structure are proven statically and via the gate-library unit tests instead.
- Live-only, unproven offline: the real installer's `os.rename` on the live filesystem, real root ownership, and the real owner-run pre-gate sequence end to end.
