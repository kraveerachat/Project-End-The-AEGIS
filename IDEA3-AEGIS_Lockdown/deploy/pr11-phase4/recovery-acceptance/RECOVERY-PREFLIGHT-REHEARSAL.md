# Recovery non-consuming pre-live rehearsal

**Status: repository tooling only. Not an authorization. Not wired into the Recovery runner or any gate. Not executed on Production.**

Recovery R2–R8 has exactly ONE governed live attempt. This rehearsal exposes source, CLI, configuration, prerequisite and environment failures BEFORE the owner spends it.

## Use (the frozen operator user, not root, at an interactive terminal)

```
sh recovery-preflight-rehearse.sh <FROZEN_RUNNER> <PINNED_WORKTREE> <AUTH_DIR> "<non-secret owner reason>"
```

The entry point re-proves that the tool, the builder, the freeze tool and the driver are the exact-main Git objects, derives a private copy of the frozen runner
(`recovery_rehearsal_build.py`), runs it, prints one line per section, and deletes the copy. Exit status: `0` all rehearsed checks passed, `10` at least one is
BLOCKED, `97` a safety tripwire fired, `2` refused before the driver.

## What it runs

The runner's own existing read-only checks, exactly as the live runner runs them before the marker: its prefix (pins, environment gate, control-snapshot gates, operator
identity, ONE `sudo -v`), `recovery_hook_pregates` (collects EVERY failing gate, including the existing CTu-PASS-or-CTv-PASS predecessor gate), `recovery_hook_regate`,
the attempt-unconsumed check, and `aegisctl restore --help` from the pinned release (argparse exits before the restore command can run).

## What it never does

No marker, work directory, provenance file, capture or closeout; no baseline, ISOLATE, RESTORE, CLOSE, FINAL or VERIFY; no device command; no restart; no change to
the frozen runner. Every consuming or mutating function is replaced by a tripwire, and every privileged command goes through a default-deny read-only wrapper.

## How to read the result

- `PASS` — that check passed just now. `BLOCKED` — it failed (the reasons are shown). `NOT_REHEARSED` — it cannot be run without mutating, so nothing is claimed.
- `RESULT=PREFLIGHT_PASS_NOT_AUTHORIZATION` never means Recovery is authorized or will succeed. The live runner performs every gate again, and the exact D4 terminal-refusal
  rehearsal, the baseline and all root-owned captures still run only inside the live attempt.
- Today the existing predecessor gate accepts only CTu PASS or CTv PASS, so against the current CTv `CLOSED_FAIL` history the rehearsal reports
  `PREGATES=BLOCKED` and `PREDECESSOR_GATE_BLOCKING=YES`. That is the truthful outcome; the rehearsal does not bypass or relax that gate.

## Residual limits

- Privileged Python gates of the reviewed libraries read their code from stdin; the wrapper constrains the interpreter and script location, not those reviewed bodies.
- The derived copy has a different SHA-256 from the frozen runner; the driver judges the frozen digest (the one an Authorization names).
- A future change to the runner's final attempt block makes the builder refuse until this tool is re-reviewed.
