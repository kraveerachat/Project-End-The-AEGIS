---
title: Task Receipt — Issue #186 Twingate persistence + IDEA2 Tunnel recovery
date: 2026-09-23T16:27:00+07:00
owner: kittipat
area: idea3
branch: docs/idea3-pr11-issue186-recovery-closeout
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Issue #186 Twingate persistence + IDEA2 Tunnel recovery

> This is an append-only recovery evidence log, not the immutable final
> receipt. `FINAL_RECEIPT_CREATED=NO`.

## Purpose / scope

Document, read-only-verified where possible, the full Issue #186 post-merge
recovery chain following GitHub PR #184's merge: the 13:37 operator
incident, the pre-authorization Twingate start, the Detection Tunnel
restart-loop and self-recovery, revised owner authorization, the single
authorized `systemctl enable twingate.service` mutation, and the formal
acceptance window. This log does not modify Production, systemd, Twingate,
Detection Engine, Detection Tunnel, firewall/routes, or GitHub.

## Issue #186 references

- GitHub Issue #186: "PR11 Post-Merge Recovery — Twingate Persistence +
  IDEA2 Tunnel Recovery" (`kraveerachat/Project-End-The-AEGIS`), open at the
  time of this log.
- GitHub PR #184 ("feat(idea3): complete live IDEA1 and IDEA2 visibility"),
  merged `e61e76ac` before this issue was opened.

## Authorization chronology (verified via `gh api` against Issue #186 comments)

1. Pub (`pubpup2006p-design`): `IDEA2_TUNNEL_RECOVERY_AUTH=APPROVED`
   (original scope).
2. Kla (`kraveerachat`, OWNER): `KLA_INFRA_AUTH=APPROVED`,
   `K3_NON_OVERLAP=APPROVED`, `IDEA1_WINDOW_OVERLAP=NONE`, original
   authorized window 2026-09-23 15:35-16:35 +07, original scope R1-R7
   (start Twingate, verify, enable persistence, exactly one controlled
   Tunnel restart, fresh 15-minute MODEL_D observation).
3. Reconciliation request (`Kittipat050871`): reported that runtime state
   had changed before the authorized window — Twingate already
   active/online (started pre-authorization), path recovery proven, Tunnel
   self-recovery proven, Engine unchanged — and requested a revised scope
   with no controlled Tunnel restart.
4. Kla: `REVISED_RECOVERY_SCOPE=APPROVED`,
   `CONTROLLED_TUNNEL_RESTART_REQUIRED=NO`,
   `ACCEPTANCE_BOUNDARY=POST_TWINGATE_ENABLE_PRESERVATION_PLUS_15M_STABILITY`.
5. Pub: `IDEA2_NO_RESTART_RECOVERY_SCOPE=APPROVED`,
   `CONTROLLED_TUNNEL_RESTART_REQUIRED=NO`.

This revised authorization replaced, and is the only authorization acted on
for, the Production mutation described below.

## Incident chronology

1. PR #184 merged (`e61e76ac`).
2. Post-merge recovery tracked as Issue #186.
3. ~2026-09-23 13:37 +07: operator command-entry incident. `
   aegis-detection-engine.service` and `aegis-detection-tunnel.service`
   were administratively restarted; `twingate.service` was not started or
   enabled by this incident. **Historical incident evidence only — never
   reused as acceptance evidence.**
4. A later boot occurred: `CURRENT_BOOT_ID=c26bb08e-2776-4f27-a109-04aedd5a323d`,
   boot start ≈2026-09-23 14:54:48 +07 (workstation `archlinux`,
   Acer Nitro ANV15-51 — independently confirmed as the correct host by
   matching MainPID/NRestarts/start-timestamp evidence against the task's
   known baseline).
5. ~14:57:29 +07: operator manually ran `sudo systemctl start
   twingate.service`, **before** fresh Issue #186 authorization existed.
   Provenance confirmed via journal: `sudo[2960]: kittipat ... COMMAND=
   /usr/bin/systemctl start twingate.service`, immediately followed by
   `systemd[1]: Started Twingate Remote Access Client.`
   `PRE_AUTH_TWINGATE_RUNTIME_START=HISTORICAL_EVIDENCE_ONLY`.
