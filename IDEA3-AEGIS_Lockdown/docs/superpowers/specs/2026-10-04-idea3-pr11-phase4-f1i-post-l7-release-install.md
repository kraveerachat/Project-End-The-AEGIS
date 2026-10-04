# IDEA3 PR11 Phase 4 — Stage F1i: governed POST-L7 install of one repaired immutable release (OD-F1I-01)

Status: **repository design + implementation only** (IMPLEMENTED != DEPLOYED). Owner decision: F1i APPROVED for repository implementation on main `c2238375`. No F1i Authorization/K3 exists, no
F1i run occurred, no runner is frozen.

## 1. Why a new stage (and why L6c is not "fixed")

L6c is the pre-L7 immutable-release install. Its verify handler is **intentionally PRE-L7**: it requires `/etc/aegis-idea3/credentials` and `/etc/aegis-idea3/core.env` absent and
`aegis-idea3-core.service` `LoadState=not-found` (proof that the stage created no L7 material). Those are false by design on the current post-L7 Production host. A maintenance reuse
of L6c on 2026-10-04 therefore ran the installer successfully, failed its own verifier closed and rolled back:

```
L6C_MAINTENANCE_ATTEMPT_LIVE_EXECUTED=YES   L6C_MAINTENANCE_ATTEMPT_RESULT=FAIL
L6C_MAINTENANCE_ATTEMPT_FAIL_REASON=L7_MATERIAL_PRESENT:/etc/aegis-idea3/credentials
L6C_MAINTENANCE_ATTEMPT_ROLLBACK=PASS       L6C_MAINTENANCE_ATTEMPT_PRE_RB_COMPARE=PASS
L6C_MAINTENANCE_ATTEMPT_AUTH_CONSUMED=YES   L6C_MAINTENANCE_ATTEMPT_RETRY=FORBIDDEN
RELEASE_INSTALLED=NO
```

L6c stays historically correct for a pre-L7 install and is **not** changed, loosened or re-ordered. F1i is a new, explicitly post-L7-aware stage.

## 2. Contract

Order: `L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9`.

- **Mutation boundary.** The ONLY persistent mutation is the creation of `/opt/aegis-idea3/releases/<RELEASE_ID>` by the reviewed `p4-l7-install-release.py`, called exactly once (its
  copy predicates are reused, not duplicated). F1i never creates `/opt/aegis-idea3` or its `releases` directory, never touches `current`, an old release, credentials, `core.env`, a unit,
  the Core, the detector, the broker, Recovery, IDEA1/IDEA2 or an ESP32. The privileged backend can only `systemctl show` the Core/detector units plus that single fixed installer argv.
- **Preflight.** exact pinned main, clean worktree, fresh same-day Authorization + K3 (`stage=F1i`, no extra field), `F1I-ATTEMPT-CONSUMED` unconsumed, canonical L8p closeout, no prior
  successful F1i receipt, target release absent (and no installer temp residue), `/opt/aegis-idea3` and `releases` already exist, `current` is an existing symlink whose target string is
  exactly the frozen expected release and that release passes the release guard root-owned, Core active/running (PID and NRestarts snapshotted), detector absent on BOTH surfaces (unit
  and standalone process), IDEA2 §10, preserved services, broker, headroom, builder output passes the release guard (`--expect-owner any`) with the exact id, source SHA, clean tree
  and `production_detector.py` digest. The read-only `check` runs through `sudo` (root read authority).
- **Post-L7 preservation (verify).** NOT the L6c absence predicates. The L7 material and the Core unit are expected to exist: credentials and `core.env` must exist with unchanged metadata
  (type, mode, uid, gid, size, mtime, ctime, inode), `current` byte-for-byte the same pointer, the Core the SAME process (MainPID and NRestarts exact), the new release a real directory that
  passes the guard root-owned with exact id/source SHA/clean tree/detector digest and an unchanged tree-state digest, the detector absent. The Core `LoadState` is never required `not-found`.
- **Secrets.** credentials and `core.env` are secret-metadata-only. Their CONTENT is compared in memory inside the single apply process and discarded; only metadata and a fixed boolean are
  journaled or printed. No content, no digest of content (the same rule PR #335 applied to `core.env`).
- **Comparator.** The captured keys are `host.aegis_idea3.release_catalog` (the new release) and nothing else. `stages/F1i/allow-keys.txt` has ZERO keys (parents exist post-L7, unlike the
  first-ever install). The catalog change is approved only by the existing RELATIONAL one-release rule (`ALLOW_L6C_RELEASE_FILE` with `stage F1i` + `release_id <id>`; the label is the only
  addition to `p4-compare.sh`): every release already present stays byte-identical and exactly the named id may be added. The runner also proves the added entry carries the journaled tree digest.
  `current`, listeners, material metadata and the Core PID/NRestarts drift fail; disk free space remains INFO under the existing comparator semantics.
- **Rollback.** Owns ONLY the release this attempt created. Ownership is a strict journal-state boundary: `installing` (outcome unknown) and `installer_failed` are never deletion authority (target absent → nothing owned; target present → fail closed and untouched, even if fully valid and even for `RELEASE_ALREADY_INSTALLED`); only `installed`/`applied` together with a journaled tree digest own the release, and then first prove `current` is the exact pre-attempt target, the target is a
  real directory that still passes the guard with the exact id/source SHA/detector digest and unchanged tree digest, then remove exactly that directory (tree scanned first; any symlink or
  special file refuses before a byte is deleted). Never `/opt/aegis-idea3`, `releases`, an old release, `current`, credentials, `core.env`, units or Recovery. After: target absent, current
  unchanged, Core same PID/NRestarts, detector absent, material unchanged, PRE→RB zero drift, IDEA2 §10. Unknown state fails closed; no retry.
- **Successors.** F1r requires, from the pinned commit, exactly ONE status-log receipt with `F1I_LIVE_EXECUTED=YES`, `F1I_RELEASE_INSTALLED=YES` and `F1I_RELEASE_ID=<its NEW_RELEASE_ID>`. F1 still requires F1r.
  The runtime release pins stay as defense in depth.

## 3. Not claimed

F1i live, F1r live, L6c reuse, F1 attempt 2 and real detector acceptance are all NOT run and NOT authorized. Hermetic tests prove repository behavior only.
