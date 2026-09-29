---
title: Task Receipt — L7 Attempt #2 post-failure repository remediation (credential mode + listener false positive)
date: 2026-09-29T05:55:56+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l7-attempt2-postmortem-remediation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — L7 Attempt #2 post-failure repository remediation

## What changed

Repository-only remediation of two independent defects surfaced by L7 Attempt #2's live failure and rollback.
No Production mutation was performed by this task; the attempt remains immutable historical evidence
(`L7_LIVE_ACCEPTANCE` stays NOT_PROVEN) and was not retried.

**Live Failure A — Core start rejected a genuine systemd-delivered credential**

- Journal proved `ValueError: credential admin.pin has unsafe permission mode`. `aegis_soc/systemd_credentials.py`
  rejected any credential with a group/other permission bit, but modern systemd's `LoadCredential=` may
  materialize a delivered credential as mode 0440 (owner+group readable) under a POSIX ACL scoped to the exact
  service account, rather than preserving the source file's 0600.
- Fix: `credential_path()` now accepts EXACTLY mode 0440, and only when `CREDENTIALS_DIRECTORY` resolves to
  exactly one path segment directly under the real, root-owned, PID-1-only `/run/credentials/` tree
  (`_is_systemd_managed_credentials_directory()`). Any other group/other-readable mode (0640, 0644, 0460, ...) is
  still rejected unconditionally, and an arbitrary caller-supplied directory merely named to look right (not
  actually under `/run/credentials/`) is still rejected even at exactly mode 0440. 0400/0600 remain accepted
  exactly as before. Symlink/non-regular-file rejection is untouched.

**Live Failure B — L7 rollback false-failed on ephemeral UDP port churn**

- Live evidence: pre->rollback listener comparison changed only UDP ports 39702, 44747, 48690 — all inside this
  host's kernel `ip_local_port_range` (32768-60999). `apply.sh`/`verify.sh`/`rollback.sh` compared raw
  `ss -H -ltnu` output exactly, which includes every UDP socket the kernel autobound to an ephemeral client port
  (resolvers, NTP/mDNS, ...); those rotate continuously and are not services. `p4-l0-capture.sh` already solves
  this for the T1/G-15 harness by excluding UDP local ports inside the kernel's own ephemeral range.
- Fix: new shared `deploy/pr11-phase4/stages/L7/l7-listener-lib.sh` (`l7_listener_snapshot()`), sourced by all
  three L7 handlers, giving them the exact same semantics as `p4-l0-capture.sh`: TCP is never filtered, a UDP
  port outside the kernel range is never filtered, the range is read fresh every snapshot (never hard-coded), and
  if the range cannot be read and validated, nothing is filtered (fail-safe — possible ephemeral-port churn noise
  survives, but a real dropped/added listener is never hidden).

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/systemd_credentials.py` — narrow 0440 exception scoped to a genuine
  `/run/credentials/<unit>` directory; `_SYSTEMD_MANAGED_CREDENTIALS_ROOT` module constant (monkeypatchable by
  tests) replaces a hard-coded path literal so tests never need real root/systemd.
- `IDEA3-AEGIS_Lockdown/tests/test_systemd_credentials.py` — 6 new RED→GREEN tests: genuine 0440 accepted;
  0440 outside the genuine directory still rejected; 0644 still rejected even inside the genuine directory;
  0400/0600 still accepted unconditionally; symlink still rejected even inside the genuine directory;
  `credential_path()` (not just `read_text_credential()`) accepts the same contract.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/l7-listener-lib.sh` — new shared listener-snapshot helper
  (one implementation for all three handlers, matching `p4-l0-capture.sh`'s reviewed ephemeral-UDP contract).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/apply.sh` — sources the new lib; baseline snapshot now uses
  `l7_listener_snapshot` instead of raw `ss_do -H -ltnu`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/verify.sh` — same wiring for its current-listener snapshot.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/rollback.sh` — same wiring for its rollback-listener
  snapshot; gained its own `HERE` resolution (previously had none) solely to source the shared lib.
- `IDEA3-AEGIS_Lockdown/tests/l7_support.py` — `FAKE_SS` test stub now honors an optional `udp:`/`tcp:` prefix
  per `FAKE_SS_LISTEN` line (defaults to `tcp` for every existing caller, unchanged behavior) so tests can
  synthesize UDP listener lines.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_listener_ephemeral_filter.py` — new RED→GREEN suite (13 tests)
  covering apply/verify/rollback: ephemeral UDP churn ignored; fixed UDP add/remove flagged; TCP add/remove
  flagged (even at a port number inside the UDP ephemeral range); malformed/unreadable range never silently
  suppresses drift (5 parametrized cases); rollback's full-residue proof still holds under the new snapshot.

## Verification evidence

- `pytest tests/test_systemd_credentials.py -q` on pre-fix module — fail: 5 of 15 failed (RED confirmed).
- Same command after the fix — pass: 15 passed.
- `pytest tests/test_pr11_phase4_l7_listener_ephemeral_filter.py -q` with the three handlers stashed back to their pre-fix state — fail: 3 of 13 failed (RED confirmed; the other 10 pass trivially since unfiltered `ss` already flags everything as drift).
- Same command with the fix restored — pass: 13 passed.
- `pytest tests/test_systemd_credentials.py tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_runner_flow.py tests/test_pr11_phase4_l7_d4_probe_log_side_effect.py tests/test_pr11_phase4_l7_input_gate_log_side_effect.py tests/test_pr11_phase4_l7_listener_ephemeral_filter.py tests/test_local_restore.py -q` — pass: 519 passed.
- `bash -n deploy/pr11-phase4/stages/L7/apply.sh` — pass.
- `bash -n deploy/pr11-phase4/stages/L7/verify.sh` — pass.
- `bash -n deploy/pr11-phase4/stages/L7/rollback.sh` — pass.
- `bash -n deploy/pr11-phase4/stages/L7/l7-listener-lib.sh` — pass.
- `git diff --check` — pass: no whitespace errors.
- `ruff check` on all new/modified Python files — pass: all checks passed (one pre-existing nested-if style finding in `systemd_credentials.py` was simplified in the same edit; 3 pre-existing `dict()`-literal findings in `l7_support.py` confirmed present on the unmodified file via temporary stash-and-check, not introduced here).
- `node scripts/validate-vault.mjs` — pass: 2 pre-existing owner-data warnings on unrelated canvas files, no new warnings from this task.

## Canonical notes updated

- `None` — scoped bug-fix task; no durable idea3 architecture/status fact changed beyond the fixes themselves.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None — idea3-only change, no cross-scope/shared path touched. Falls under the current approve-only-package convention (any of the three CODEOWNERS satisfies review).

## Known limitations

- L7 Attempt #2 remains immutable historical evidence; this task did not retry L7 and created no new authorization. A fresh A-L7/K3 record and owner decision are required before any new live attempt.
- The `_SYSTEMD_MANAGED_CREDENTIALS_ROOT` narrow-exception design trusts path location (`/run/credentials/<unit>`) as proof of systemd provenance, not a literal POSIX ACL entry parse (no new dependency was added for that, per the "narrowest secure compatibility correction" instruction). This is sufficient because that path is root-owned and populated exclusively by PID 1, but a future reviewer wanting stronger proof could add explicit ACL inspection as a follow-up.
