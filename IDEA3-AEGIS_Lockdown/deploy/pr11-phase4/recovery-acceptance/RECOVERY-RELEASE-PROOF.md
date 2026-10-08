# Recovery release / restore-CLI identity proof

**Status: repository tooling only. Read-only. Not wired into any gate, runner or freeze. Authorizes nothing. Not executed on Production.**

Recovery pins a release id, the digest of that release's `RELEASE-SHA256SUMS`, and the digest of the release's restore CLI. `recovery_release_proof.py` establishes which of those facts can be
trusted and which are still owner inputs, deterministically.

```
python3 -I -B recovery_release_proof.py --repo <PINNED_WORKTREE> --main <EXACT_MAIN_SHA> [--frozen-runner <FROZEN>] [--host [--release-sums-sha256 <SHA256>]]
```

Exit status: `0` VERDICT=PASS (release and restore-CLI IDENTITY only), `3` PARTIAL (something is UNKNOWN or was not performed), `1` FAIL (contradiction, tamper, invented pin, untrusted authority).
Output: stable `RECOVERY_RELEASE_PROOF_<KEY>=<VALUE>` lines and `PROOF_SHA256` over them (no timestamps).

## What is derived (trusted, never supplied)

From the exact-main Git objects only (replacement objects disabled; repository HEAD must equal the pinned main):

| Fact | Source |
|---|---|
| `RELEASE_ID` | the unique canonical RRu LIVE closeout receipt (`…_music_idea3-rru-live-closeout.md`); every release-specific claim lives in that file and no other receipt, no receipt contradicts it, exactly one `RRU_RELEASE_ID` exists |
| release commit | that id must be a 40-hex commit object and an ancestor of the pinned main |
| `RESTORE_CLI_SHA256`, `RECOVERY_CORE_SHA256`, `PRODUCTION_DETECTOR_SHA256` | SHA-256 of `aegis_soc/cli.py`, `recovery_core.py`, `production_detector.py` at the **release commit** (what the release carries, not what main says now; a difference is reported) |

Today this yields release `954ce1c191885e9e90198a6f54a3d990bcf144fc` and its three digests from the repository alone.

## What the host proof (`--host`, root) checks

The reviewed `p4-l7-release-guard.py` (layout, no symlink/special file, nothing group/world writable, root ownership, `RELEASE-SHA256SUMS` matches every payload file, manifest fields); the release path and
`current` under a root-owned non-writable ancestor chain (the existing `check_trusted_path` / `check_tree_owner`); manifest release id and source commit equal the derived release; every `aegis_soc` entry of the
manifest equals the release-commit blob; the host CLI/Core/detector files equal the derived digests and are manifested; the interpreter is a trusted manifested executable; `current` names exactly this release.
`--frozen-runner` additionally refuses any frozen pin (`RELEASE_ID`, the three digests) that is not the derived value.

Malformed host proof input is deterministic and fail-closed. An undecodable or unreadable `RELEASE-SHA256SUMS` is refused as `RELEASE_GUARD_INPUT_UNDECODABLE` or `RELEASE_GUARD_INPUT_MALFORMED`; a malformed checksum line is refused by the reviewed guard, and the proof's independent parser also refuses `RELEASE_SUMS_LINE_MALFORMED`. These input failures return exit 1 and never expose a traceback.

## Inputs still required from the Human Owner (the tool never invents them)

1. **`RELEASE_SUMS_SHA256`** — the digest of the deployed `RELEASE-SHA256SUMS`. It covers the venv, which only the host holds, so it cannot be derived from the repository. The owner reads it on the host after
   independent review; the tool accepts it only if the **host** manifest equals it **and** passes the release guard. Without it the verdict is PARTIAL and the observed host value is printed explicitly as *not a pin*.
2. `DETECTOR_UNIT_SHA256` (a host file digest) and the other Recovery pins/authorization inputs are outside this tool (`NOT_PROVEN_BY_THIS_TOOL`).
3. A real frozen runner, root-owned verifier/control snapshots, and the same-day Authorization/K3 — none exist yet.

## Limits

- A PASS means ONLY release and restore-CLI identity. It never states Recovery readiness or authorization (`RECOVERY_AUTHORIZED=NO`, `RECOVERY_READINESS=NOT_ASSESSED`).
- Interpreter and venv content are anchored to the host manifest (and the owner pin), not derivable from the repository.
- Production mode requires root and a root-owned, non-writable tool directory and repository; a user-owned checkout is refused. The hermetic seam exists only for tests (`RECOVERY_RELEASE_PROOF_TEST_ONLY=YES` plus a private test root) and is labelled `MODE=HERMETIC_TEST`.
- The tool loads its three reviewed siblings (release guard, snapshot and freeze tools) from bytes it first hashed against the exact-main blobs.
