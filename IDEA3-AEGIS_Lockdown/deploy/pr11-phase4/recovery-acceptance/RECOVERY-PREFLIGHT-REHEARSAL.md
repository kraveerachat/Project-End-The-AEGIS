# Recovery non-consuming pre-live rehearsal

**Status: repository tooling only. Not an authorization. Not wired into the Recovery runner or any gate. Not executed on Production.**

Recovery R2–R8 has exactly ONE governed live attempt. This rehearsal exposes source, CLI, configuration, prerequisite and environment failures BEFORE the owner spends it.

## Use (the frozen operator user, not root, at an interactive terminal)

```
sh recovery-preflight-rehearse.sh <FROZEN_RUNNER> <PINNED_WORKTREE> <AUTH_DIR> "<non-secret owner reason>"
```

The entry point re-proves that the tool, the builder, the freeze tool and the driver are the exact-main Git objects, derives a private copy of the frozen runner
(`recovery_rehearsal_build.py`), runs it, prints one line per section, and deletes the copy. Exit status: `0` all rehearsed checks passed, `10` at least one is
BLOCKED, `20` every rehearsed check passed but sections remain `NOT_REHEARSED` (**never `0`**: a rehearsal is never a complete pass), `97` a safety tripwire fired, `2` refused before the driver.

## What it runs

The runner's own existing read-only checks, exactly as the live runner runs them before the marker: its prefix (pins, environment gate, control-snapshot gates, operator
identity, ONE `sudo -v`), `recovery_hook_pregates` (collects EVERY failing gate, including the existing CTu-PASS-or-CTv-PASS predecessor gate), `recovery_hook_regate`,
the attempt-unconsumed check, and `aegisctl restore --help` from the pinned release (argparse exits before the restore command can run).

## What it never does

No marker, work directory, provenance file, capture or closeout; no baseline, ISOLATE, RESTORE, CLOSE, FINAL or VERIFY; no device command; no restart; no change to
the frozen runner. Every consuming or mutating function is replaced by a tripwire, and every privileged command goes through a generated wrapper that validates the WHOLE command against exact read-only forms (below) and refuses everything else before any privileged execution.

## How to read the result

- `PASS` — that check passed just now. `BLOCKED` — it failed (the reasons are shown). `NOT_REHEARSED` — it cannot be run without mutating, so nothing is claimed.
- `RESULT=PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION` never means Recovery is authorized or will succeed. The live runner performs every gate again, and the exact D4 terminal-refusal
  rehearsal, the baseline and all root-owned captures still run only inside the live attempt.
- Today the existing predecessor gate accepts only CTu PASS or CTv PASS, so against the current CTv `CLOSED_FAIL` history the rehearsal reports
  `PREGATES=BLOCKED` and `PREDECESSOR_GATE_BLOCKING=YES`. That is the truthful outcome; the rehearsal does not bypass or relax that gate.

## The privileged-command contract

The wrapper allows ONLY the forms the reviewed Recovery pre-gates issue, nothing else: `true`; `test -d|-e|-L PATH`; `stat -c %u PATH`; `readlink PATH`; `sha256sum PATH`;
`find PATH -maxdepth 0 -perm /022` and `find PATH -maxdepth 1 -type f \( -name A -o -name B \) -printf '%f\n'`; `awk` with exactly one of three reviewed programs and one file;
`pgrep -fc 'aegis_soc[.]production_detector'`; `systemctl show (-p PROPERTY)+ UNIT.service`; `nft list tables` and `nft --stateless list table FAMILY NAME`; and the pinned interpreter
(by exact equality) running `p4-l7-release-guard.py check --logical-path … --host-path … --expect-owner root` with the script canonicalized inside the control snapshot.
The program is a bare name resolved only in `/usr/bin /bin /usr/sbin /sbin` (any `/` is refused); the command runs through `env -i` with a fixed `PATH`; every path operand is absolute,
made of safe characters and free of `..`; there is no `env`, shell, `grep`, `cat`, `cmp`, `sort`, `uniq`, `date`, `journalctl` or stdin Python. A command that cannot be matched is refused,
not approximated.

## Residual limits

- The one privileged Python tool (`p4-l7-release-guard.py check`) is reviewed code from the frozen control snapshot; the wrapper constrains the interpreter, the script location and its arguments, not that tool's body. Stdin Python is not allowed.
- The runner's own pre-gates run `git fetch origin`: a network read that updates remote-tracking refs and objects in the pinned worktree (never its files or HEAD). The rehearsal prints this.
- SIGINT, SIGTERM, SIGHUP and a normal exit remove the private temporary directory; **SIGKILL or power loss leaves `/tmp/aegis-recovery-rehearsal.*` (mode 0700; the wrapper log can hold privileged command lines), which is safe to delete**, and a sudo keepalive process can outlive a SIGKILL.
- The derived copy is an operator-owned file (no privilege boundary is crossed); it is hashed after the build and re-hashed immediately before it runs, which narrows but does not eliminate a same-uid swap window.
- The derived copy has a different SHA-256 from the frozen runner; the driver judges the frozen digest (the one an Authorization names).
- A future change to the runner's final attempt block makes the builder refuse until this tool is re-reviewed.
