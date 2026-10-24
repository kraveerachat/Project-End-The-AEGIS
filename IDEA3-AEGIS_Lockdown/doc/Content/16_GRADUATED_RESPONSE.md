# 16 — IDEA3 Graduated Response (severity-based containment)

Status: repository implementation with offline tests. Lab hardware acceptance pending. Not deployed to production.

## Why

A Core that cuts the uplink on every detector alert is not a security control: anyone able to produce one alert
(a port scan, or a forged log line) could make the system cut its own network. IDEA3 instead applies the lightest
response that stops the attack and escalates only when that response is not enough. The physical relay cut is the
last resort, it needs evidence that a detector line alone cannot supply, and RESTORE is never automatic.

## Levels

| Level | Typical trigger (lab thresholds) | Core response |
|---|---|---|
| LOW | below the MEDIUM score | audit only |
| MEDIUM | one detector rule crossed: port scan (T1046), SSH brute force (T1110), SYN flood (T1498) | reversible software block of the address through the root containment helper |
| HIGH | several vectors from one address, or three or more sources at MEDIUM within 120 s | CUT recommended to the operator (Desktop); Telegram notification |
| CRITICAL | score ≥ 100 **and** corroboration | one automatic `CUT_UPLINK` per lockdown episode through the normal Core command path |

Scores per evidence kind (each kind counts once per address within a 600 s window): generic 30, port scan 30, SSH brute
force 40, SYN flood 50, multi-vector bonus 20, distributed sources 30, containment failed 60, activity after a confirmed
block 60, SSH login after brute force 100.

Corroboration (the only way to CRITICAL):

- the Core's own software block of the address failed (helper refused or unavailable);
- the address produced new detector evidence more than 5 s after the Core confirmed its block (a working block drops the
  packets before they are logged, so new evidence means the block is being bypassed);
- a successful SSH login from an address that crossed the brute-force rule in the same window (compromise signal).

Without corroboration the level is capped at HIGH, which only recommends. The auto-CUT latch resets when the device next
reports NORMAL, which only an operator RESTORE produces.

## Trust boundaries

- The detector reports what it observed (`kind`), never an action. Alert payload v2:
  `{"v":2,"attacker_ip":"<IPv4>","kind":"port_scan|ssh_brute_force|syn_flood|ssh_login_after_failures"}`.
  Core-side kinds cannot be claimed by a sender; unknown keys, versions or kinds are refused. v1 stays accepted.
- The graduated detector (`aegis_soc/graduated_detector.py`) follows `journalctl -o json _TRANSPORT=kernel + _COMM=sshd` and checks journald's trusted fields:
  netfilter rules only see kernel records, SSH rules only see records from `sshd` running as uid 0. Lines written by
  a local user with `logger(1)` are ignored.
- The Core decides the level. The policy module (`aegis_soc/graduated_response.py`) is pure: no I/O, no command path.
- Telegram is notification only (th/en/zh). It never carries CUT or RESTORE authority.

## Configuration (all inert unless set exactly)

| Variable / flag | Where | Effect |
|---|---|---|
| `AEGIS_GRADUATED_RESPONSE=YES` | Core | enable scoring and actions; off = original R1-only alert path |
| `AEGIS_LAB_ALERT_INGRESS=YES` | Core (lab profile) | serve the F1 alert socket on a lab Core; needs the flag above |
| `AEGIS_TG_LANG=th\|en\|zh` | Core | Telegram language (default th) |
| `AEGIS_LAB_ALERT_SOCKET=/run/<dir>/alert.sock` | Core (lab profile) | lab-only alert socket outside the production `/run/aegis-idea3-alert`, so a lab Core running as the operator needs no change to production paths; same directory checks (Core-owned, alert group, 2750, never created) |
| `--socket /run/<dir>/alert.sock` | graduated detector | the matching lab socket; default is the production constant |
| `python -m aegis_soc.graduated_detector` | detector unit | run the v2 detector instead of `aegis_soc.production_detector` |
| `AEGIS_ALERT_CORE_USER=<user>` | detector | Core account the socket must belong to (lab Core runs as the operator) |