6. Twingate reached Online; `sdwan0` appeared; overlay route to
   `192.168.10.10` appeared. The remote path initially remained
   unreachable and `aegis-detection-tunnel.service` entered/continued its
   `Restart=always` loop (NRestarts climbed from 3 at first observation up
   through 14).
7. Targeted read-only diagnosis (Python raw-socket probes, no SSH/auth):
   `TCP_22=UNREACHABLE`, `TCP_80=UNREACHABLE`, `TCP_443=UNREACHABLE`
   (5s timeouts). `ROOT_CAUSE_PROVEN=NO`; classification
   `REMOTE_NETWORK_OR_CONNECTOR_PATH_SUSPECTED` — both the SSH-only and
   the HTTP-only Twingate resources failed identically, and Twingate's own
   `authorize_flow` log entries showed policy-authorized flows to
   `192.168.10.10:22` that never reached a connected state (SUSPEND →
   TIMEOUT/CANCEL, repeatedly), which argues against an SSH-specific
   auth/config fault.
8. The remote path later recovered: a subsequent recheck showed
   `TCP_22/80/443=REACHABLE`, `:18002` listening, and Monitor `/healthz`
   returning a genuine application-layer response.
9. `aegis-detection-tunnel.service` self-recovered automatically via its
   existing `Restart=always`/`RestartSec=5` policy at 15:17:57 +07
   (NRestarts=14). **No controlled manual Tunnel restart was performed by
   any session.**
10. A bounded, diagnostic-only 15-minute pre-authorization stability
    observation (2026-09-23T15:29:31+07:00 →
    2026-09-23T15:44:38+07:00, 907s) showed Twingate/Engine/Tunnel all
    stable (unchanged PID/NRestarts) and Monitor forward stable. This was
    explicitly **not** the formal acceptance boundary.

## Exact authorized mutation

```text
sudo systemctl enable twingate.service        # WITHOUT --now
```

Performed manually by the operator (not by any automated session — the
harness's own auto-mode permission classifier blocked an in-session attempt
to run this command, citing "Unauthorized Persistence"). Reported result,
independently confirmed read-only in-session via `systemctl is-enabled` and
`ls -l`:

```text
Created symlink '/etc/systemd/system/multi-user.target.wants/twingate.service'
  -> '/usr/lib/systemd/system/twingate.service'
```

No other Production mutation (no service start/stop/restart, no
firewall/route change, no Twingate credential/policy/configuration change,
no reboot) was performed by this recovery.

## Pre/post preservation evidence

```text
POST_ENABLE_PRESERVATION=PASS

                PRE (2026-09-23T15:52:10+07:00)   POST (2026-09-23T16:00:31+07:00)
Twingate PID    2972                               2972
Twingate NRes.  0                                  0
Twingate UFS    disabled                           enabled
Engine PID      868                                868
Engine NRes.    0                                  0
Tunnel PID      7821                                7821
Tunnel NRes.    14                                  14
```

Twingate remained online, `sdwan0`/overlay route remained present, `:8077`
and `:18002` remained listening, Engine `/health` and Monitor `/healthz`
remained healthy across the enable.

## Formal-window evidence

```text
FORMAL_START_TS = 2026-09-23T16:00:31+07:00
FORMAL_FINAL_TS = 2026-09-23T16:16:09+07:00
FORMAL_OBSERVATION_SECONDS = 938

Twingate:  PID=2972  NRestarts=0  UnitFileState=enabled  status=online (unchanged)
Engine:    PID=868   NRestarts=0  (unchanged)
Tunnel:    PID=7821  NRestarts=14 (unchanged)

LISTEN_8077_FINAL=YES
LISTEN_18002_FINAL=YES
ENGINE_HEALTH_FINAL=OK  ({"status":"idle",...})
MONITOR_HEALTHZ_FINAL=OK  ({"service":"aegis-monitor","ok":true,"db":"postgres"})
SDWAN0_FINAL=present/up
OVERLAY_ROUTE_FINAL=present
```

