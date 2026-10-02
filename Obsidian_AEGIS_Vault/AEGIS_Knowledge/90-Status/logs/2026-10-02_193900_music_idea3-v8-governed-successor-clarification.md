---
title: Task Receipt — IDEA3 V8 governed-successor spec clarification (docs only)
date: 2026-10-02T19:39:00+07:00
owner: music
area: idea3
branch: docs/idea3-l34-v8-governed-successor-clarification
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 V8 governed-successor spec clarification (docs only)

## What changed

- Spec/governance clarification only. The V8 design spec now defines (new §5.1) that a failed/consumed V8 attempt is never retryable (`V8_RETRY_ALLOWED=NO`), and that after the root cause is merged, the host is restored to an accepted baseline, a new exact-main runner freeze and a new root preflight exist, a fresh same-day `stage=L4` authorization and K3 are created, and a brand-new `AUTH_DIR` carries an unconsumed `L34-V8-REACTIVATION-ATTEMPT-CONSUMED` marker, the owner MAY authorize a governed successor attempt under the same canonical stage `l34-v8-post-v7-persistent-ap-recovery`. It is not a retry; the prior AUTH_DIR, authorization, K3, marker, frozen runner and mutable evidence directory are never reused.
- The ambiguous sentence in the §3 amendment ("a new stage needs a fresh runner freeze…") now points at §5.1.
- `idea3-status.md` gains a short section with `GOVERNED_SUCCESSOR_ALLOWED=YES`, `CANONICAL_STAGE_ID_REUSED=YES`, `REQUIRES_NEW_AUTH_DIR/FREEZE/PREFLIGHT=YES`, `REQUIRES_FRESH_SAME_DAY_AUTH_K3=YES`, while still stating the original attempt is FAILED/CONSUMED, its Auth/K3 NOT_REUSABLE and `V8_RETRY_ALLOWED=NO`.
- No runtime, runner, handler, marker, classifier or NetworkManager change. No Production or host mutation, no Auth/K3, no runner freeze, no preflight, no V8 attempt. The successor attempt is NOT RUN.

## Source files changed

- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l34-v8-post-v7-persistent-ap-recovery-design.md` — §3 wording pointer and new §5.1 governed successor attempt.

## Verification evidence

- `git diff --cached --check` — pass: no whitespace errors.
- `git diff --cached --name-only | grep -vE '\.md$'` — pass: no output (zero runtime/source files changed; three Markdown paths only).
- `git diff --cached --name-status | grep -E '^[MD].*90-Status/logs'` — pass: no output (no historical receipt modified or deleted).
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass: 0 errors (2 existing canvas warnings).
- `node scripts/validate-collaboration-policy.mjs --event <PR event> --changed-files <list>` — pass: see PR description.
- `/usr/bin/python3 -m pytest -q tests/test_pr11_phase4_l34_v8_scope_contract.py` (from `IDEA3-AEGIS_Lockdown/`) — pass: 59 passed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the governed-successor clarification section; prior V8 FAILED/CONSUMED statements unchanged.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Documentation only; nothing enforces §5.1 in code beyond the existing per-`AUTH_DIR` marker. The owner remains responsible for the seven conditions.
- Existing frozen runners pinned to older mains (for example `98c3e774`) become stale when this PR merges and must be re-frozen.
