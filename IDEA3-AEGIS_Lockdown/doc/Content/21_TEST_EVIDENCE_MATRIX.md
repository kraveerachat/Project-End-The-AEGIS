# 21 — Test Evidence Matrix for report section 4.5

Status: filled from docs 16–19, the lab evidence files and the results of 2026-10-23 and 2026-10-24. Facts only: a row is PASS only where evidence exists, and the evidence column says where. Owner observations are marked "owner-reported" where no log was kept.

> The subsection titles are the report's own 4.5.1–4.5.10 headings. Every row keeps its stable ID. 4.5.9 and 4.5.10 hold no test rows: they list the current limitations and summarise the result.

**Statuses:** PASS = the expected result was observed and the evidence is named. FINDING = something was observed that differs from the expectation, or a gap was found (the cell says what happened and what was done). PENDING = not run, not recorded, or only checked offline where a lab or hardware result is needed.

**Evidence locations:** `lab evidence/` is the lab work directory on the test laptop (not in the repository). `doc N` is `doc/Content/NN_*.md`. Test files are under `tests/`.

## Summary

| Section | Topic | Rows | PASS | FINDING | PENDING |
|---|---|---|---|---|---|
| 4.5.1 | Threat Scenario Tests | 4 | 0 | 0 | 4 |
| 4.5.2 | Authentication / Authorization Tests | 3 | 2 | 0 | 1 |
| 4.5.3 | Negative / Rejection Tests | 5 | 5 | 0 | 0 |
| 4.5.4 | Security Mechanism Verification | 8 | 7 | 1 | 0 |
| 4.5.5 | Detection / Containment Tests | 5 | 3 | 1 | 1 |
| 4.5.6 | Recovery Tests | 7 | 4 | 2 | 1 |
| 4.5.7 | Hardware / Runtime Acceptance | 20 | 13 | 5 | 2 |
| 4.5.8 | Failure-mode Tests | 9 | 6 | 2 | 1 |
| 4.5.9 | Current Limitations | 0 | 0 | 0 | 0 |
| 4.5.10 | IDEA 3 Result Summary | 0 | 0 | 0 | 0 |
| | **Total** | **61** | **40** | **11** | **10** |

## 4.5.1 Threat Scenario Tests

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| GR-01 | Port scan from a second device -> MEDIUM, address blocked, relay unchanged | MEDIUM, block, Telegram MEDIUM | Not reported as run | doc 16 (scenario 1) | PENDING |
| GR-02 | Scans from three addresses -> HIGH, CUT recommended, relay unchanged | HIGH, recommendation shown, relay unchanged | Not reported as run | doc 16 (scenario 2) | PENDING |
| GR-03 | CRITICAL with corroboration -> one automatic CUT | auto-CUT once per episode, tester pin 2 open | Not run; not producible in the current lab design (no sshd, no password account), so it stays offline-only for now | doc 16 (scenario 3) | PENDING |
| GR-08 | Web display of the graduated response (Lockdown, Dashboard, Alerts, Incidents) | allowlisted, bounded, display only | Offline only: 61 Python and 987 web tests pass; not run against a live Core and Web together | branch feat/idea3-web-graduated; doc 16 (Web display) | PENDING |

## 4.5.2 Authentication / Authorization Tests

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| AU-01 | A wrong RESTORE secret is refused and nothing is sent | RESTORE_REFUSED, no command | 23:36:30 and 08:38:48: RESTORE_REFUSED code=AUTH_FAILED; no command followed until the later correct request | lab logs/aegis_soc.log; audit database | PASS |
| AU-02 | Repeated wrong secrets lock the gate out (live) | lockout after the configured failures | Not run on the lab | — | PENDING |
| AU-03 | Authentication, confirmation word, reason bounds and lockout (offline) | all refused as specified | Offline tests pass: tests/test_local_restore.py and tests/test_core_break_glass.py | tests/test_local_restore.py, tests/test_core_break_glass.py | PASS |

