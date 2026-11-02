---
title: Task Receipt — IDEA3 Beelink protection stack (remote agent, mTLS alerts, pending CUT)
date: 2026-11-02T19:52:49+07:00
owner: music
area: idea3
branch: feat/idea3-beelink-protection-stack
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Beelink protection stack

## What changed

- Beelink detection agent, signed remote alerts delivered over mutual TLS, and an operator-confirmed pending CUT
  path for a remote (`source=beelink`) attacker: the `AUTO_CUT` decision creates `REMOTE_CUT_AWAITING` and asks
  the operator; it does not cut automatically for a remote source.
- Parametrized deploy templates for the reverse-tunnel alert path (`deploy/beelink-agent/`, `deploy/remote-alert/`)
  — placeholders only, scanned for secrets/real hosts before merge (see Verification evidence).
- Ignore rules for keys, device NVS images and `core.env`.
- Live-tested on 2026-11-01 (Gate 2): MEDIUM/CRITICAL alerts from the Beelink agent over mTLS, two real CUT/RESTORE
  cycles on the Beelink Ethernet link; the deployment was decommissioned afterwards (relay removed).

## Source files changed

- `aegis_soc/cut_client.py`, `dispatch_worker.py`, `gui.py`, `local_cut.py`, `supervisor.py` (modified);
  new `aegis_soc/remote_alert.py`, `remote_alert_subscriber.py`, `remote_response.py`.
- `tools/aegis_beelink_agent.py` (new).
- `deploy/beelink-agent/`, `deploy/remote-alert/` (new, example/template files only).
- `requirements-remote-alert.txt` (new), `.gitignore` (updated).
- Tests: `tests/test_beelink_agent.py`, `test_cut_client.py`, `test_dispatch_boundary.py`,
  `test_dispatch_contract.py`, `test_graduated_response_core.py`, `test_local_cut.py`,
  `test_pending_cut_identity.py`, `test_protocol_ordering.py`, `test_remote_alert.py`,
  `test_remote_alert_e2e.py`, `test_remote_response_core.py`, `tests/remote_alert_support.py`.

## Verification evidence

- `python -m pytest tests/test_beelink_agent.py tests/test_cut_client.py tests/test_dispatch_boundary.py tests/test_dispatch_contract.py tests/test_graduated_response_core.py tests/test_local_cut.py tests/test_pending_cut_identity.py tests/test_protocol_ordering.py tests/test_remote_alert.py tests/test_remote_alert_e2e.py tests/test_remote_response_core.py` — 264 passed, 4 skipped.
- Run under Xvfb and as a non-root user: `local_cut.py` deliberately refuses to start when the operator UID
  resolves to root (`OPERATOR_UID_OR_SOCKET_MISSING_OR_ROOT`) — the designed fail-closed guard, not a defect.
- Scanned `deploy/beelink-agent/` and `deploy/remote-alert/` for private-key headers, inline passwords/tokens and
  literal `192.168.x`/`10.x` addresses — none found, all examples use placeholders.
- Re-confirmed in source (not only the design doc): for `source=beelink`, the `AUTO_CUT` branch in
  `remote_response.py` calls `request_cut(...)` and records `REMOTE_CUT_AWAITING` — no automatic cut.
  `telegram_control.py` has no CUT-handling code path.

## Canonical notes updated

- None — receipt only; canonical facts did not change beyond what the live-run report (idea3-status.md) already records.

## Shared surfaces touched

- None — task stayed inside its selected area.

## Integration requests

- None.

## Known limitations

- Full 13-commit human review of the Beelink stack and the authorization store/local CUT gate review are still
  pending (reviewer task, not re-done by this receipt).
- Did not re-run the whole repository test suite in this review pass (firmware/deploy hermetic subprocess tests
  are unrelated to this PR's diff and take >20 minutes); limited to the files this PR touches, listed above.
