# IDEA3 PR11 Phase 4 L7u — Post-L7 Recovery Core Upgrade (repository design/implementation)

Date: 2026-10-01 (Asia/Bangkok). Owner: music. Status: **repository implementation only — IMPLEMENTED != DEPLOYED**. No live
execution is authorized by this document or by merging the branch that carries it.

## 1. Decision, purpose and ordering

```text
CANONICAL_STAGE_ID   = L7u
CANONICAL_STAGE_NAME = Post-L7 Recovery Core Upgrade
ORDER                = L7 -> L7u -> Recovery R1-R8 -> LVR -> L8
AUTHORIZATION        = A-L7u   (same-day, stage=L7u, no extra field)
K3                   = FRESH, stage=L7u
```

The merged Core-mediated Recovery design ([2026-09-29-idea3-core-mediated-recovery-design.md](2026-09-29-idea3-core-mediated-recovery-design.md))
states that going live needs a separately governed post-L7 Core upgrade: a new immutable release, a governed restart, a socket
directory the operator uid can reach, and the operator-uid setting. **L7u is that stage.** It defines and tests the operation; it does not
run it.

What L7u does **not** do: prove Recovery R1–R8, prove LVR, authorize L8, carry `recovery_authorization` (an L8-only gate), touch an ESP32
or serial device, send CUT/RESTORE, resolve F1 or the R5 break-glass decision, or change F2 (duplicate-history fail-closed stays enforced).
L7u success is one evidence item (`L7U_LIVE_ACCEPTANCE`) that the Core runs the Recovery-capable release with the transport surface in
place; every later stage still needs its own authorization.

## 2. Frozen owner baseline (read-only evidence, not re-derived here)

```text
main (pinned)            = 81f201a41bdb2153820c8ead61762d7ffb97ca3c
running release (old)    = f2a5cd758ff3abe0e5cfb933f63af1960318dad0   (rollback authority; never mutated or removed)
Core                     = loaded/active/running/enabled, Result=success, NRestarts=0
Core identity            = aegis-idea3 uid 952, gid 950, no supplementary groups; UMask=0077; RuntimeDirectory=aegis-idea3 (0700)
operator                 = kittipat uid 1000 gid 1000 (+ 998, 984, 983, 1001, 957); NO group shared with the Core
Recovery files in old    = recovery_core/protocol/client/ui.py ABSENT; /run/aegis-idea3-recovery ABSENT
core.env                 = the three Recovery PROBE settings configured (values are never read or printed here);
                           AEGIS_RECOVERY_OPERATOR_UID / AEGIS_RECOVERY_SOCKET_GID / AEGIS_RECOVERY_SOCKET missing
```

## 3. Identity design (owner-frozen)

| Element | Value |
|---|---|
| Transport group | new dedicated system group `aegis-idea3-recovery` (created only if absent) |
| Purpose | filesystem traversal/access to the Recovery AF_UNIX socket **only** |
| Authority | unchanged: `SO_PEERCRED` uid == `AEGIS_RECOVERY_OPERATOR_UID` (1000). Group membership is **never** authorization |
| Operator | `kittipat` becomes a *supplementary* member; primary group untouched |
| Core | receives the group through systemd `SupplementaryGroups=` (drop-in), **not** through the group database |
| `AEGIS_RECOVERY_SOCKET_GID` | the numeric gid of `aegis-idea3-recovery` — never the operator primary gid 1000 (the Core is not a member of it), never unset (an unset gid makes the server create a 0600 socket the operator cannot open) |

Why the Core process can chgrp its socket with an empty `CapabilityBoundingSet`: it owns the socket and is a member of the target group
through `SupplementaryGroups=`, so `chown(-1, gid)` needs no capability. A test reads the running process's `Groups:` line to prove the
membership is real, not assumed.

Group safety rules (preflight refuses, apply re-checks after `groupadd`): no user account with that name; gid in the system range
(1–999); gid never 0, never the Core primary gid, never the operator primary gid; no duplicate group row by name or gid; members ⊆ {operator};
never the primary group of any account. A pre-existing safe group is **adopted** and is never deleted by rollback.

