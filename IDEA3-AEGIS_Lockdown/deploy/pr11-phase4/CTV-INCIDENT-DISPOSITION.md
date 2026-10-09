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

- `ctv-option-b-guard.sh` — shared Production guard, sourced only after it is proven equal to the exact-main blob.
- `ctv-option-b-verify.sh` — read-only, fail-closed verifier. Only `systemctl show` is ever issued. It does not use `ctv_host_runtime_verify`
  (its `diff -u` has a single operand and fails on the host; **left unfixed here**, out of scope) or the historical S10 comparison.
- `ctv-incident-disposition.sh` — the separately governed action. Default is a dry check that writes nothing and prints the evidence digests the
  Owner must bind into the authorization.

### Production protections (review findings B1–B4, I1)

- **B1 — no `--hermetic` bypass.** Test seams need `--hermetic` **and** `CTV_OPTION_B_TEST_ONLY=YES` **and** a safe `CTV_OPTION_B_TEST_ROOT` (canonical,
  not a symlink, not `/`, not under or equal to `/etc /var /usr /opt /boot /bin /sbin /lib* /root /srv /proc /sys /dev /run`, owned by the caller, not group/world
  writable). Every path must be canonical, inside that root, and never a production governance path. Without `--hermetic` the canonical directory is
  **exactly** `/var/lib/aegis-idea3-governance` and the unit and `core.env` paths are fixed; any override is refused.
- **B2 — positive, anchored S10 evidence.** The historical compare output must be a genuine `p4-compare.sh` report (schema line, no-mutation line) containing
  `PRESERVATION_S10=FAIL` and `COMPARE_RESULT=FAIL` exactly once each; absence of PASS is not accepted. The PRE `SHA256SUMS`, POST `SHA256SUMS` and compare-output
  digests are bound into the authorization and re-checked on every run. The PRE detector baseline (loaded/inactive/dead/PID 0/disabled) is read from the
  integrity-verified PRE capture, in addition to the current host check.
- **B3 — trusted execution.** The verifier proves the complete import closure of the clock probe (`aegis_soc/__init__.py`, `trusted_time.py`, `protocol_v1.py`;
  a test recomputes it with `ast`), the guard and both libraries against the exact-main blobs, and requires the repo (every ancestor), every executed file, the
  work directory and `/usr/bin/python3` to be root-owned and not group/world writable in Production. `CTV_SUDO` is pinned (root: none; otherwise
  `/usr/bin/sudo`), never inherited. The unit must be `0:0` and not group/world writable. Scripts start with `#!/bin/bash -p` and re-exec under `env -i`, so
  `BASH_ENV`, `ENV`, `PYTHON*`, `SHELLOPTS` are neutralized; running `bash <script>` with `BASH_ENV`/`ENV` set is refused. Python runs with `-I -B -X pycache_prefix=<missing dir>`.
- **B4 — crash safety.** The closeout is created once, atomically (`ln`, never an overwrite), then its sidecar is created the same way. If a crash leaves a closeout
  without its sidecar, a rerun regenerates the exact expected text, requires it to match byte for byte, and creates **only** the sidecar; the closeout is never
  rewritten. A tampered closeout, a mismatching sidecar, or a sidecar without a closeout are refused without changes. Stale temp files are ignored.
- **I1 — no stale commit.** Immediately before the commit the action re-runs the whole verifier and requires the same mutable-state digest as the first proof,
  otherwise it refuses (`STATE_DRIFT_BEFORE_COMMIT`) and removes its temp file. A final post-write verification repeats the check. A sub-millisecond window
  between that last proof and the `ln` cannot be eliminated by a userspace script; the exclusive lock and the append-only `ln` bound its effect.

The closeout states: FAIL_IMMUTABLE, rollback **incomplete**, target unit **retained**, no additional Core restart, historical S10 **FAIL, not promoted**,
Recovery **not** authorized (the Recovery successor gate refuses any CTv FAIL closeout), plus the pins, evidence digests, frozen-runner digest, verifier, guard and
action digests, device, detector mode, TrustedClock and Core MainPID at disposition.

### Exact Production action proposal (requires separate explicit Human Owner authorization)

1. Merge this PR after independent review. As root, create a **root-owned** exact-main tree for execution (for example `git clone --no-hardlinks` of the
   merged repository into a root-owned directory whose ancestors are all root-owned, then `git checkout <merged-main>`). A user-owned worktree is refused.
2. As root run the dry check and keep its output (it prints the three evidence digests):
   `ctv-incident-disposition.sh --repo <root-owned-tree> --main <merged-main> --canon /var/lib/aegis-idea3-governance --work <evidence>/ctv-work --device <device-id>`
3. The Human Owner writes a root-owned authorization file (mode 0600/0400) containing exactly these thirteen lines and nothing else:
   `stage=CTv-incident-disposition`, `disposition=OPTION_B_TARGET_UNIT_RETAINED`, `expected_main=<merged-main>`,
   `unit_sha256=82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c`,
   `preimage_sha256=b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890`, `device_id=<device-id>`,
   `verifier_sha256=<sha256 of ctv-option-b-verify.sh>`, `action_sha256=<sha256 of ctv-incident-disposition.sh>`, `guard_sha256=<sha256 of ctv-option-b-guard.sh>`,
   `pre_sha256sums_sha256=<dry-check value>`, `post_sha256sums_sha256=<dry-check value>`, `compare_output_sha256=<dry-check value>`, `authorization_id=<unique id>`.
4. Run the same command with `--authorization <file> --record`. Expected: `CTV_INCIDENT_DISPOSITION=RECORDED`. Any refusal means nothing was written.
   If the process is interrupted after the closeout appears, rerun the identical command: it completes only the sidecar.

No restart, reload, unit change, marker change, evidence change, or CTv/CTu/Recovery execution is part of this action. If the verifier
refuses (for example the pre-image sha does not match), stop and return to the Owner; Option A (restore the pre-image) would then be a new
authorized stage.