The existing F1 requirements are unchanged: dedicated non-root detector uid (`AEGIS_ALERT_SOURCE_UID`), group
`aegis-idea3-alert`, Core-owned `/run/aegis-idea3-alert` mode 2750, SO_PEERCRED checks, rate limit.

## Lab prerequisites

1. Root containment helper running (`deploy/network/aegis-idea3-containment.*`). Without it every block fails and counts
   as corroboration, so a single rule would escalate straight to CRITICAL.
2. Protected networks for the helper must cover the Core and the ESP32 addresses only, never the whole lab subnet.
3. A netfilter log rule with prefix `AEGIS_NEWCONN ` for new inbound connections on the lab interface (port scan and
   SYN rules read it).
4. sshd on the Core host for the brute-force and login scenarios (lab accounts only).

## Acceptance scenarios (lab)

| # | Action from a second lab device | Expected |
|---|---|---|
| 1 | port scan of the Core host | MEDIUM, address blocked, Telegram MEDIUM, relay unchanged |
| 2 | port scan then SSH password guessing from one address | HIGH, CUT recommended, relay unchanged |
| 3 | SSH guessing then a successful login (lab account) | CRITICAL, one automatic CUT, tester pin 2 open, Telegram CRITICAL |
| 4 | operator RESTORE with the D4 secret | relay closed, latch reset |
| 5 | `logger "Failed password for root from 203.0.113.7 port 22 ssh2"` ×10 as a normal user | nothing |

## Tests

`tests/test_graduated_response.py` (policy), `tests/test_graduated_response_core.py` (ingress v2, supervisor actions,
Telegram text, sink, detector trusted sources). `tests/test_core_alert_ingress.py` keeps pinning the default-off
behaviour; its static ingress-gate assertion was updated for the explicit lab flag.

## Governed files

The reviewed and pinned F1/R1 sources `recovery_core.py` and `production_detector.py` are byte-unchanged; the version-2
ingress (`graduated_ingress.py`) and detector (`graduated_detector.py`) are subclasses in new modules, so the existing
release pins still verify. Changed shared modules: `supervisor.py`, `alert_sink.py` (additive v2 payload, `OBSERVED`
reply, `AEGIS_ALERT_CORE_USER`), `config.py`, `comms.py`, `i18n.py`.

## Operator Desktop (CUT, RESTORE, severity)

`tools/live_purple_control_desktop.py` is a new entry point built on the unchanged `live_purple_cut_desktop.py`:

- **RESTORE button**, wired to the Core-local D4 RESTORE channel through `aegis_soc/restore_client.py` (stdlib only, loaded
  by path like `cut_client`). Same request, gate, Recovery policy and evidence ladder as `aegisctl restore`: reason
  (12–240 chars), typed `RESTORE UPLINK`, and the RESTORE secret, verified by the Core and never stored. CUT and RESTORE
  use different secrets. Enabled only with `AEGIS_DESKTOP_RESTORE_ENABLED=YES` and an absolute
  `AEGIS_LOCAL_RESTORE_SOCKET`; otherwise the button stays disabled.
- **Severity panel** (read only) on the Lockdown page: highest level, CUT recommendation, whether an automatic CUT ran this
  episode, and the last decisions with MITRE IDs and outcomes, from `graduated-status.json` (bounded, 0640, written
  atomically by the Core; no secrets). Refreshed every 2 s.
- **Status path**: `AEGIS_DESKTOP_STATUS_PATH` points the evidence reader at the running Core's `status.json`
  (the base launcher always read the production path, which is why the lab panel showed UNKNOWN).

Launch (lab):