## 4.5.3 Negative / Rejection Tests

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| DT-01 | Forged log lines (logger, 10 times, as a normal user) are ignored | no alert, no level change | Ignored | owner-reported 2026-10-24; the terminal output was not archived | PASS |
| DT-02 | The detector trusts only kernel records and sshd records from root (offline) | look-alike lines ignored | Offline tests pass: tests/test_graduated_response_core.py | tests/test_graduated_response_core.py | PASS |
| DT-03 | A v2 alert with an unknown kind, version or key is refused (offline) | refused | Offline tests pass: tests/test_graduated_response_core.py, tests/test_core_alert_ingress.py | tests/test_graduated_response_core.py | PASS |
| FZ-05 | Statuses queued during the freeze are not trusted | rejected as stale | 2 statuses rejected: stage=SKEW code=STALE at 09:01:00 | lab evidence/a1-restore-pending/audit-window-0855-0925.txt | PASS |
| OP-05 | CUT while the device is already in LOCKDOWN | accepted, no state change, no Telegram | 23:49:50: ACK OK, status LOCKDOWN, no transition, no Telegram message | lab logs/aegis_soc.log; lab evidence/acceptance.md | PASS |

## 4.5.4 Security Mechanism Verification

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| IS-01 | Secret paths hidden inside the containment helper and the detector unit | 19 of 19 hidden in each unit | 19/19 hidden | owner-reported 2026-10-24 (setup output not archived); check in setup-graduated.sh | PASS |
| IS-02 | The isolation check itself, exercised on a sandboxed test unit | paths that exist on the host come out hidden; normal paths readable | Lab secrets, cut.sock, /opt/aegis-idea3, the SSH host key and /etc/shadow hidden; /etc/hostname and /usr/bin/nft readable | offline probe of 2026-10-24, not archived | PASS |
| IS-03 | Setup rolls back on every failure (offline) | teardown runs on die, command failure, SIGINT, SIGTERM; refuses a changed teardown | All cases behave as specified in the trap tests | offline test of the trap block, 2026-10-24, not archived | PASS |
| IS-04 | Setup preflight on the real host | reaches the end | Exited silently once at preflight: a unit status check returned non-zero under pipefail. Cause found, explicit errors and a diagnostic trap added (revision 3.1) | review/setup-graduated.sh revision history | FINDING |
| GR-04 | RESTORE is never automatic after a recommendation or an automatic CUT | operator RESTORE with the secret only | Offline tests pass; no automatic RESTORE seen in any lab run | tests/test_graduated_response.py, tests/test_graduated_response_core.py | PASS |
| GR-05 | Policy and Core wiring (offline) | levels, caps, corroboration, one auto-CUT per episode | Offline tests pass: tests/test_graduated_response_core.py with tests/test_core_alert_ingress.py, 118 passed | tests/test_graduated_response*.py | PASS |
| GR-06 | A blocked source is dropped before the log rule can see it | block table evaluated first (priority -50 against 0) | Setup aborts unless the kernel confirms the order; setup completed on the lab | setup-graduated.sh; owner-reported | PASS |
| NT-06 | A failed send names only the exception type and status, never the token or chat id (offline) | no secret in the message | Offline tests pass: tests/test_comms.py | tests/test_comms.py | PASS |

## 4.5.5 Detection / Containment Tests

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| OP-01 | CUT from the base Purple Desktop | ACK, STATUS LOCKDOWN with the command nonce | ACK 21:04:42, STATUS LOCKDOWN, nonce matched, Core uplink LOCKDOWN | doc 18 (G6); lab evidence/acceptance.md | PASS |
| OP-03 | CUT from the control Desktop | ACK OK, STATUS LOCKDOWN | 23:12:22.961 sent, ACK 23:12:23.039, STATUS LOCKDOWN 23:12:23.047 (also 23:34:50 and 08:38:31) | lab logs/aegis_soc.log; doc 18 (Phase B) | PASS |
| OP-07 | CUT and RESTORE timing | command-to-relay time measured | Protocol round trip is in the Core log (CUT sent to ACK 49 to 147 ms over four CUTs; RESTORE 23 to 205 ms over four RESTOREs); the time to the physical change was not measured | lab logs/aegis_soc.log | PENDING |
| GR-07 | Severity panel on the control Desktop in th/en/zh | follows the language, codes untranslated | 15 pure and 13 GUI tests pass | tests/test_live_purple_control_desktop.py | PASS |
| DT-04 | Detector to Core alert path on `main` as it is | alert reaches the Core over TLS | Not supported without code changes: the detector uses plaintext MQTT on 1883, the v1 Core does not subscribe to it, the F1 ingress is production-only (G7) | lab evidence/g7-not-supported.md; doc 18 | FINDING |

