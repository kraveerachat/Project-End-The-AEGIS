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

## Option B prepared (source-only; NOT authorized, NOT executed)

Option B retains the installed target Core unit with **no additional restart**. Owner-verified evidence (not re-readable by the
preparing session): installed unit sha256 `82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c`, pre-image sha256
`b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890`, journal `apply-verified`, detector baseline INACTIVE, both drop-ins,
TrustedClock SYNCED/OK, PRE/POST evidence integrity PASS, historical S10 FAIL. The unit pin was independently proven to equal
`aegis-idea3-core.service.example` at merged main `d34b535fbad130e7423b37c2bece8812c4ea6e51`. The pre-image pin rests on owner evidence only.

Files (`deploy/pr11-phase4/ctv-incident/`):

- `ctv-option-b-verify.sh` — read-only verifier. Does not use `ctv_host_runtime_verify` (its `diff -u` has a single operand and fails on the
  host; **left unfixed here**, out of scope) or the historical S10 comparison. Gates, all fail-closed: repo HEAD, the verifier and its libraries equal
  the exact-main blobs; pinned unit equals the reviewed source; CTv marker consumed and bound to the work dir; no CTv PASS/FAIL closeout; no `RECOVERY-*`
  authority; CTu predecessor intact; journal exactly `apply-verified` with the pre-image at the pinned sha; installed unit bytes/ownership/directives;
  Core active/running/success from that unit path with no pending daemon-reload; effective ProtectClock/User/NoNewPrivileges/capabilities; exact
  two drop-ins; device id; detector INACTIVE; current TrustedClock SYNCED/OK; PRE/POST `SHA256SUMS` integrity; the historical compare output is not a
  PASS (recorded as FAIL, never promoted); and the mutable-state digest is identical at the start and end (race prevention). Only
  `systemctl show` is ever issued.
- `ctv-incident-disposition.sh` — the separately governed action. Default is a dry check that writes nothing. `--record` additionally requires root,
  an exact root-owned authorization file (below), the action and verifier being the exact-main blobs, an exclusive non-blocking lock on the
  canonical directory, a fresh passing verifier, then writes **one** `CTV-GLOBAL-CLOSEOUT-FAIL` (+ `.sha256`) with `ln` (never overwrites) and re-verifies
  that the state digest is unchanged. Idempotent: the same disposition under the same authorization id returns `ALREADY_RECORDED` and writes nothing; any other FAIL
  closeout is refused.

The closeout states: FAIL_IMMUTABLE, rollback **incomplete**, target unit **retained**, no additional Core restart, historical S10 **FAIL, not promoted**,
Recovery **not** authorized (the Recovery successor gate refuses any CTv FAIL closeout), plus the pins, evidence digests, frozen-runner digest, verifier and
action digests, device, detector mode, TrustedClock and Core MainPID at disposition.

### Exact Production action proposal (requires separate explicit Human Owner authorization)

1. Merge this PR after independent review; check out merged main in a root-trusted worktree.
2. As root run the dry check and keep its output:
   `ctv-incident-disposition.sh --repo <worktree> --main <merged-main> --canon /var/lib/aegis-idea3-governance --work <evidence>/ctv-work --device <device-id> --authorization <file>`
3. The Human Owner writes a root-owned, mode 0600/0400 authorization file containing exactly these nine lines and nothing else:
   `stage=CTv-incident-disposition`, `disposition=OPTION_B_TARGET_UNIT_RETAINED`, `expected_main=<merged-main>`,
   `unit_sha256=82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c`,
   `preimage_sha256=b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890`, `device_id=<device-id>`,
   `verifier_sha256=<sha256 of ctv-option-b-verify.sh>`, `action_sha256=<sha256 of ctv-incident-disposition.sh>`, `authorization_id=<unique id>`.
4. Run the same command with `--record`. Expected: `CTV_INCIDENT_DISPOSITION=RECORDED`. Any refusal means nothing was written.

No restart, reload, unit change, marker change, evidence change, or CTv/CTu/Recovery execution is part of this action. If the verifier
refuses (for example the pre-image sha does not match), stop and return to the Owner; Option A (restore the pre-image) would then be a new
authorized stage.
