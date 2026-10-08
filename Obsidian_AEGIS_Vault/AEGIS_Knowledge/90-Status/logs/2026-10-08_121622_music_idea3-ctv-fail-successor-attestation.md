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

- Added stage `CTv-fail-successor-attestation`: `ctv-fail-successor-attest.sh`, a READ-ONLY attestation of the current CTv CLOSED_FAIL state (authority main `b858bd128c2f464b33dc608c902fb1bf88513e82`). It writes nothing, consumes no attempt marker, restarts nothing, sends no device command, and prints facts to stdout only.
- It reuses the reviewed Option B guard and read-only verifier (not copied) and the unmodified reviewed R1B/R1Bv predecessor gate. Every executed file is hash-checked against the exact-main git blob and must be root-trusted with a trusted ancestor chain; test seams are refused unless the Option B test environment and a safe test root are present.
- Proves: (A) the CTv attempt marker and EXACTLY one FAIL closeout, whose recomputed SHA-256 equals the pinned `86abd122f8f79226672626d5bf34b01bebecdd5fb0e8dcc6bfcf80c02f28aee9`, with a valid sidecar, strict 34-field schema and fixed values, no PASS or stray CTv entry; (B) current unit digest, effective security settings, drop-ins, Core runtime, device id, detector state and TrustedClock through the Option B verifier; (C) PRE, POST and compare digests equal those the closeout recorded and the historical S10 result is still a positively evidenced FAIL.
- Reports Recovery prerequisites separately as PASS, BLOCKED or UNKNOWN: Recovery attempt unconsumed, R1I containment rule, R1B incident authority; the pinned release and restore-CLI identity are reported UNKNOWN (no trusted pin input exists in the repository).
- Emits `CTV_FAIL_SUCCESSOR_BINDING_SHA256` over stable facts as a foundation for a later, separately reviewed third predecessor authority. It does not promote CTv to PASS, does not repair the historical S10 FAIL, does not claim PRE-to-POST preservation, and states `CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED=NO` and `CTV_FAIL_SUCCESSOR_WIRED_INTO_RECOVERY=NO`.
- No existing gate, runner, freeze, script, marker, closeout or evidence was edited.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-fail-successor-attest.sh` — the read-only attestation.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_fail_successor_attestation.py` — 78 hermetic tests.

## Verification evidence

- `pytest tests/test_ctv_fail_successor_attestation.py` — pass: 78 passed (valid history, tampered closeout, invalid sidecar, missing marker, contradictory PASS and FAIL, schema, wrong values, non-ancestor main, symlink and permission violations, wrong unit digest, wrong detector, missing TrustedClock, modified evidence, S10 rewrite, Recovery already consumed, R1I and R1B BLOCKED, release/CLI UNKNOWN, production seam rejection, environment and BASH_ENV injection, exact-main file tamper, zero side effects with a tree snapshot, forbidden-verb scan, closure recomputation, and mutation tests that disable six guards one at a time).
- `pytest` on test_ctv_incident_option_b, test_ctv_successor, test_ctu_blockers, test_recovery_stage, test_pr11_phase4_harness, test_ctu_l0_dependency_closure — 492 passed, 1 failed: `test_only_reviewed_stage_handlers_are_registered`, identical on main b858bd12 without these files; unrelated.
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
- Not wired into Recovery and not an authority: a third predecessor gate would need separate review, its own runner and explicit Human Owner authorization. Recovery R2-R8, LVR, L8, L9 and hardware stages were not started.
- Pinned release and restore-CLI identity cannot be proven from repository sources and is reported UNKNOWN.