## 4.5.6 Recovery Tests

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| OP-02 | RESTORE from the command line (owner-restore.sh) | PUBLISHED, ACK ACCEPTED, DEVICE_REPORTED_NORMAL | 20:26:52, 20:48:48 and 21:10:59: published, ACK accepted, STATUS NORMAL with the matching nonce | lab evidence/acceptance.md, restore-output.log | PASS |
| OP-04 | RESTORE from the control Desktop | ACK OK, STATUS NORMAL (COMMAND) | 23:13:39, 23:51:40 and 08:41:35: ACK OK, STATUS NORMAL carrying the command's nonce | lab logs/aegis_soc.log; doc 18 (Phase B) | PASS |
| OP-06 | A Core restart issues no RESTORE | device stays in LOCKDOWN until the operator restores | Core restart 23:48:34 and Core start 08:16:12: no RESTORE_UPLINK issued; the device stayed LOCKDOWN until the operator's RESTORE | lab logs/aegis_soc.log; lab data/ protocol command table | PASS |
| RC-01 | RESTORE after the dead-man lockdown that followed a confirmed RESTORE | accepted | REFUSED RESTORE_ALREADY_PENDING at 09:15:25 and 09:16:31; no command was issued. Cause: a stale record of the earlier confirmed RESTORE (local_restore.py:492-494 and 597-599). Fix on branch fix/idea3-restore-after-uncommanded-lockdown, commit a247718, not pushed; cherry-picked onto feat/idea3-graduated-response as 16b7565 so the lab Core can run it | doc 19 (F-A1-1); lab evidence/a1-restore-pending/DIAGNOSIS.md | FINDING |
| RC-02 | Workaround: CUT, then RESTORE | RESTORE accepted | Not recorded as run on the lab | — | PENDING |
| RC-03 | The fix on the lab hardware | RESTORE accepted after an uncommanded lockdown | Accepted on 2026-10-24 19:10:23 after the power loss that followed a confirmed RESTORE (A2), with no CUT first: the F-A1-1 situation, on the Core running 16b7565. Regression tests also fail on `main` and pass with the fix | doc 19 (A2); tests/test_local_restore.py, tests/test_core_break_glass.py | PASS |
| RC-04 | RESTORE after the device lost power before its status arrived (2026-10-23) | decided by design | Refused RESTORE_ALREADY_PENDING (20:25), cleared by restarting the Core, no RESTORE issued. The fix keeps refusing this case; whether such a record should expire is an open owner decision | lab evidence/acceptance.md; doc 19 | FINDING |

