# CTv consumed-attempt incident — disposition and recovery proposal

Status: **PROPOSAL ONLY. Nothing in this document has been executed or authorized.** It does not create a CTv PASS, a
closeout, a successor stage, or any authority. CTv remains CONSUMED, NO RETRY.

## Provenance of the incident facts

The Production facts below were supplied by the Human Owner at remediation start (authority main
`67ee7dc8511e920afac9e2e6c8d4528ca01c741f`). The remediation session could not read the root-owned canonical directory,
the CTv work directory, or the journal (permission denied; no sudo), so these facts are **not independently verified here**.
The three defects were confirmed from repository source at that main.

| Fact | Reported state |
|---|---|
| CTv attempt marker | CONSUMED (immutable; never deleted or rewritten) |
| `CTV-GLOBAL-CLOSEOUT-PASS` / `-FAIL` | both absent |
| Journal phase | `apply-verified` |
| Core | active/running |
| Production Core unit | changed to the target unit; rollback incomplete |

## Defects remediated in this PR (source only)

1. **TrustedClock evidence UNAVAILABLE.** The bundled `p4-l5-clock.py` imports `aegis_soc.trusted_time`, which was not in
   the CTv bundle. The capture recorded UNAVAILABLE instead of the real state. The bundle now carries the exact import
   closure (`aegis_soc/__init__.py`, `trusted_time.py`, `protocol_v1.py`), hashed against exact main and verified by
   `ctv_verify_bundle`. Capture runs with `PYTHONDONTWRITEBYTECODE=1` so the sealed bundle is not mutated.
2. **S10 comparator rejected the expected change.** `stages/CTv/allow-keys*.txt` named unit directives
   (`ProtectClock`, `User`, ...) that the capture never records. They now name the captured evidence keys: Core unit
   file class/meta/sha256, Core `MainPID`/`ExecMainStartTimestamp`, and the detector `Requires=` identity consequence
   (the same reviewed set as CTu). Directive correctness stays proven by `ctv_host_runtime_verify`. Anything else
   still fails.
3. **Rollback could not restore.** The non-hermetic rollback expanded an unset `CTV_UNIT_DEST` with `${...:?}`, which aborts
   the shell, so no restore and no failure closeout happened. The runner now sets `CTV_UNIT_DEST` in every mode, and
   rollback validates it, returns a controlled failure if invalid, and runs `install`/`systemctl` through `ctv_run`
   like apply.

These fixes apply to **future** runner/bundle/control freezes. The already-consumed frozen runner and its evidence are not
modified and cannot be used to re-run.

## Proposed disposition (requires explicit Human Owner authorization for each step)

Nothing below may start without a separate written authorization naming the exact step. No step may delete or rewrite a marker.

1. **Freeze evidence (read-only).** As root, record `sha256sum` of the CTv evidence tree, canonical directory listing,
   journal and `journal.preimage`; confirm marker present and both closeouts absent. Compare the installed
   `/etc/systemd/system/aegis-idea3-core.service` sha256 to the target unit sha and to `journal.preimage`.
2. **Decide the intended end state** (Owner decision, with the step-1 evidence):
   - **A. Restore the pre-image** (return Production to the pre-CTv unit), or
   - **B. Accept the target unit** and prove it with the existing read-only runtime checks
     (`ProtectClock`, `User`, `NoNewPrivileges`, capability sets, drop-ins, device id, detector mode).
3. **Execute the chosen state under a separately reviewed and authorized owner action**, bounded to one daemon-reload and
   at most one Core restart, with before/after captures. For A, restore from the journal pre-image using the fixed
   rollback. This is a new governed stage, not a CTv retry, and is out of scope for this PR.
4. **Record the truthful outcome.** CTv has no PASS: its disposition is a FAIL/incident closeout written by an authorized
   reviewed action with the real reasons (clock evidence unavailable, comparator contract mismatch, rollback not run).
   Never a fabricated PASS or backdated closeout.
5. Only after steps 1-4 and independent review may a human consider any new CTv-successor authority.

## Explicitly not done

No CTv/CTu rerun, no Recovery, no marker change, no Production mutation or service restart, no frozen-runner edit,
no new stage.
