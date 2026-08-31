---
title: Task Receipt — IDEA2 SYSTEM-only tunnel key ACL
date: 2026-08-30T03:02:43+07:00
owner: pub
area: idea2
branch: fix/idea2-system-only-key-acl
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 SYSTEM-only tunnel key ACL

## What changed

- Replaced the merged Windows service-key contract of SYSTEM plus local
  Administrators with the real-machine-proven final contract: owner SYSTEM,
  inheritance disabled, and exactly one explicit SYSTEM FullControl rule.
- Moved existing-key reads, optional migration/copy, ACL hardening, and SSH
  acceptance into a short-lived Scheduled Task that runs as SYSTEM. The
  elevated installer receives only non-secret paths and metadata and removes
  the helper task in a `finally` block.
- Made replacement-key migration transactional. An explicitly supplied key is
  tested from a SYSTEM-only pending file and replaces the recorded runtime key
  only after strict-host-key SSH authentication, local forward `:18002`, and
  Monitor `/healthz` all pass. A failed probe leaves the prior runtime key in
  place.
- Prevented persistent tunnel registration from occurring before the SYSTEM
  helper proves its identity, exact ACL, SSH authentication, forward, health,
  and absence of OpenSSH permission/public-key failures.
- Preserved the verified legacy key filename
  `idea2_tunnel_autostart_ed25519` for metadata-free migration; the installer
  neither enumerates candidate keys nor guesses or generates another key.
- Extended repair, status, tunnel-failure classification, uninstall cleanup,
  portable-install documentation, and regression coverage around the new
  lifecycle.

### ACL contract before and after

```text
Before (rejected by Windows OpenSSH on the operator laptop)
Owner: SYSTEM
Allow: SYSTEM FullControl
Allow: BUILTIN\Administrators FullControl

After (required final state)
Owner: SYSTEM
Inheritance: disabled
Allow: SYSTEM FullControl
All other rules: rejected
```

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — summarize the
  SYSTEM-only service-key boundary and helper acceptance gate.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py`
  — replace the old Administrators-required assertions and add lifecycle,
  ordering, error-status, portability, preservation, and cleanup regressions.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md` — document the
  portable SYSTEM-only install, migration, repair, status, and real acceptance
  workflow.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1` —
  delegate key handling to SYSTEM and gate persistent registration on the
  helper result.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/prepare_tunnel_key.ps1` —
  add the one-time SYSTEM helper, exact ACL contract, transactional migration,
  and real SSH-forward/Monitor-health probe.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/repair_autostart.ps1` —
  reuse the same helper lifecycle without selecting or rotating another key.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_tunnel.ps1`
  — use an explicit runtime root and stop infinite retries on fatal missing-key,
  missing-known-hosts, key-permission, or public-key authorization errors.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/status_autostart.ps1` —
  report ACL, SYSTEM principal, AtStartup trigger, supervisor, ports, health,
  and normalized OpenSSH failure flags.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/uninstall_autostart.ps1`
  — remove any stale one-time helper task/process while preserving runtime data.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — replace the
  stale SYSTEM-plus-Administrators fact with the SYSTEM-only source state and
  explicit real-machine limitation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-30_030243_pub_idea2-system-only-key-acl.md`
  — immutable task evidence.

## Verification evidence

- `python -m unittest discover -s tests -v` — **pass: 35/35**, zero failures or
  skips, from `IDEA2-AEGIS_CCTV-Operator/detection-engine/` using bundled Python.
- PowerShell AST parse of every `detection-engine/windows/*.ps1` — **pass: 8/8**.
- `./windows/install_autostart.ps1 -TunnelHost test-user@example.invalid -WhatIf`
  — **pass**: reached the mutation boundary and performed no runtime change.
- `node --test --test-concurrency=1 <all repository tests/*.test.mjs>` — **pass:
  56/56**, zero failures or skips.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — **pass** with the two unchanged owner-review Canvas warnings.
- `node scripts/validate-collaboration-policy.mjs --event <source-PR-event>
  --changed-files <source-PR-paths>` — **pass** for IDEA2/Pub, no integration
  review, exactly one new receipt, and all eleven paths inside the IDEA2 boundary.
- Targeted changed-path artifact/secret scan — **pass**: no `.env`, private-key,
  model, recording, image, token-pattern, or credential artifact; no operator
  profile path in application scripts/documentation.
- `git diff --check` — **pass**; only line-ending conversion notices from the
  existing Windows checkout policy.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — now records the
  real-machine ACL finding, the SYSTEM-helper source design, and the still-open
  real install/reboot/camera acceptance gate.

## Shared surfaces touched

- None — every changed path is inside IDEA2's source or Pub-owned canonical
  knowledge boundary.

## Integration requests

- None — no cross-scope or shared path changed. IDEA2 review should confirm the
  key lifecycle and source-vs-runtime evidence before merge.

## Known limitations

- This task deliberately did not run the elevated installer, change the active
  private key, register or start a real task, restart Windows, or touch the
  production Monitor/server/network/database configuration.
- `REAL_MACHINE_INSTALL`, `REBOOT_ACCEPTANCE`, and `LIVE_CAMERA` are **NOT
  VERIFIED** for this revision. After merge, the operator laptop still needs
  elevated install, reboot without manual starts, exact ACL inspection,
  `:8077`, `:18002`, Engine `/health`, Monitor `/healthz`, and authorized Live
  Canvas demand/capture/detect/release evidence.
- A fresh laptop must supply an explicitly authorized machine-specific key and
  fingerprint-verified `known_hosts`. The installer never creates a key or
  changes server `authorized_keys`.