Operator-session effect (documented, not hidden): new group membership applies to **new login sessions only**. Rollback removes the
persistent membership, but a session started while it existed keeps the supplementary group until it ends. The runner prints this
as `L7U_OPERATOR_SESSION_NOTE`; it is the one irreversible-looking side effect and it is bounded to the operator's own login sessions.

## 4. Mutation set (smallest reversible)

| # | Surface | Mechanism | Created-by-attempt journal |
|---|---|---|---|
| 1 | new immutable release | existing `p4-l7-install-release.py` (re-runs the real guard); builder output from `p4-l7-build-release.py` | `RELEASE_INSTALL` |
| 2 | dedicated group | `groupadd --system aegis-idea3-recovery` if absent | `GROUP{created}` |
| 3 | operator membership | `gpasswd -a kittipat aegis-idea3-recovery` if not a member | `MEMBERSHIP{added}` |
| 4 | `core.env` | append only the missing owned lines; every pre-existing byte kept | `CORE_ENV{size,sha256,mode,uid,gid,mtime_ns,suffix}` |
| 5 | systemd drop-in | `/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf` (repository template, byte-exact) | `DROPIN` |
| 6 | tmpfiles rule + directory | `/etc/tmpfiles.d/aegis-idea3-recovery.conf`, then `systemd-tmpfiles --create <that file>` | `TMPFILES`, `RUNTIME_DIR` |
| 7 | reload / pointer / restart | `daemon-reload`; atomic `current` switch; ONE `systemctl restart` | `DAEMON_RELOAD`, `CURRENT_SWITCH`, `CORE_RESTART` |

Nothing else is written. `/run/aegis-idea3`, `/var/lib/aegis-idea3`, `/var/log/aegis-idea3`, `/etc/aegis-idea3` (other than the three appended
lines), every credential, the base unit file, the Core's global `UMask` and every other release are byte-identical (asserted by snapshot tests).

### 4.1 The drop-in (`deploy/aegis-idea3-core-recovery.dropin.example`)

```ini
[Service]
SupplementaryGroups=aegis-idea3-recovery
ReadWritePaths=/run/aegis-idea3-recovery
```

**Design finding added by this task.** The base unit sets `ProtectSystem=strict`, which makes `/run` read-only for the service. Without
`ReadWritePaths=` the existing `RecoveryServer` could not bind its socket under `/run/aegis-idea3-recovery` at all, even with perfect
ownership — the channel would fail soft (the supervisor logs `recovery_channel_failed` and the Core keeps running), so an upgrade could
"succeed" with no Recovery channel. The drop-in grants exactly that one path. `ReadWritePaths=` on a missing path fails the unit at namespace
setup, which is why the directory is pre-provisioned before the restart and the failure mode is hard, not silent.

### 4.2 The UMask 0077 trap and the tmpfiles rule (`deploy/aegis-idea3-recovery.tmpfiles.example`)

`RecoveryServer._prepare_path` calls `mkdir(mode=0o755, exist_ok=True)`. The Core runs with `UMask=0077`, so an application-created directory
is 0700 and the operator group cannot traverse it (regression test `test_umask_0077_makes_an_application_created_directory_untraversable...`).
L7u therefore never depends on the application's mkdir:

```text
d /run/aegis-idea3-recovery 0750 aegis-idea3 aegis-idea3-recovery -
```

Owner `aegis-idea3` satisfies the server's "directory must be Core-owned" check; mode 0750 has no group/world write bit (the other check);
the rule is re-applied on every boot before the Core. The engine creates the directory through `systemd-tmpfiles --create` and **verifies
0750 + owner + group + empty before it restarts the Core** (fixture `tmpfiles_wrong_mode` proves a 0700 directory aborts before any restart).
The server never chmods an existing directory (asserted on its source), so the provisioned mode survives. The socket the Core creates is
`aegis-idea3:aegis-idea3-recovery 0660`.

### 4.3 core.env contract

