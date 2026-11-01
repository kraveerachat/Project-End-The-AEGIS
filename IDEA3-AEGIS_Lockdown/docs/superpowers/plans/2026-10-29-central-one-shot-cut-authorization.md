# Central One-Shot CUT Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centrally require and transactionally consume one Core-issued, action-bound approval before any physical `CUT_UPLINK` publication.

**Architecture:** A dedicated SQLite lifecycle store issues process-bound grants through the authenticated Core-local CUT gate. `AegisCommandController.issue()` consumes the grant before either Protocol v1 or legacy-lab publication and records terminal outcomes without ever rearming a consumed approval.

**Tech Stack:** Python 3, stdlib `sqlite3`, `hmac`, `secrets`, pytest, existing Protocol v1 fake transports.

**Spec:** `docs/superpowers/specs/2026-10-29-central-one-shot-cut-authorization-design.md`

## Global Constraints

- Work only on `feat/idea3-beelink-protection`; do not commit, push, merge, deploy, restart Live Core, contact MQTT/ESP32, or modify networking.
- Preserve authenticated RESTORE and refusal of manual CUT during in-flight RESTORE.
- Keep Server Dispatch, detector, Telegram, and standalone GUI physical CUT fail-closed unless they use a real Core-issued approval.
- Do not edit the protected `tools/purple_ui_source/aegis_soc/*` files.
- Tests use fake transports and disposable SQLite only.

## Review Focus

- SQLite schema/audit initialization failure must leave CUT refused before publish.
- A publish exception may mean the broker received bytes; approval must remain consumed and outcome unknown.
- A restart must not revive an unused process-bound grant or a consumed approval.
- Concurrent duplicate calls using one grant must produce at most one publication.
- RESTORE and dry-run semantics must remain independent from physical CUT admission.

---

### Task 1: RED central-admission and lifecycle tests

**Files:**
- Create: `tests/test_cut_authorization.py`
- Modify: `tests/test_controller.py`
- Modify: `tests/test_gui_cut_authorization.py`

**Interfaces:**
- Produces the expected `CutAuthorizationStore`, trusted issuer, frozen grant, Controller arguments, and failure reason codes used by Tasks 2-3.

- [ ] Add failing tests for missing/forged/wrong-request/wrong-target/wrong-action/expired/replayed grants, concurrent consume, direct Controller invocation, legacy-lab, audit failure, publish failure/exception, and restart invalidation.
- [ ] Add a failing Protocol v1 positive simulation asserting one signed fake MQTT publish and replay refusal.
- [ ] Run the focused tests and record failures caused by the absent central mechanism.

### Task 2: GREEN SQLite lifecycle and Controller choke point

**Files:**
- Create: `aegis_soc/cut_authorization.py`
- Modify: `aegis_soc/controller.py`

**Interfaces:**
- Consumes Task 1's test contract.
- Produces `CutAuthorizationStore`, `TrustedCutAuthorizationIssuer.issue(...)`, `CutAuthorizationGrant`, and Controller `cut_authorization`/binding parameters.

- [ ] Implement schema initialization, startup invalidation, atomic issue/audit, atomic consume/audit, and terminal outcome recording.
- [ ] Require successful consume in `AegisCommandController.issue()` for non-dry-run CUT before both protocol paths.
- [ ] Treat false publish as known-not-published and exceptions as unknown; never rearm approval.
- [ ] Run Task 1 tests to GREEN.

### Task 3: Trusted local issuer wiring and caller boundary regressions

**Files:**
- Modify: `aegis_soc/local_cut.py`
- Modify: `aegis_soc/supervisor.py`
- Modify: affected tests under `tests/` only where they previously issued an unapproved physical CUT.

**Interfaces:**
- Consumes Task 2 issuer/store and Controller arguments.
- Produces an authenticated local flow: peer UID + CUT secret + exact confirmation + bounded request fields -> grant -> Supervisor -> Controller.

- [ ] Add RED tests for local request binding, unauthorized standalone GUI, RESTORE contention, and no approval exposure to callers.
- [ ] Generate request IDs client-side, validate target/request/incident fields Core-side, issue only after Core authentication, and pass the grant through Supervisor without deriving authority from origin.
- [ ] Wire one store into Supervisor/Controller and keep Dispatch/detector/Telegram/standalone GUI calls unapproved.
- [ ] Update old positive test setup to mint approvals only through explicit trusted test helpers; retain all negative tests.
- [ ] Run local CUT, RESTORE, dispatch, protocol, graduated response, GUI security, and positive fake-transport tests.

### Task 4: Documentation and verification

**Files:**
- Modify: `doc/Content/04_SESSION_HANDOFF.md`

**Interfaces:**
- Consumes final source/test evidence.

- [ ] Record architecture, exact modified paths, RED/GREEN evidence, limitations, and no-production/no-hardware facts.
- [ ] Run `git diff --check`, exact modified-file inspection, protected-path check, focused regression, and the broad safe pytest suite.
- [ ] Perform a separate final diff/security review and report any remaining failures/skips honestly.