## 4.5.7 Hardware / Runtime Acceptance

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| PH-01 | Boot state is LOCKDOWN (pin 2 open) after power-up, original circuit | tester 1_345678 | First reading 19:50 INVALIDATED (circuit was mis-wired). Re-run on the first accepted circuit 2026-10-23 20:21: 1_345678, no ESP32 reset | lab evidence/acceptance.md; doc 18 | PASS |
| PH-02 | Boot state after the COM–NO rewire, read with the meter | A2–B2 open | Not recorded in the lab notes | — | PENDING |
| PH-03 | RESTORE -> NORMAL: A2–B2 closed (multimeter, primary reading) | closed | closed (0 ohm) at 21:02; RESTORE ACK ACCEPTED 20:48:48; owner-observed | lab evidence/acceptance.md; doc 18 (G6) | PASS |
| PH-04 | CUT -> LOCKDOWN: A2–B2 open | open | open; CUT ACK 21:04:42, STATUS LOCKDOWN with the matching nonce; owner-observed | lab evidence/acceptance.md; doc 18 (G6) | PASS |
| PH-05 | RESTORE again: A2–B2 closed | closed | closed; RESTORE ACK 21:10:59, relay clicked; owner-observed | lab evidence/acceptance.md; doc 18 (G6) | PASS |
| PH-06 | Cable tester pin 2 lights correctly after RESTORE | pin 2 on in NORMAL | Owner reports pin 2 now lights correctly after RESTORE. Earlier, through the home-made breakout, the tester did not show pin 2 (short to a neighbouring pin suspected, not confirmed) | owner-reported 2026-10-24 (no log); earlier entry in lab evidence/acceptance.md | PASS |
| PH-07 | Contact used for the protected conductor | COM–NC as documented | The relay module is energized in NORMAL: the working contact is COM–NO, NC unused; no firmware change | doc 17, doc 18; lab evidence/acceptance.md | FINDING |
| PH-08 | Control Desktop RESTORE -> A2–B2 closed | closed | closed after the 23:51:40 RESTORE; owner-observed | lab evidence/acceptance.md (Phase B) | PASS |
| PH-09 | Meter reading after a Control Desktop CUT | open | Not supplied: the 23:49:50 CUT found the device already open; no reading recorded for the 23:12:23 CUT | lab evidence/acceptance.md (Phase B) | PENDING |
| NT-01 | Bot reachable and a message is sent | HTTP 200 | getMe and sendMessage HTTP 200 at 21:44 | lab progress.md (TG-test) | PASS |
| NT-02 | LOCKDOWN message on CUT | message received | Received for the 23:12:23 CUT | doc 18 (Phase B); owner-reported | PASS |
| NT-03 | RESTORED message on RESTORE (first attempt) | message received | NOT received at 23:13:39. The send had a 3 s limit and the tether needed about 1.7 s; the cause is a delivery failure, not a rejected text (both texts were accepted by Telegram when sent by hand) | lab evidence/a1-restore-pending/DIAGNOSIS.md; doc 18 | FINDING |
| NT-04 | RESTORED message after the delivery fix (10 s limit, one retry) | message received | Received at 23:51:40, the first RESTORED delivery after the fix (commit a639337) | doc 18; owner-reported | PASS |
| NT-05 | State report after a Core restart | current state announced once | LOCKDOWN report received at 23:49:03 after the 23:48:34 restart | doc 18; owner-reported | PASS |
| PL-01 | ESP32 power loss (A2) | broker drops the device, Core notices, boot state LOCKDOWN, reconnect, RESTORE accepted afterwards | Unplug about 19:01:30; broker keepalive drop 19:01:50; Core state DEGRADED after 45 s; reconnect 19:09:30; first status LOCKDOWN (BOOT) 19:09:32; RESTORE (seq 17, no CUT first) ACK OK and STATUS NORMAL with the command's nonce at 19:10:23. The relay state while unpowered was not recorded. See F-A2-1 | doc 19 (A2); lab logs/aegis_soc.log; broker log | PASS |
| PL-02 | Laptop reboot: the ESP32 reconnects without help | lease and TLS session return | Lease and one TLS session returned after the lab was brought back up; LOCKDOWN from the dead-man's switch while the Core was off, as expected | doc 19; work log of 2026-10-24 (not archived) | PASS |
| PL-03 | Laptop reboot: the Core starts | Core RUNNING | The first start failed: /run was wiped and the unprivileged Core could not create /run/aegis-live (PermissionError). aegis-live-up.sh now creates it; the runbook says so (commit 755046b, pushed) | doc 17; commit 755046b | FINDING |
| PL-04 | Laptop reboot: other units that start at boot | no collision with the lab | The old production Core, broker and DHCP units are enabled and started at boot and had to be stopped (never disabled). Whether to stop them from starting is an open decision | doc 17 (STOP_UNITS) | FINDING |
| PL-05 | Trusted time before the Core starts | kernel clock synced, max error below 1 s | max error settled from about 977 ms to 14.6 ms before the Core was started | work log of 2026-10-24 (not archived) | PASS |
| PL-06 | After the device is lost, `device` and `uplink` in status.json and the Desktop ESP32 badge | OFFLINE (or UNKNOWN) once the device is silent for more than 45 s | `device=ONLINE`, `uplink=NORMAL` for about 7.5 minutes (19:01:57 to 19:09:30) while the broker had dropped the device and the Core `state` was DEGRADED (F-A2-1; supervisor.py:544 is the only writer). Fix proposed, not implemented | doc 19 (F-A2-1) | FINDING |

## 4.5.8 Failure-mode Tests