Owned keys: `AEGIS_RECOVERY_OPERATOR_UID=<uid>`, `AEGIS_RECOVERY_SOCKET_GID=<gid>`, `AEGIS_RECOVERY_SOCKET=/run/aegis-idea3-recovery/recovery.sock`.
Rules: the file must be a regular, non-symlink, newline-terminated file (otherwise the last line would have to be altered, so the stage fails
closed); the three probe keys must already be present exactly once (by key only — values are never read into any message); an owned key that
is duplicated, has a different value, uses `export`/quotes, or has a gid while the group does not yet exist fails closed; commented lines
are not settings. New bytes are written to a temp file in the same directory and `rename`d over, preserving mode/uid/gid. Output, journal and
tests never contain an env value; tests plant canaries in unrelated and probe lines and scan every artifact for them. The journal keeps a
SHA-256 of the pre-image for rollback verification; this is acceptable because the L7 contract (`p4-l7-core-env.py check`) forbids any
secret-bearing key in that file, and the digest covers the whole file. (L7's own `check` is intentionally not reused: it rejects unknown keys and
L7 is accepted and not re-run.)

## 5. Release switch (L7u owns its own; L7 and L6c are not reusable)

L6c forbids touching `current`; L7's receipt gate refuses rerun (`L7_ALREADY_ACCEPTED`). L7u therefore owns a new, separately tested switch:

* preconditions (read-only, before any change): `current` is a symlink whose target is **exactly** the old logical path; both releases pass the
  real guard (the new one from the builder output, installed owner `root` live); the new release's manifest `source_git_sha` equals the pinned
  main **exactly** and it ships the four Recovery files; the new release is not yet installed;
* the old target is journaled (fsync) **before** the pointer changes; the new release is installed and guarded first, so the target always exists;
* replacement is a `rename(2)` of a same-directory temp symlink over `current` — no unlink-then-symlink, no dangling intermediate;
* rollback restores the exact old target the same way; the old immutable release is never written.

## 6. Rollback contract (designed before apply)

`rollback` reads the journal, then runs **three phases**:

1. *Prove, change nothing.* Every journal kind must be known, appear once, and name only fixed owned paths/ids; `current` must be old or new;
   core.env must be the pre-image, or pre-image + exactly the journaled suffix (digests); the drop-in and tmpfiles files must still match
   their journaled digests; the new release must still pass the real guard and match the pinned identity; the runtime directory may hold only
   a *socket* named `recovery.sock`; a created group must have no member other than the operator and be no account's primary group. Any
   mismatch refuses **before any change**.
2. *Act, in a fixed order.* stop the Core (only if a restart was journaled) → remove the stale socket and the directory → restore `current`
   atomically → restore core.env (bytes, mode, owner, **mtime**) → remove the drop-in/tmpfiles files (and directories only if this attempt
   created them and they are empty) → `daemon-reload` → remove the membership only if this attempt added it → delete the group only if this
   attempt created it → remove the new release (two-pass, symlink-refusing) → `reset-failed` (that unit only, only if failed) and `start` the
   **old** Core.
3. *Prove the prestate.* `current` == old, the old release passes the real guard, and the old Core is active/running/enabled with
   `Result=success`, `NRestarts=0` and a real MainPID. A failure here is `S-11 HOLD`: the runner stops and does not retry.

A failure before the `CORE_RESTART` journal entry never stops or restarts the Core. Rollback is idempotent (a durable `rollback-done` marker
prevents a second Core restart). It never performs CUT/RESTORE and never touches an ESP32. The engine's `SystemBackend` accepts only these
argv forms: `groupadd --system|groupdel` on the one owned group name, `gpasswd -a|-d <non-root, non-Core user> <that group>`,
`systemd-tmpfiles --create <the one rule file>`, and `systemctl daemon-reload|restart|stop|start|reset-failed|show` on `aegis-idea3-core.service`
only — no shell, no `enable`/`disable`/`mask`/`kill`.

## 7. Observability (nothing invisible to PRE→POST / PRE→RB)

`p4-l0-capture.sh` records new deterministic, non-secret keys (never `/etc/gshadow`, password hashes, env content, credentials or keys):

