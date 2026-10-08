---
title: Task Receipt — IDEA3 CTv CLOSED_FAIL successor attestation (read-only, source only)
date: 2026-10-08T12:16:22+07:00
owner: music
area: idea3
branch: feat/idea3-ctv-fail-successor-attestation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTv CLOSED_FAIL successor attestation (read-only, source only)

## What changed

- Added stage `CTv-fail-successor-attestation`: `ctv-fail-successor-attest.sh`, a READ-ONLY attestation of the current CTv CLOSED_FAIL state (authority main `b858bd128c2f464b33dc608c902fb1bf88513e82`, then merged with main `6ed423457e3b886b9cecdfc25b9a0eca7a2c2671`). It writes nothing, consumes no attempt marker, restarts nothing, sends no device command, and prints facts to stdout only.
- It reuses the reviewed Option B guard and read-only verifier (not copied) and the unmodified reviewed R1B/R1Bv predecessor gate. Every executed file is hash-checked against the exact-main git blob and must be root-trusted with a trusted ancestor chain; test seams are refused unless the Option B test environment and a safe test root are present.
- Proves: (A) the CTv attempt marker and EXACTLY one FAIL closeout, whose recomputed SHA-256 equals the pinned `86abd122f8f79226672626d5bf34b01bebecdd5fb0e8dcc6bfcf80c02f28aee9`, with a valid sidecar, strict 34-field schema and fixed values, no PASS or stray CTv entry; (B) current unit digest, effective security settings, drop-ins, Core runtime, device id, detector state and TrustedClock through the Option B verifier; (C) PRE, POST and compare digests equal those the closeout recorded and the historical S10 result is still a positively evidenced FAIL.
- Reports Recovery prerequisites separately as PASS, BLOCKED or UNKNOWN: Recovery attempt unconsumed, R1I containment rule, R1B incident authority; the pinned release and restore-CLI identity are reported UNKNOWN (no trusted pin input exists in the repository).
- **B1 remediation (independent review of HEAD 68569bc8):** the verdict is now `ATTESTATION=PASS` (exit 0) only when sections A-C pass AND R1I, R1B and the release/CLI proof are all PASS; otherwise it is `PARTIAL` with exit 3 (A-C failures stay `FAIL`, exit 1/2). Because the pinned release/CLI proof is UNKNOWN, the verdict is PARTIAL today. The output carries `CTV_FAIL_SUCCESSOR_MODE=PRODUCTION|HERMETIC_TEST`, `BINDING_SHA256` (stable history only; documented as not a fresh runtime attestation and not an authorization) and a separate `READINESS_SHA256` over the binding, mode, current runtime-state digest and the R1I / R1B / release-CLI statuses and reasons (an integrity binding of the reported facts only: not freshness, not a credential, not permission). `RECOVERY_AUTHORIZED=NO` is unchanged and the script is still not wired into Recovery.
- Narrow minor fixes from the same review: M1 link count 1 required on the marker, closeout and sidecar; M2 the closeout is hashed and parsed from one read; M3 the guard is sourced from the bytes that were hashed; M4 root-trust check of the production interpreter and `nft`; M5 the R1B prerequisite is labelled as committed receipts at the pinned main, not a live-incident proof; M6 tests for the three surviving mutants.
- Emits `CTV_FAIL_SUCCESSOR_BINDING_SHA256` over stable facts as a foundation for a later, separately reviewed third predecessor authority. It does not promote CTv to PASS, does not repair the historical S10 FAIL, does not claim PRE-to-POST preservation, and states `CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED=NO` and `CTV_FAIL_SUCCESSOR_WIRED_INTO_RECOVERY=NO`.
- No existing gate, runner, freeze, script, marker, closeout or evidence was edited.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-fail-successor-attest.sh` — the read-only attestation.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_fail_successor_attestation.py` — 100 hermetic tests (22 added for B1 and M1-M6).

## Verification evidence

- `pytest tests/test_ctv_fail_successor_attestation.py` — pass: 100 passed (valid history, tampered closeout, invalid sidecar, missing marker, contradictory PASS and FAIL, schema, wrong values, non-ancestor main, symlink and permission violations, wrong unit digest, wrong detector, missing TrustedClock, modified evidence, S10 rewrite, Recovery already consumed, R1I and R1B BLOCKED, release/CLI UNKNOWN, production seam rejection, environment and BASH_ENV injection, exact-main file tamper, zero side effects with a tree snapshot, forbidden-verb scan, closure recomputation, and mutation tests that disable six guards one at a time).
- Full re-run after the fix and the merge of main 6ed42345 (attestation, Option B, CTv successor, CTu blockers and L0 closure, Recovery stage, `tests/recovery`, Phase 4 harness, RRu, R1Bv) — 1508 passed, 3 failed: `test_only_reviewed_stage_handlers_are_registered`, `test_r1bv_is_registered_exactly_once_right_after_r1b_and_is_non_mutating` and `test_the_recovery_stage_reuses_the_r1bv_predecessor_gate_without_bypassing_r1bv_or_rru` (stale stage-order expectations, CTv registered after CTu). All 3 fail identically on a tree containing only main; unrelated. One earlier full run also showed a single failure of `test_historical_s10_fail_must_be_positively_evidenced[-HISTORICAL_COMPARE_NOT_A_REPORT]` (an Option B test this PR does not touch) that did not recur in six reruns, including the same full command; not reproduced, cause unknown.
- `bash -n` on the script — pass. `git diff --check` — pass.

## Canonical notes updated

- `None` — no durable project fact changed; the attestation is source only.

## Shared surfaces touched

- `None` — IDEA3-owned paths only

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- NOT EXECUTED on Production: the live proof needs root access to the canonical directory, the CTv work directory, systemd and nft, which this session does not have. All results above are from hermetic fixtures with stub `systemctl`, `pgrep` and `nft`. The owner-supplied closeout digest is used only as a pin that the host file must recompute to.
- The strict closeout schema is the 34-field body written by the reviewed Option B disposition action; if the executed record differs, the attestation fails closed.
- The release/CLI proof is UNKNOWN by construction (no trusted pin exists in the repository), so the verdict is PARTIAL (exit 3) on every real run until a separately reviewed change supplies one; the PASS path is exercised only by a hermetic test that forces a hypothetical trusted pin. M2/M6a: an A→B→A swap that restores identical bytes before the final recheck cannot be detected and is covered only by the pinned digest and exact-namespace gates.
- Not wired into Recovery and not an authority: a third predecessor gate would need separate review, its own runner and explicit Human Owner authorization. Recovery R2-R8, LVR, L8, L9 and hardware stages were not started.
- Pinned release and restore-CLI identity cannot be proven from repository sources and is reported UNKNOWN.
