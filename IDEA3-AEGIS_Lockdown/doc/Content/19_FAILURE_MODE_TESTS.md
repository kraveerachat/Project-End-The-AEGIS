# 19 — IDEA3 Failure-Mode Tests (lab results)

Status: A1 and A2 done 2026-10-24 (findings F-A1-1, with its fix verified on hardware by A2, and F-A2-1, fix proposed, not implemented). Same lab as `17_LIVE_LAB_RUNBOOK.md` and
`18_LIVE_LAB_ACCEPTANCE_SUMMARY.md`: Core, TLS broker and the ESP32 on the Core-local AP, `main` `cc096de` plus the
commits of `feat/idea3-graduated-response` (tip `755046b`), graduated response OFF. Times are UTC+7. The raw excerpts
(Core log, audit and command rows, broker lifecycle) are kept in the lab work directory and are not in the repository. This file
holds no secrets, device identifiers or credentials.

## A1 — Core frozen with SIGSTOP, then resumed

Method: the operator froze the running Core process with `SIGSTOP`, let the ESP32 reach its dead-man's switch, resumed the Core with
`SIGCONT` about 1–2 minutes later, and then pressed RESTORE on the control Desktop. The device was not touched and the ESP32 was not
unplugged.

| Observation | Result | Source |
|---|---|---|
| ESP32 dead-man's switch | cut **47.21 s** after the freeze (limit: 60 s from the last heartbeat) | operator measurement |
| Relay after the Core resumed | stayed in LOCKDOWN for more than a minute; **no automatic restore** | operator observation, Core log |
| Broker | dropped the Core client for keepalive at **09:00:18** (Core keepalive 60 s; last Core ping 08:58:18) | broker log |
| Core | reconnected by itself at **09:01:01** (CONNACK accepted) | broker log, Core log |
| Statuses queued during the freeze | **2** device statuses rejected by the Core as `stage=SKEW code=STALE kind=STATUS` at 09:01:00 | Core log, audit database |
| Device session | never dropped (only the Core's client appears in the broker lifecycle log) | broker log |
| After the resume | one fresh `LOCKDOWN` status every 30 s from 09:01:08; broker CONNECTED; time trust SYNCED; one established TLS session each for the Core and the ESP32 | Core log, status file, socket list |

Fail-secure result: PASS. The relay opened by the device's own timer, nothing restored it, the Core recovered its broker session without
help, and old statuses were refused instead of trusted.

### Finding F-A1-1 — RESTORE refused with `RESTORE_ALREADY_PENDING` after an uncommanded lockdown

- **Symptom:** after the Core resumed, the Desktop RESTORE was refused (`RESTORE_REFUSED code=RESTORE_ALREADY_PENDING` at 09:15:25 and
  09:16:31). No command was ever issued: the last row in the command table is `seq 12`, the confirmed RESTORE of 08:41:35 (ACK
  ACCEPTED, status correlated), and there is no `seq 13`. There is therefore no device ACK, status, nonce, sequence or HMAC result to
  explain the refusal; it was decided inside the Core.
- **Cause (identical in `main` `cc096de` and the branch):** `aegis_soc/local_restore.py:492-494` (normal RESTORE) and `:597-599` (break-glass)
  refuse when the Core's record of its last command has `action == RESTORE_UPLINK` and `acknowledged_at` set. The guard never looks at
  `physical_confirmed_at`. The record is created for every command that is sent (`aegis_soc/supervisor.py:442`) and is replaced only by
  the next command that is sent, or lost when the Core restarts; nothing clears it when the device confirms. After the confirmed RESTORE of
  08:41 the record stayed in place, so the dead-man lockdown (a lockdown the Core did not command) left `uplink=LOCKDOWN` together with a stale
  RESTORE record.
- **Impact:** after any confirmed RESTORE, a lockdown the Core did not command (dead-man's switch, power loss, a frozen Core) cannot be
  restored from the Desktop or the CLI until a CUT replaces the record or the Core restarts. It never expires. The failure is on the fail-secure
  side (the relay stays open); it is an availability problem, not a bypass.
- **Workaround on an unfixed Core:** CUT from the Desktop (accepted while already in LOCKDOWN; it replaces the record), then RESTORE; or restart
  the Core (a restart issues no RESTORE; the device stays in LOCKDOWN until the operator restores).
- **Fix:** branch `fix/idea3-restore-after-uncommanded-lockdown`, commit `a247718`, from `main` `cc096de`; local only, not pushed, not yet reviewed.
  A RESTORE is pending only while it is ACKed and not yet physically confirmed; regression tests for both call sites fail on `main` and pass on
  the branch, and the guard's original cases stay refused. It needs owner review because it changes Core code.
- **Not the same as the case seen on 2026-10-23 (G6):** that `RESTORE_ALREADY_PENDING` followed a RESTORE that was ACKed but never confirmed (the
  device lost power before its status arrived). The fix deliberately still refuses that case; whether such a record should expire is an open owner decision.

### Not observed

- The Desktop's own STALE indication during the freeze: the screenshots were taken after the Core had resumed, so what the window shows while the
  Core is frozen is not recorded.

### Desktop STALE behaviour (checked by test, 2026-10-24)

After A1 the question was what the Purple Desktop shows when `status.json` stops being rewritten, as during the freeze. Checked in code and by tests
(`tests/test_live_purple_control_desktop.py`, stale section):

- **Threshold:** the Desktop calls the Core evidence **STALE when `updated_at` is more than 120 s old** (`observer.DEFAULT_MAX_AGE_SECONDS = 120.0`, `age > 120.0`;
  exactly 120.0 s is still fresh; a timestamp from the future is never fresh). It re-reads the file every **2 s** (`EVIDENCE_POLL_MS`), so STALE appears within
  about 122 s of the Core's last write. The A1 freeze lasted about one to two minutes, so it may never have crossed 120 s: that alone can explain why no STALE indication was seen.
- **Already correct:** the Overview "Evidence freshness" fact goes FRESH -> STALE -> FRESH as the file ages and resumes, and the header badges and metrics go UNKNOWN.
- **Gap 1 (fixed):** the Devices and Lockdown pages are built once from the evidence at the moment they are shown. A page that was open when the Core stopped updating kept
  showing the last uplink and device state as if it were current while only the header badges changed. The base class now rebuilds an open Devices or Lockdown page when the
  evidence it shows changes (the changing timestamp is not part of that comparison, so there is no flicker while the Core is healthy).
- **Gap 2 (fixed):** the severity panel read `graduated-status.json` with no freshness check at all. That file is written only when a decision is made, so its own age says nothing
  about whether the Core is alive. The panel now puts a "Core evidence: STALE (or MISSING, INVALID, ...) — the Core is not updating: the data below is the last known state and may be
  out of date" row first whenever `status.json` is not FRESH; the last decisions stay visible, marked. The wording follows the language selector and the freshness code is not translated.
- **Evidence:** 7 of the new tests fail on the code without the fix and pass with it; the threshold, poll interval and Overview behaviour tests pass either way.
- **Not covered:** no screenshot of the real window during a freeze; the check is by test with a synthetic `status.json`.

## A2 — power loss of the ESP32

Run 2026-10-24 on the Core started at 18:49 from `feat/idea3-graduated-response` (it includes the F-A1-1 fix as `16b7565`), graduated response OFF. The device
had been restored from the Desktop at 19:01:06 (seq 16, ACK OK, STATUS NORMAL carrying the command) and was then unplugged (USB) by the operator.
Times are from the broker and Core logs unless marked operator-reported.

| Time | Event | Source |
|---|---|---|
| 19:01:12 | Last authenticated device status: `state=NORMAL (PERIODIC)` | Core log |
| 19:01:27 | Last PINGREQ from the device. The unplug is therefore at about 19:01:30 (the operator said "about 19:00") | broker log |
| 19:01:50 | `aegis-relay-01 disconnected: exceeded timeout` (keepalive; not a socket error) | broker log |
| about 19:01:57 | Core `state` becomes DEGRADED: no device message for more than `DEVICE_OFFLINE_SEC` = 45 s (`mqtt_client.py:311-314`, `supervisor.py:1082-1084`). Seen as DEGRADED at 19:04:32 | code, status.json |
| 19:01:50 to 19:09:30 | No reconnect. `status.json` kept `device=ONLINE`, `uplink=NORMAL` throughout (finding F-A2-1) | status.json (19:04:32); operator-reported Desktop |
| 19:09:30 | Device reconnects: TLS connection from the lab address; MQTT session as the device client at 19:09:32 | broker log |
| 19:09:32 | First authenticated status after boot: `state=LOCKDOWN (BOOT)`, so the relay boots open | Core log |
| 19:09:55 | Periodic status `LOCKDOWN` | Core log |
| 19:10:23 | One RESTORE from the Desktop, no CUT first: `RESTORE_REQUESTED`, `COMMAND_SENT RESTORE_UPLINK seq=17`, `ACK_RECEIVED OK` at 19:10:23.233, `STATUS_AUTHENTICATED state=NORMAL (COMMAND)` at 19:10:23.239 (the status that carries the command's nonce) | Core log |
| 19:10:25 | Periodic status `NORMAL`; `status.json` state=RUNNING, device=ONLINE, uplink=NORMAL | Core log, status.json |

Results:
- **Dead-man behaviour on power loss:** the broker dropped the device 23 s after its last ping (keepalive 15 s, 1.5 times the interval). Time from power loss to a
  Core `DEGRADED` state: about 27 s after the last status, 45 s after the last device message.
- **Boot state:** LOCKDOWN (BOOT) at 19:09:32, two seconds after the MQTT session, before any command.
- **RESTORE after power loss, no CUT first:** accepted (ACK OK, STATUS NORMAL with the command's nonce). This is the F-A1-1 case (lockdown the Core did not command after a
  confirmed RESTORE); on the Core running `16b7565` it no longer needs the CUT-then-RESTORE workaround. This is the first hardware confirmation of the fix (matrix row RC-03).
- **Not recorded:** the relay state while unpowered (meter or tester), and the time from reconnect to the first RESTORE button press as seen by the operator.

### Finding F-A2-1 — `device` and `uplink` never leave ONLINE and the last value after the device is lost

- **Symptom:** from about 19:01:57 to 19:09:30 the Desktop showed `ESP32: ONLINE` (and uplink NORMAL) although the broker had dropped the device at 19:01:50, the
  ARP entry was FAILED and the AP station was idle for minutes. The Core's overall `state` was correctly DEGRADED.
- **Cause:** `aegis_soc/supervisor.py:544` (`_handle_status`) sets `self.status.device = "ONLINE"` on every authenticated status and is the only place in the
  supervisor and runtime code that assigns `device`. Nothing sets `OFFLINE` (the value is allowed by `runtime.py:329` and `status_projection.py:31`). The
  45 s rule (`mqtt_client.py:311-314`) is used only to choose the overall `state` (`supervisor.py:1082-1084`). `uplink` is set only from device statuses
  (`supervisor.py:545-546`), so it keeps the last reported value. The Desktop ESP32 badge shows `status.json` `device` as it is
  (`tools/live_purple_observer.py:188` and `:215`); the Task-B STALE rule covers only the age of the file, which the Core keeps rewriting.
- **Impact:** after a power loss, cable pull or a crash of the device, the operator sees a healthy badge and a stale uplink for as long as the Core runs, and the
  projections built from `status.json` (Web, sidecar, `ESP32_UNAVAILABLE` issue in `runtime.py:416`) inherit it. Fail-secure behaviour is not affected: the
  relay itself opens by the dead-man's switch and the Core's overall `state` shows DEGRADED. It is a display and evidence-accuracy problem, not a bypass.
- **Proposed fix (not implemented, needs review because it is Core code):** in the Core's health/status write path, derive `components.device` from
  `mqtt.device_online()` (`OFFLINE` when no device message for more than `DEVICE_OFFLINE_SEC`, `ONLINE` again on the next authenticated status), and report
  `uplink` as `UNKNOWN` while the device is OFFLINE, with the last known value kept in a separate field if needed. Tests: device silent for 46 s gives `OFFLINE` in
  `status.json` and the Desktop badge; a new status restores `ONLINE`; boundary at exactly 45 s; `uplink` handling; the projection tests that allow
  `OFFLINE` keep passing; no change to command or RESTORE paths.
- **Workaround:** read the overall `state` (DEGRADED) and the Core log (`STATUS_AUTHENTICATED` age), not the ESP32 badge.