```text
host.aegis_idea3.recovery.group.aegis-idea3-recovery     absent | present gid=N members=a,b   (from /etc/group)
host.aegis_idea3.recovery.runtime_dir                    absent | mode=750 uid=N gid=N
host.aegis_idea3.recovery.socket                         absent | type=socket mode=660 uid=N gid=N
host.aegis_idea3.recovery.core.{supplementary_groups,dropin_paths,fragment_path,read_write_paths,process_groups}
host.path.{drop-in dir, tmpfiles rule, /run/aegis-idea3-recovery, .../recovery.sock}
host.unit_file.<drop-in files>.{class,sha256,meta}       host.unit_file./etc/tmpfiles.d/aegis-idea3-recovery.conf.*
```

`svc.aegis-idea3-core.service.*` (MainPID, NRestarts, …), `host.symlink./opt/aegis-idea3/current.target` and `host.aegis_idea3.release_catalog` already
existed. `p4-compare.sh` gains two narrow, tested changes: `host.aegis_idea3.recovery.*` is an allowable (still exact-key) family, and
`ALLOW_L6C_RELEASE_FILE` also accepts the single stage line `stage L7u` (still exactly one stage line and one `release_id`).

* **PRE→POST** may approve only `stages/L7u/allow-keys.txt` (exact keys, no wildcard, no listener, no credential/pki/mqtt, no sysctl/firewall/
  network/time/IDEA2 key) plus the relational release-catalog rule for the one new release id. Key approval is coarse by design of the harness, so
  `p4-l7u-upgrade.py delta` adds the **exact-value** proof: current target old→new, catalog gains exactly the new id with every other fingerprint
  unchanged, group gid/members, drop-in and tmpfiles digests equal the repository templates, no extra file in either directory, runtime-directory
  and socket mode/owner, supplementary and process groups.
* **PRE→RB** runs with `allow-keys-rollback.txt` only: the bounded rollback restarts the old Core once, so `MainPID` and
  `ExecMainStartTimestamp` legitimately differ from PRE. Every other key — including every L7u-owned surface, `NRestarts`, `ActiveState`,
  `Result` — must equal PRE (zero drift). A residue (for example a leftover tmpfiles rule) fails the compare.

## 8. Stage governance and the runner

* `p4-lib.sh`: `P4_STAGES = … L6c L7 L7u L8 L9`; mutating; no repository gap; no extra authorization field. `p4-stage-gate.sh` rejects an L7u record that
  carries `d6_notice`, `integration_review` or `recovery_authorization`; an authorization or K3 minted for any other stage or day is refused
  (`AUTHORIZATION_STAGE_MISMATCH` / `K3_STAGE_MISMATCH` / `*_STALE`). The L8 gate is unchanged.
* `p4-l7u-run-lib.sh`: its **own** one-attempt marker (`L7u-…`), receipt gate (L2–L6a + current L7 acceptance required, refuses when L7u is already
  recorded as accepted), exact running-Core baseline gate, exact operator-identity gate, evidence secret scan; it reuses the stage-independent
  disk and IDEA2 §10 gates.
* `owner-run/run-l7u-owner.sh` is an **unpinned template** (three `PIN_` values) that refuses to run as committed. The owner freeze workflow copies it
  outside the repository, pins the merged main, the old release and the new release, and records its hash. Flow: read-only gates (records, stage
  gate in live mode, receipts, tools, exact Core baseline, disk, IDEA2 §10, legacy/broker liveness, forwarding) → the new release is **built**
  by the existing builder into user-owned staging → engine `preflight` with the real guards → **PRE capture** → **only then** the one-attempt marker is
  consumed → apply (once) → verify → POST capture → PRE→POST compare + exact-value delta + secret scan + S10 preservation → success is persistent;
  any failure after the first mutation runs the rollback handler once, captures RB and requires PRE→RB zero drift, else `S-11 HOLD`, no retry.
* A failing gate or a failing PRE capture never burns the authorization.

## 9. Verification matrix (repository; none of it touches a host)

