---
title: Task Receipt — IDEA3 Kali isolated-lab readiness
date: 2026-10-10T22:11:00+07:00
owner: music
area: idea3
branch: codex/idea3-kali-lab-readiness
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Kali isolated-lab readiness

## What changed

- Added an IDEA3-owned offline acceptance mapping and future isolated Kali lab contract. It distinguishes synthetic detector/ingress/containment evidence from live Kali observations and records the A3 event-path blocker.
- No test fixture or implementation change was justified: existing deterministic tests cover the offline behaviors; they do not prove live host firewall or live packet behavior.

## Source files changed

- `IDEA3-AEGIS_Lockdown/docs/operations/idea3-kali-attack-detection-lab-acceptance.md` — scenarios A1–A3, evidence requirements, isolated lab plan, stop/recovery conditions, and pre-attack gates.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-10_221100_music_idea3-kali-lab-readiness.md` — this immutable task receipt.

## Verification evidence

- `PYTHONDONTWRITEBYTECODE=1 /usr/bin/pytest -q tests/test_f1_alert_sink.py tests/test_core_alert_ingress.py tests/test_ip_containment.py tests/test_runtime.py tests/test_local_e2e_acceptance.py tests/test_offline_core_acceptance.py` (from `IDEA3-AEGIS_Lockdown/`, with local-socket test permission) — PASS, 359 passed, 10 skipped.
- Same pytest command in the default workspace sandbox — FAIL, 65 failures caused by `PermissionError: [Errno 1] Operation not permitted` when tests bind local AF_UNIX sockets; elevated offline rerun passed.
- `git diff --check` — pending.

## Canonical notes updated

- `None` — this readiness contract records prerequisites and unresolved acceptance, not a new implemented/deployed maturity fact; the Music-owned status note was left unchanged.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-10_221100_music_idea3-kali-lab-readiness.md` — immutable IDEA3 receipt is outside the IDEA3 code boundary; request integration review of the receipt's scope declaration. No Core Upgrade or Recovery-owned file was changed.

## Integration requests

- Request independent IDEA3 functional-owner review (Music) and integration review (Kla) of the A3 event-path boundary and the isolated-lab gates before any future live Kali authorization. Review must decide whether detector alert ingress is expected to trigger armed software containment or whether A3 will be separately/manual scoped. No rollout is authorized; rollback for this document is a normal reviewed revert. No Production or host mutation occurred.

## Known limitations

- Kali observations, live detector lifecycle, host nftables behavior, packet blocking, and lab rollback have not been executed or verified.
- The A3 end-to-end production-detector-to-containment event path is not proven by current tests.
- GitHub PR creation is not yet recorded.
