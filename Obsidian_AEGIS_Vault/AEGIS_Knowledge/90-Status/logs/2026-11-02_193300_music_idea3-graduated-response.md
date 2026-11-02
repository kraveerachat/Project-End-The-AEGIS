---
title: Task Receipt — IDEA3 graduated response, Desktop RESTORE, severity panel, P1-P6 completion, hardware verification, red-team harness
date: 2026-11-02T19:33:00+07:00
owner: music
area: idea3
branch: feat/idea3-graduated-response
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 graduated response, Desktop RESTORE, severity panel, P1-P6, hardware verification, red-team harness

Consolidates four earlier same-branch receipts (now removed by this commit, per the one-receipt-per-task rule): graduated response (2026-10-23), P1-P6 program completion (2026-10-24 21:00), P1-P6 hardware verification (2026-10-24 22:00), and the red-team harness (2026-10-24 22:30).

## What changed

- Severity-based containment (opt-in `AEGIS_GRADUATED_RESPONSE=YES`): LOW audit, MEDIUM software block, HIGH CUT
  recommended, CRITICAL one automatic CUT per lockdown episode only with corroboration a detector line cannot supply.
  RESTORE is never automatic. Default (flag unset) keeps the original R1-only alert path.
- Alert contract v2 with the detector-observed `kind`, served by a subclass ingress; `recovery_core.py` and
  `production_detector.py` are byte-unchanged.
- Graduated detector reading only kernel and root-sshd journal records (journald trusted fields), plus the
  login-after-brute-force compromise signal.
- Localized Telegram severity notifications (th default, en, zh); notification only.
- New operator Desktop entry point: Core-authenticated RESTORE button (D4 channel), read-only severity panel from
  a bounded Core projection, configurable Core status path.
- P1 (F-A2-1): lost device reported `device=OFFLINE`, `uplink=UNKNOWN` after `DEVICE_OFFLINE_SEC` (45 s) without an
  authenticated device message; RESTORE refused with `UPLINK_NOT_LOCKDOWN` while OFFLINE, by design.
- P2: Desktop evidence STALE threshold is 60 s (`tools/live_purple_observer.DESKTOP_MAX_AGE_SECONDS`).
- P3: Desktop Recovery page is a read-only readiness checklist, th/en/zh, one navigation-only button to Lockdown.
- P4: Incidents and Audit pages are read-only (graduated decisions, CUT/RESTORE audit, machine fields) or
  `NOT_AVAILABLE — <reason>`.
- P5: CUT/RESTORE dialogs, captions, buttons, result lines translated th/en/zh at display time only.
- P6: an ACKed-but-not-physically-confirmed RESTORE stops blocking a new RESTORE `PHYSICAL_CONFIRM_TIMEOUT_SEC`
  (8 s) after the ACK.
- Hardware verification run on 2026-10-24 (Core and Desktop restarted on the P1-P6 code): recovery view, Thai
  wording, Recovery/Incidents/Audit pages, RESTORE without a CUT after a Core restart, and the A2 repeat (OFFLINE
  and uplink UNKNOWN after 38.40 s, LOCKDOWN (BOOT) after replug, one RESTORE accepted). F-A1-1 and F-A2-1 verified
  on hardware; matrix rows RC-03, RC-08, RC-09, RC-10, PL-01, PL-06 are PASS (owner-reported, output not archived).
- Wrote (did not run) a lab red-team harness under `deploy/live-lab/redteam/` (attacker-ns-up/down.sh,
  collect-evidence.sh, capture-owner-reported.sh, a patch proposal for a `--with-attacker-veth` flag, and a
  design note comparing two ways to produce a CRITICAL `ssh_login_after_failures` signal — neither applied/built,
  pending owner review). `capture-owner-reported.sh` itself was run once, read-only, and archived 4 existing
  evidence items; 11 doc-21 rows stay "owner-reported" with no archived source found.

## Source files changed

- Core: `aegis_soc/graduated_response.py`, `graduated_ingress.py`, `graduated_detector.py`, `restore_client.py`,
  `supervisor.py`, `alert_sink.py`, `config.py`, `comms.py`, `i18n.py`, new `recovery_view.py`,
  `local_restore.py` (`_restore_wait_remaining`, `lockout_remaining`).