`tests/test_pr11_phase4_l7u_upgrade_engine.py` (fixture host + stateful fake system backend that "boots" the Core from real on-disk facts),
`tests/test_pr11_phase4_l7u_stage_governance.py` (registration/order, gate separation, marker, receipt gate, runner/handler contract, real capture +
real compare on the fixture), `tests/test_pr11_phase4_l7u_recovery_runtime_contract.py` (UMask trap, pre-provisioned directory, socket contract,
group-is-transport-only, no network listener, unprivileged observer UI). `tests/l7u_support.py` is shared fixture support.

## 10. Honest limits

* **Nothing here is live-proven.** The fake backend models systemd, groupadd/gpasswd and tmpfiles from documented behaviour; it cannot prove
  real systemd accepts the drop-in on the owner's Core (`ReadWritePaths` namespace setup, `systemd-tmpfiles` group resolution at boot, the
  builder's `<staging>/<release-id>` output layout, `sudo` path handling). The first live run is the test of those.
* Reboot persistence of the tmpfiles rule is designed and unit-tested as a rule, not observed.
* `/etc/gshadow` is deliberately not captured; membership is observed through `/etc/group`.
* Recovery R1–R8, LVR and L8 remain unproven and separately gated; F1 and the R5 break-glass owner decision remain unresolved.
* Owner action required before any live run: freeze and pin the runner, same-day A-L7u and K3 for stage L7u, a clean pinned execution worktree, the
  builder wheelhouse, and Kla/Pub integration review of the shared-surface changes (`p4-lib.sh`, `p4-stage-gate.sh`, `p4-l0-capture.sh`, `p4-compare.sh`).

## 11. Release builder ships the Recovery runtime (live preflight finding, 2026-10-01)

The first live L7u attempt stopped in the engine preflight with `NEW_RELEASE_LACKS_RECOVERY_RUNTIME` (before PRE capture and before the attempt was
consumed). Cause: `p4-l7-build-release.py` computed the runtime closure of `aegis_soc.supervisor` only. The Core imports `recovery_core` and
`recovery_protocol`, but the Recovery observer entrypoint `python -m aegis_soc.recovery_ui` and its `recovery_client` are not imported by the Core, so a
real build omitted both while the repository test fixtures (hand-made releases) hid it. The builder and its verifier now use the union of the closures of
exactly two entrypoints, `ENTRYPOINTS = ("supervisor", "recovery_ui")`; the package stays exactly that closure (no unrelated module is added; the
observer's extra reach is `recovery_client` and `recovery_protocol`, all stdlib). The L7u preflight check is unchanged. Regression:
`tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py` builds a real release and feeds it to the real engine preflight.

## 12. First live attempt: exact-value delta privilege boundary (live finding, 2026-10-02)

The first L7u live attempt (main `9d04b797`, 2026-10-02 20:12 +07, consumed `consumed_at=2026-10-02T13:12:28Z`) applied and verified, passed the PRE->POST compare, then
failed `L7U_DELTA=FAIL reason=UNEXPECTED:PermissionError` and rolled back automatically (`L7U_ROLLBACK=PASS`, PRE->RB `COMPARE_RESULT=PASS`). Cause: the owner runner
ran `p4-l7u-upgrade.py delta` as the NORMAL user, but its first action (`read_records`) opens `host.tsv` and `services.tsv` in the root-owned `0700` `pre-root` and
`post-root` L0 capture directories. The engine tests called `engine.delta(...)` on in-memory records only, so neither the real runner line nor the real CLI was covered.

Fix (privilege boundary only; the exact-value proof itself is unchanged): the runner runs `delta` through the existing sudo boundary (`sudo "$PY" ... delta`, the same
form as `preflight`; no widening, no live-authorization flag), and `read_records` turns an unreadable capture into the explicit refusal
`DELTA_CAPTURE_UNREADABLE_ROOT_REQUIRED` instead of `UNEXPECTED:PermissionError`. Capture permissions are not loosened, `apply`/`verify`/`rollback` semantics are
unchanged, and the proof still runs after the PRE->POST compare with a failure still rolling back. Regression: `tests/test_pr11_phase4_l7u_delta_privilege.py`.
**Limit:** this was the first time `delta` ran against the real host; any further live-only defect behind it stays undiscovered until the next attempt. L7u is NOT live-accepted.