`journalctl --since "$FORMAL_START_TS"` for both
`aegis-detection-engine.service` and `aegis-detection-tunnel.service`
returned no entries at all for the full formal window (no lifecycle
events). Twingate's own journal in the window showed only routine
notification-channel warnings and token-refresh cycles, none coincident
with any PID/NRestarts change.

## Acceptance result

```text
POST_ENABLE_PRESERVATION=PASS
FORMAL_ACCEPTANCE=PASS
LIVE_ACCEPTANCE=PROVEN
```

`LIVE_ACCEPTANCE=PROVEN` is scoped exactly to the revised, owner-authorized
acceptance boundary
(`POST_TWINGATE_ENABLE_PRESERVATION_PLUS_15M_STABILITY`). It is not a claim
that the originally planned controlled-Tunnel-restart model was executed or
passed.

## Explicit non-actions

- `CONTROLLED_TUNNEL_RESTART_PERFORMED=NO`
- `DETECTION_ENGINE_LIFECYCLE_ACTION_PERFORMED=NO`
- No firewall, route, Twingate credential/policy/configuration, or SSH
  configuration change was made.
- No reboot was performed.
- `repair_systemd.sh` was not run.
- Issue #186 was not closed and no comment was posted to it from this
  documentation task.

## Verification evidence

- `gh api repos/kraveerachat/Project-End-The-AEGIS/issues/186/comments` —
  pass: independently confirmed the Kla/Pub authorization chain quoted
  above, before any mutation was attempted.
- `journalctl -b -u twingate.service --since "2026-09-23 14:56:30" --until
  "2026-09-23 14:58:30"` plus a `sudo|systemctl` grep over the same window
  — pass: proved the pre-authorization manual Twingate start.
- `python3` raw-socket probes to `192.168.10.10:{22,80,443}` — pass (both
  the initial UNREACHABLE and the later REACHABLE readings) — established
  the remote-path timeline without using SSH or sending application
  payloads.
- `systemctl show` / `curl .../health` / `curl .../healthz` / `ss -lnt`
  snapshots at PRE, POST_ENABLE, and FORMAL_FINAL timestamps — pass: basis
  for the preservation and formal-acceptance tables above.
- `journalctl --since "$FORMAL_START_TS"` for Engine and Tunnel units —
  pass: zero entries, i.e. no lifecycle event in the formal window.

## Canonical notes updated

- `idea3/idea3-status.md` — added "IDEA3 PR11 Issue #186 Post-Merge
  Recovery Closeout — 2026-09-23" section recording this chronology and
  the canonical status block.

## Shared surfaces touched

- `idea3/idea3-status.md` — cross-references Twingate/IDEA2 Detection
  Tunnel state; IDEA2 owner review is recommended before this is folded
  into `idea2-status.md` in a future checkpoint (not done in this task).

## Integration requests

- IDEA2 owner (Pub): review whether `idea2-status.md` should independently
  record the Detection Tunnel's restart-loop/self-recovery history and the
  current `NRestarts=14` baseline going forward.
- Owner (Kittipat / Kla): explicit authorization required before (a) a
  final receipt is created for this recovery, and (b) Issue #186 is
  commented on or closed.

## Known limitations

- Remote-side (Beelink/Core host) corroboration was attempted but could
  not be performed — this session has no SSH/console/credential access to
  `192.168.10.10`, and SSH to it was the very path under investigation.
  All evidence above is workstation-side only, cross-checked against
  Twingate's own per-flow authorization logs and application-layer health
  responses (Monitor `/healthz`, Engine `/health`).
- `ROOT_CAUSE_PROVEN=NO` for the earlier TCP/22/80/443 unreachability — the
  remote path recovered before a definitive root cause was established
  from this workstation alone.
- `idea2-status.md` was not updated by this task (see "Integration
  requests" above).
- `FINAL_RECEIPT_CREATED=NO` — pending separate, explicit owner
  authorization.
