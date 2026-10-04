# F1u — governed post-F1 Core upgrade (OD-F1U-01, owner amendment OPTION A) — design

Status: repository design for the implementation in `deploy/pr11-phase4/`. Nothing here authorizes a live run. `F1U_LIVE_EXECUTED=NO`.

## 1. Why a new stage

PR #342 added Core runtime code (the `ALERT_ACCEPTED` ingress audit). Production truth from merged receipts: `/opt/aegis-idea3/current` -> `c2238375…` (F1r), the running Core is the older process started from `55c7d181…`, and the F1 detector D1 runs from `c223…` (`WorkingDirectory` is resolved at start). Neither `c223…` nor the running Core carries #342. F1u is a NEW governed successor stage; L8p, the F1i/F1r live attempts and F1 attempt #2 are consumed and are never rerun.

## 2. Architecture audit: the Core restart and the detector (decision record)

`aegis-idea3-detector.service` has `Requires=aegis-idea3-core.service` and `After=`; the unit has no `BindsTo=`/`PartOf=`. By systemd.unit(5), a unit with `Requires=X` is stopped or restarted when X is explicitly stopped or restarted: a normal `systemctl restart aegis-idea3-core.service` queues a restart job for the active detector. So the same detector PID cannot be preserved by the normal restart.

1. First audit result (superseded): preservation was achievable only with `--job-mode=ignore-dependencies`.
2. **Owner decision — OPTION A (authoritative):** do NOT bypass the dependency, do NOT edit `Requires=`/`After=`, do NOT add a drop-in. F1u owns and accepts the detector lifecycle consequence of the one Core restart: D1 stops, the Core stops, the Core starts from the NEW release, the detector starts again (D2). `F1U_DETECTOR_LIFECYCLE_AMENDMENT=OPTION_A`, `F1U_DETECTOR_DEPENDENCY_CYCLE_OWNER_APPROVED=YES`. This is not an F1 replay, a second F1 attempt, a detector code/unit deployment or a hidden repair.

Residual operational note: while the Core socket is gone the detector is stopped as well (it does not run during the restart window); a detector that does not come back fails the stage closed (a `try-restart` never starts an inactive unit, and F1u never issues a detector command), which escalates to the owner.

## 3. Ownership

A successful F1u owns ONLY: install one new immutable release (reviewed installer, once); atomically switch `current` from the exact frozen OLD target to the exact frozen NEW target; restart `aegis-idea3-core.service` exactly once (normal systemd semantics); verify the restarted Core runs from the NEW release; prove the detector lifecycle that systemd imposes. It never mutates `production_detector.py`, the detector unit or service, `core.env`, credentials, groups, drop-ins, tmpfiles, firewall, nftables, network, Wi-Fi/AP, broker, MQTT PKI, IDEA1, IDEA2, an ESP32, incidents, the audit DB or Recovery state. L7u's Recovery and alert surfaces are PRESERVED pre-existing state. No alert is generated, no R1 attempt is opened, no Recovery runs.

## 4. Release

The existing builder/guard/installer; no second release format. The release must prove: exact release id and source SHA, clean tree, guard PASS (root-owned), `RELEASE-SHA256SUMS`, `aegis_soc/recovery_core.py` equal to a pinned digest and carrying `ALERT_ACCEPTED`, and `aegis_soc/production_detector.py` byte-identical to the pinned reviewed digest (`a91bcfc2…`, unchanged by this PR). The runner additionally proves every listed `aegis_soc/` file equals the pinned commit's blob.

## 5. Lifecycle contract

PRE (D1): loaded, active/running, `MainPID>0`, `NRestarts` 0 (sanity), disabled, `Restart=no`, no drop-in, exactly one process, reviewed unit digest, pinned source digest, runs from the OLD release. Core P1 active/running, `NRestarts` 0.

POST (D2): active/running, `D2 != D1`, newer `ExecMainStartTimestamp` and monotonic start (never before the Core's start), a changed `InvocationID` when systemd reports one, identical unit bytes and source bytes, disabled, `Restart=no`, exactly one process, cwd = NEW release, stable across two reads and unchanged again at `verify`. Core P2 `!= P1`, `Result=success`, cwd = NEW release (the pointer alone proves nothing), Recovery/alert sockets exact owner/group/mode and held by the Core process (read-only `/proc` proof, nothing connects), `AEGIS_ALERT_SOURCE_UID` contract in `core.env` and in the running Core. `NRestarts` is never lifecycle evidence.

Backend: `systemctl show` of the two units and exactly `systemctl restart aegis-idea3-core.service` (one invocation per process, journaled before the call). No detector start/stop/restart, no job mode, no other verb.

## 6. Attempt boundary

Inert unpinned runner -> read-only gates -> PRE capture -> re-prove -> `F1U-ATTEMPT-CONSUMED` (atomic) -> apply -> verify -> POST capture -> comparator -> secret scan. No retry after the marker. Fresh same-day `authorization-F1u.txt` + `k3-F1u.txt` (`stage=F1u`, no extra field); historical F1/F1i/F1r records and markers neither authorize nor block F1u.

## 7. Comparator

PRE->POST allows: `current` target, Core `MainPID`/`ExecMainStartTimestamp`, detector `MainPID`/`ExecMainStartTimestamp`, exactly one new release catalog entry (relational, `stage F1u`, plus a runner value gate). Everything else captured must be identical, including the detector unit file digest, `UnitFileState`, state and `Result`, `NRestarts`, `core.env`, sockets, groups, units and listeners. The shared L0 capture now records the detector unit (state and unit file). PRE->RB allows only the same four identity keys.

## 8. Rollback

Before the restart: restore `current` NEW -> OLD, remove ONLY the owned release (journaled tree digest re-proved; never a foreign or unproven one), D1 untouched and re-proved. After the restart: restore `current`, ONE more restart of the Core onto the OLD current release, the detector cycles again (D1 -> D2 -> D3) and is accepted only with the same code/unit proofs and on the OLD runtime, then the owned release is removed. Unknown or foreign state refuses; an unexplained detector escalates; no retry; the rolled-back Core runs the OLD current release, not necessarily the pre-F1u process image.

## 9. Claim boundary

`F1U_REPOSITORY_IMPLEMENTED=YES`, `F1U_LIVE_EXECUTED=NO`, `F1U_PRODUCTION_DEPLOYED=NO`; `R1A_REPOSITORY_IMPLEMENTED=NO`, `R1A_LIVE_EXECUTED=NO`; `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, `RECOVERY_R1_R8_PROVEN=NO`. A successful future F1u still states all of these plus `RECOVERY_R2_R8_EXECUTED=NO`, `LVR_PROVEN=NO`, `L8_ACCEPTANCE=NO`, `L9_PROVEN=NO`.

Context only (not implemented): independent R1A discovery found the `AEGIS_NEWCONN` firewall-log producer is not proven deployed; R1A needs a separate read-only host preflight after F1u and, if absent, a separately governed instrumentation stage.