- Desktop: `tools/live_purple_control_desktop.py`, `live_purple_observer.py`, `live_purple_cut_desktop.py`,
  `live_purple_incident_desktop.py`, new `live_purple_core_records.py`, new `live_purple_control_strings.py`.
- Deploy: `deploy/live-lab/` (new parameterized scripts, no secrets), `deploy/live-lab/redteam/` (write-only, not
  run — see Known limitations), `run-control-desktop.sh` (audit DB path).
- Docs: `doc/Content/16_GRADUATED_RESPONSE.md`, `17_LIVE_LAB_RUNBOOK.md`, `18_LIVE_LAB_ACCEPTANCE_SUMMARY.md`,
  `19_FAILURE_MODE_TESTS.md`, `20_CROSS_IDEA_EVENT_CONTRACT.md` (draft, not agreed), `21_TEST_EVIDENCE_MATRIX.md`.
- Tests: `test_graduated_response.py`, `test_graduated_response_core.py`, `test_restore_client.py`,
  `test_comms.py`, `test_live_purple_control_desktop.py`, `test_live_purple_core_records.py`,
  `test_live_purple_control_strings.py`, `test_runtime.py`, `test_local_restore.py`, `test_core_break_glass.py`,
  `test_core_alert_ingress.py`.

## Verification evidence

- `pytest tests/test_graduated_response.py tests/test_graduated_response_core.py tests/test_restore_client.py` — pass.
- 52 affected IDEA3 test files, branch vs clean `main` cc096de (Python 3.13, root container): identical
  environment-only failure set (root uid, no systemd/sudo); no new failure; F1/R1 pin tests pass.
- Desktop suites under Xvfb (Python 3.12 + Tk): baseline 72 passed / 1 skipped; branch 83 passed / 1 skipped.
- `ruff check` on every new or changed file — pass.
- Live lab on `main` cc096de + this branch (2026-10-23): CUT and RESTORE with owner multimeter readings and from
  the control Desktop; Telegram LOCKDOWN/RESTORED received (graduated response OFF).
- `deploy/live-lab/*.sh` — `bash -n` pass; config rendering exercised offline with dummy files.
- Hardware verification 2026-10-24 (operator-reported in session; terminal output not archived) — see What changed.
- `bash -n` on the four red-team shell scripts; the embedded Python in `collect-evidence.sh` parsed with
  `ast.parse`; `capture-owner-reported.sh` run once (read-only) and its own secret-pattern self-check passed.
  The namespace scripts, evidence collector and live attack commands were **not run**.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`

## Shared surfaces touched

- None — task stayed inside its selected area.

## Integration requests

- None.

## Known limitations

- Lab hardware acceptance of scenarios 1-5 in `16_GRADUATED_RESPONSE.md` not fully run (Desktop RESTORE/CUT and
  Telegram ARE proven live; the detector, containment helper and automatic-CUT path are not).
- `deploy/live-lab/aegis-live-up.sh`/`-down.sh` not re-run end to end; only rendering and syntax checked.
- The graduated behaviour changes a documented IDEA3 boundary (an alert may lead to a CUT when explicitly enabled);
  owner/reviewer decision required before any production use.
- A real-window STALE freeze screenshot is not recorded.
- The Desktop severity panel is localized th/en/zh; the RESTORE/CUT dialogs and control-Desktop captions are
  English only.
- Not deployed; production untouched.
- Hardware repeat of the 60 s STALE threshold under a frozen Core, the 8 s ACKed-but-unconfirmed RESTORE expiry,
  and native Chinese-wording review are still pending.
- Red-team harness: attacker is co-located (veth, not the AP radio) — see the harness README's own limitation.
  G1/G2b (and the scan half of G2a/G2c) need `--with-attacker-veth` or the proposed patch before the Core's log
  rule can see them at all. G3 (CRITICAL) has no implementation yet, pending the owner's choice in
  `design-G3-critical.md`. 11 doc-21 rows have no archived source anywhere on disk and stay "owner-reported".
