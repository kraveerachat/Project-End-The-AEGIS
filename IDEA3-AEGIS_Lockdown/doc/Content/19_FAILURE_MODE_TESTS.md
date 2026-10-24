# 19 — IDEA3 Failure-Mode Tests (lab results)

Status: A1 done 2026-10-24 (one finding, fix drafted); A2 pending. Same lab as `17_LIVE_LAB_RUNBOOK.md` and
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

## A2 — power loss of the ESP32

PENDING. Not run. To record: relay state while unpowered, boot state and time to LOCKDOWN after power returns, reconnect time, and whether a
RESTORE is accepted afterwards (the fix above matters here).
