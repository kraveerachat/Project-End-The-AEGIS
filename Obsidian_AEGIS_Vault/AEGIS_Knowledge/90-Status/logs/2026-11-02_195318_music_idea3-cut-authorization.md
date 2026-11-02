---
title: Task Receipt — IDEA3 central one-shot CUT authorization
date: 2026-11-02T19:53:18+07:00
owner: music
area: idea3
branch: feat/idea3-cut-authorization
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 central one-shot CUT authorization

## What changed

- A physical CUT now requires a Core-issued, durable, one-shot authorization grant before it is dispatched.
- The CUT request carries its own request and incident identity (8 keys) so a grant cannot be replayed against a
  different request.
- Logs the real exception at the two authorization-failure swallow points instead of discarding it.
- Code copied from the tree used on the live bench on 2026-11-01; the source history is unrelated so these are new
  commits on top of the Beelink protection stack.

## Source files changed

- `aegis_soc/controller.py`, `cut_client.py`, `local_cut.py`, `remote_response.py`, `supervisor.py` (modified);
  new `aegis_soc/cut_authorization.py`.
- `tools/live_purple_control_desktop.py` (modified).
- `docs/superpowers/plans/2026-10-29-central-one-shot-cut-authorization.md`,
  `docs/superpowers/specs/2026-10-29-central-one-shot-cut-authorization-design.md` (new).
- Tests: `tests/test_controller.py`, `test_cut_authorization.py`, `test_cut_client.py`,
  `test_graduated_response_core.py`, `test_gui_cut_authorization.py`, `test_local_cut.py`,
  `test_local_restore.py`, `test_offline_core_acceptance.py`, `test_pending_physical_cut_authorization.py`,
  `test_pending_physical_cut_client.py`, `test_protocol_ordering.py`, `test_runtime.py`,
  `tests/r1bv/test_r1bv_contract.py`, `tests/local_cut_identity_harness.py`.

## Verification evidence

- `python -m pytest tests/test_controller.py tests/test_cut_authorization.py tests/test_cut_client.py tests/test_graduated_response_core.py tests/test_gui_cut_authorization.py tests/test_local_cut.py tests/test_local_restore.py tests/test_offline_core_acceptance.py tests/test_pending_physical_cut_authorization.py tests/test_pending_physical_cut_client.py tests/test_protocol_ordering.py tests/test_runtime.py tests/r1bv/test_r1bv_contract.py` — 711 passed.
- Run under Xvfb (GUI tests execute instead of skipping) and as a non-root user, for the same reason noted in the
  Beelink protection stack receipt (`local_cut.py` fail-closed guard against a root operator UID).

## Canonical notes updated

- None — receipt only.

## Shared surfaces touched

- None — task stayed inside its selected area.

## Integration requests

- None.

## Known limitations

- Human review of the authorization store and the local CUT gate is still pending (reviewer task).
