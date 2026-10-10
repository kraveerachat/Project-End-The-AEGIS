# IDEA3 inactive-detector Core successor — Implementation Plan

> **For agentic workers:** Implement inline. Keep the live executor blocked.

**Goal:** Add an IDEA3-only design and deterministic pure offline evidence checker for a future Core upgrade that preserves an inactive detector.

**Architecture:** A design note fixes the authority and missing-evidence boundary. A standard-library Python function evaluates caller-supplied mappings without I/O or side effects; pytest fixtures prove the contract and negative cases.

**Tech Stack:** Python standard library, pytest, Markdown.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md`

## Global Constraints

- No live-capable executor, host command, marker, journal, Recovery wiring, or Production mutation.
- Preserve F1u/R1Du, frozen runners, CTu/CTv history, and consumed markers.
- The offline report always declares live executor blocked, readiness not assessed, authorization none, and physical containment not proven.
- All added paths remain IDEA3-owned; add exactly one current-task receipt at closeout.

## Review Focus

- Inactive unit with a nonzero PID or process count → reject; test activation and PID drift.
- Missing, extra, or mismatched candidate file digest → reject; test exact closure and mismatch.
- OLD rollback target ID/tree mismatch or unapproved class → reject; test preflight and rollback refusal.
- CTu/CTv history changed or promoted → reject; test both immutable records.
- Any prohibited effect listed → reject; test CUT/RESTORE/ISOLATE/MQTT/network/Core/Detector/deployment actions.

---

### Task 1: Offline evidence contract

**Files:** Create the spec, pure checker under `deploy/pr11-phase4/inactive-core-successor/`, and `tests/test_inactive_core_successor_contract.py`.

**Interfaces:** `evaluate(evidence: Mapping[str, object]) -> dict[str, object]`; no I/O or injected host interfaces.

- [x] Write focused tests first and confirm RED.
- [x] Implement strict deterministic checks and fixed safety declarations.
- [x] Run focused tests, syntax and diff checks.

### Task 2: Governed closeout

**Files:** Update the IDEA3 status note; add one immutable `music` receipt; prepare one Draft PR body using `.github/PULL_REQUEST_TEMPLATE.md`.

- [ ] Record exact changed paths and test output; validate policy/checklist.
- [ ] Commit, push the task branch, open one Draft PR, and request independent Security/Governance review on the exact head.
- [ ] Do not merge.
