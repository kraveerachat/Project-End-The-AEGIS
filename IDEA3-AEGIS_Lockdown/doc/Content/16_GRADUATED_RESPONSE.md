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

Known limit: the new panel strings are English only; the accepted page chrome keeps its th/en/zh selector.