| Test ID | Scenario | Expected | Result | Evidence location | Status |
|---|---|---|---|---|---|
| FZ-01 | The ESP32 cuts by itself when the Core stops | within 60 s of the last heartbeat | 47.21 s after the freeze | owner-reported (operator measurement); doc 19 | PASS |
| FZ-02 | No automatic restore after the Core resumes (SIGCONT) | relay stays in LOCKDOWN | Stayed in LOCKDOWN for more than a minute; fresh LOCKDOWN statuses every 30 s from 09:01:08 | doc 19; lab evidence/a1-restore-pending/core-log-0855-onward.txt | PASS |
| FZ-03 | Broker view of the freeze | Core client dropped on keepalive | 09:00:18 idea3-core disconnected: exceeded timeout (last Core ping 08:58:18) | lab evidence/a1-restore-pending/broker-lifecycle-0855-onward.txt | PASS |
| FZ-04 | The Core reconnects by itself | session re-established without help | Reconnected 09:01:01 (CONNACK accepted) | lab evidence/a1-restore-pending/ | PASS |
| FZ-06 | The ESP32's own broker session survives the freeze | no disconnect | No disconnect of the device client in the broker lifecycle log | lab evidence/a1-restore-pending/broker-clients-timeline-0855-onward.txt | PASS |
| FZ-07 | Desktop STALE indication during the freeze | evidence shown STALE | Not observed: the screenshots were taken after the Core resumed; the freeze lasted about one to two minutes against a 120 s threshold | doc 19 | PENDING |
| RC-05 | Desktop marks Core evidence STALE when status.json stops updating | FRESH -> STALE -> FRESH; stale after more than 60 s (was 120 s until 2026-10-24), 2 s poll | Threshold 60 s, the dead-man window (exactly 60.0 s is fresh); the Overview fact and header badges follow | tests/test_live_purple_control_desktop.py (stale section) | PASS |
| RC-06 | A Devices or Lockdown page that is open when the Core stops updating | stops showing the last state as current | It kept showing the last uplink and device state. Fixed (commit 25285a8 on feat/idea3-graduated-response); 7 tests fail without the fix. Not lab-verified | tests/test_live_purple_control_desktop.py | FINDING |
| RC-07 | The severity panel when status.json stops updating | marked stale | It showed the last decisions with no marker. Fixed in the same commit (th/en/zh, code kept). Not lab-verified | tests/test_live_purple_control_desktop.py | FINDING |

## 4.5.9 Current Limitations

- FINDING rows (something differs from the expectation or a gap was found): DT-04, IS-04, NT-03, PH-07, PL-03, PL-04, PL-06, RC-01, RC-04, RC-06, RC-07.
- PENDING rows (not run, not recorded, or offline only where a lab or hardware result is needed): AU-02, FZ-07, GR-01, GR-02, GR-03, GR-08, OP-07, PH-02, PH-09, RC-02.
- Several PASS rows rest on owner observations whose terminal output or notes were not archived (PH-06, DT-01, IS-01, NT-02, NT-04, NT-05, GR-06). Archive the outputs next to the lab evidence.
- The boot reading after the COM–NO rewire (PH-02) and the meter reading after a control Desktop CUT (PH-09) were not recorded. No row measures the time to the physical change (OP-07) or covers the live graduated levels (GR-01 to GR-03).
- RC-01 has a fix verified on the hardware (RC-03) but committed only on local, unpushed branches. RC-06 and RC-07 have fixes verified only by offline tests. PL-06 (F-A2-1) has a proposed fix and no code.
- The Desktop STALE rule is verified offline only (RC-05 to RC-07, FZ-07).

### Open items

1. **Done in code, not yet re-tested on the hardware: the Desktop STALE threshold is now 60 s** (`DESKTOP_MAX_AGE_SECONDS`, the dead-man window). The A1 freeze lasted about one to two minutes, so the earlier 120 s threshold may never have shown STALE in that test (FZ-07); repeat A1 to confirm.
2. **Expiry of an ACKed-but-never-confirmed RESTORE record.** The fix for RC-01 keeps refusing the RC-04 case (RESTORE ACKed, status evidence never arrived) until a CUT or a Core restart. Decide whether such a record should expire after `PHYSICAL_CONFIRM_TIMEOUT_SEC`.
3. **`npm audit` upgrade.** `npm audit --omit=dev` reports 2 high findings (body-parser, transitive; zod, direct) in the web application, identical on the base lockfile. Upgrade or accept.

## 4.5.10 IDEA 3 Result Summary

40 of 61 rows PASS, 11 are FINDINGS and 10 are PENDING. The relay actuation, the operator CUT and RESTORE paths, the dead-man's switch under a frozen Core, the Telegram notifications (after the delivery fix) and the isolation of the graduated-response units were observed on the lab hardware. Graduated response levels were verified offline only (GR-01 to GR-03 and GR-08 are not yet run live). The one functional defect found on hardware, the refused RESTORE after an uncommanded lockdown (RC-01), has a fix that passes its regression tests and was confirmed on the hardware by the A2 power-loss test (RC-03, PL-01). A2 also found that the Core never reports the device as OFFLINE (PL-06, F-A2-1; fix proposed, not implemented). No automatic RESTORE was seen in any lab run (GR-04, OP-06).
