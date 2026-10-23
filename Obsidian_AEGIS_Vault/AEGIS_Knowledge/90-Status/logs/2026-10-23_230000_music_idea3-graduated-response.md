---
title: Task Receipt — IDEA3 graduated response, Desktop RESTORE and severity panel
date: 2026-10-23T23:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-graduated-response
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 graduated response, Desktop RESTORE and severity panel

## What changed

- Severity-based containment (opt-in `AEGIS_GRADUATED_RESPONSE=YES`): LOW audit, MEDIUM software block, HIGH CUT
  recommended, CRITICAL one automatic CUT per lockdown episode only with corroboration a detector line cannot supply.
  RESTORE is never automatic. Default (flag unset) keeps the original R1-only alert path.
- Alert contract v2 with the detector-observed `kind`, served by a subclass ingress; the reviewed, pinned
  `recovery_core.py` and `production_detector.py` are byte-unchanged.
- Graduated detector that reads only kernel and root-sshd journal records (journald trusted fields) and adds the
  login-after-brute-force compromise signal.
- Localized Telegram severity notifications (th default, en, zh); notification only.
- New operator Desktop entry point with a working Core-authenticated RESTORE button (D4 channel), a read-only severity
  panel from a bounded Core projection, and a configurable Core status path.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/graduated_response.py` — new pure policy engine
- `IDEA3-AEGIS_Lockdown/aegis_soc/graduated_ingress.py` — new v2 ingress subclass
- `IDEA3-AEGIS_Lockdown/aegis_soc/graduated_detector.py` — new v2 detector subclass
- `IDEA3-AEGIS_Lockdown/aegis_soc/restore_client.py` — new stdlib Desktop RESTORE client
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — opt-in policy wiring, lab ingress gate, projection file
- `IDEA3-AEGIS_Lockdown/aegis_soc/alert_sink.py` — additive v2 payload, OBSERVED reply, AEGIS_ALERT_CORE_USER
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py` — inert-by-default flags
- `IDEA3-AEGIS_Lockdown/aegis_soc/comms.py` — localized severity notification
- `IDEA3-AEGIS_Lockdown/aegis_soc/i18n.py` — th/en/zh strings, translate_in
- `IDEA3-AEGIS_Lockdown/tools/live_purple_control_desktop.py` — new Desktop entry point
- `IDEA3-AEGIS_Lockdown/doc/Content/16_GRADUATED_RESPONSE.md` — design, flags, lab procedure
- `IDEA3-AEGIS_Lockdown/tests/test_graduated_response.py`, `tests/test_graduated_response_core.py`,
  `tests/test_restore_client.py`, `tests/test_live_purple_control_desktop.py` — new tests
- `IDEA3-AEGIS_Lockdown/tests/test_core_alert_ingress.py` — static ingress-gate assertion updated for the explicit lab flag

## Verification evidence

- `pytest tests/test_graduated_response.py tests/test_graduated_response_core.py tests/test_restore_client.py` — pass
- 52 affected IDEA3 test files, branch vs clean `main` cc096de (Python 3.13, root container): identical failure set
  (environment-only: root uid, no systemd/sudo); no new failure; F1/R1 pin tests pass.
- Desktop suites under Xvfb (Python 3.12 + Tk): baseline 72 passed / 1 skipped; branch 83 passed / 1 skipped.
- `ruff check` on every new or changed file — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added graduated-response and Desktop RESTORE section

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Lab hardware acceptance of scenarios 1–5 in `doc/Content/16_GRADUATED_RESPONSE.md` not yet run.
- The graduated behaviour changes a documented IDEA3 boundary (an alert may now lead to a CUT, only when explicitly
  enabled); owner and reviewer decision required before any production use.
- New Desktop panel strings are English only.
- Not deployed; production untouched.