```bash
AEGIS_DESKTOP_CUT_ENABLED=YES AEGIS_LOCAL_CUT_SOCKET=<cut.sock> \
AEGIS_DESKTOP_RESTORE_ENABLED=YES AEGIS_LOCAL_RESTORE_SOCKET=<runtime_dir>/local-restore.sock \
AEGIS_DESKTOP_STATUS_PATH=<runtime_dir>/status.json AEGIS_RECOVERY_CORE_USER=<core user> \
venv/bin/python -m tools.live_purple_control_desktop
```

The severity panel is localized (th/en/zh) and follows the same language selector as the rest of the window. Level, action, outcome and kind codes, MITRE IDs, addresses and the words CUT, RESTORE, EXECUTED and NOT_AVAILABLE stay untranslated. Known limit: the RESTORE and CUT dialogs and the control captions added by this Desktop are still English only.

## Desktop Recovery, Incidents and Audit pages (read-only)

The control Desktop's Recovery, Incidents and Audit pages show Core data and have no authority: the only RESTORE control is on the Lockdown page, and the
Recovery page has one button that only navigates there. Every page refreshes every 2 s while it is open, follows the language selector (th/en/zh) and keeps codes untranslated.

| Page | Source | If the source cannot be read |
|---|---|---|
| Recovery | The Core's `recovery-status.json` (next to `status.json`; uplink and why it is in LOCKDOWN, pending RESTORE and the seconds it still blocks, authentication lockout remaining, RESTORE served), `graduated-status.json`, and the last five RESTORE attempts from the Core audit database | `NOT_AVAILABLE — <reason>`; a view older than 60 s is `STALE` and is not shown as fact |
| Incidents | `graduated-status.json` (the Core's graduated-response decisions) | `NOT_AVAILABLE — <reason>` (the file exists only when graduated response is ON and a decision was made) |
| Audit | The Core audit database, opened read-only, CUT and RESTORE events only (`COMMAND_SENT`, `ACK_RECEIVED`, `CUT_PRE_DISPATCH`, `RESTORE_REQUESTED`, `RESTORE_REFUSED`, `RESTORE_AUTH_LOCKOUT`) | `NOT_AVAILABLE — <reason>` |

The Recovery row "Ready for a RESTORE" lists every blocker by code (`EVIDENCE_NOT_FRESH`, `VIEW_UNAVAILABLE`, `UPLINK_NOT_LOCKDOWN`, `DEVICE_NOT_ONLINE`,
`BROKER_NOT_CONNECTED`, `TIME_NOT_TRUSTED`, `RESTORE_NOT_SERVED`, `COMMAND_AWAITING_ACK`, `RESTORE_PENDING`, `AUTH_LOCKED_OUT`). It is advice; the Core's gate decides.
Reasons for a source being unavailable are `NOT_CONFIGURED`, `NOT_FOUND`, `PERMISSION_DENIED`, `NOT_A_REGULAR_FILE`, `TOO_LARGE`, `UNREADABLE`, `MALFORMED` and `STALE`.

The audit reader returns only machine fields: the time, the event kind, a result code, and the sequence or message id. It never returns an operator's reason or
secret, parses with anchored patterns so text inside a reason cannot fake a field, and is bounded to 50 rows. The database path comes from `AEGIS_DESKTOP_AUDIT_DB`
(the lab launcher sets it); the Desktop user must be able to read that file. `AEGIS_DESKTOP_RECOVERY_PATH` overrides the recovery view path.

### CUT and RESTORE dialogs in Thai, English and Chinese

The control Desktop's CUT and RESTORE dialogs (reason, typed confirmation, secret), the notices, the captions on the Lockdown page, the two button texts and the status
line under each button follow the language selector (`tools/live_purple_control_strings.py`). Only the displayed wording is translated: the accepted purple source and the
CUT Desktop still find their widgets by the English texts, the clients still return English sentences, the tests and the audit trail see English, and the confirmation
words (`RESTORE UPLINK`, the CUT word), state codes (`PUBLISHED`, `REFUSED_AUTH`, ...), command words and reason codes are never translated. A sentence without a translation
is shown in English; a test fails if any fixed sentence of the two clients lacks one. The Thai and Chinese wording needs a native review.

