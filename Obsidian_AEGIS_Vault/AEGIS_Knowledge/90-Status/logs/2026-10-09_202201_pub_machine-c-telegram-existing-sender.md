---
title: Task Receipt — Machine C existing-sender Telegram safeguards
date: 2026-10-09T20:22:01+07:00
owner: pub
area: idea2
branch: fix/idea2-machine-c-telegram-sender
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Machine C existing-sender Telegram safeguards

## Scope reconciliation — 2026-10-12

PR #419 now targets the current `main` that already includes #344, #348 and
#425; earlier stacked dependency descriptions in Git history are historical,
not active blockers. Current-maturity acceptance is **source-only**.
The owner has asked to prepare PR #419 along with #404 and #410 for one
human review session; no authorization to deploy/test live Telegram credentials
or assertion that Machine C's automatic Unknown-triggered delivery passed.

## What changed

- Reuse existing Detection Engine Telegram sendPhoto implementation, bot and
  group; no new bot, backend sender, or replay worker.
- Optional caption display name for Machine C; canonical Node/camera/generation
  and attribution remain unchanged.
- Default settings disabled to preserve Machine A behavior.
- When opted in, avoid automatic resends after ambiguous Telegram HTTP or
  transport failures; accept explicit boolean `ok=true` acknowledgements.
- Bound concurrent/recent duplicate claims per process and redact
  credentials, request/response bodies and exception details from logs.
- Alert persistence continues even when Telegram is suppressed or not confirmed.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — blank/false feature defaults.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — source contract, opt-in and limitations.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/alert_manager.py` — existing-sender safety behavior.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — validated default-off settings and safe startup logging.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_telegram_delivery.py` — mocked Telegram cases.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-09_202201_pub_machine-c-telegram-existing-sender.md` — this current-task receipt.

## Verification evidence

- At a PRIOR source checkpoint (not the reconciled current-main HEAD):
  `python -B -m unittest discover -s tests -p test_telegram_delivery.py -q`
  — PASS 26 / FAIL 0 / SKIP 0; independent mocked sender suite.
- At that same PRIOR checkpoint:
  `python -B -m unittest discover -s tests -p test_*.py -q`
  — PASS 423 / FAIL 0 / SKIP 0 in an isolated offline environment.
- Earlier governance/Vault checks passed at earlier checkpoints.
- Current-main source review confirmed sender reuse, default-off behavior,
  bounded per-process deduplication, and credential redaction in the diff.
- Current-head GitHub Collaboration guardrails previously passed, but a new
  CI run following this receipt update must be checked.
- `python -B -m unittest discover -s tests -p test_telegram_delivery.py -v`
  — NOT YET RERUN on this updated exact HEAD.
- `python -B -m unittest discover -s tests -p test_*.py -q`
  — NOT YET RERUN on this updated exact HEAD.
- Actual Telegram send, credential checks, Machine C real Unknown detection,
  installed runtime behavior and any camera/Production acceptance NOT TESTED.

## Canonical notes updated

- None in the reduced current-main diff. IDEA2 functional owner must reconcile
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` if final
  acceptance changes durable status.

## Shared surfaces touched

None — all changes are IDEA2 Engine-owned or this task receipt.

## Integration requests

- IDEA2 owner: confirm source feature belongs to accepted Machine C alerting
  scope, then validate Machine A regression at current HEAD.
- Independent human reviewer: verify all current source and test behavior,
  documentation/receipt consistency, no new secrets and the exact-head CI.
- Human owner merges #419 only after the accepted #404 and #410 merges have
  advanced main and the remaining PR is reconciled/retested.
- Any actual credential installation, live Telegram send or Production
  rollout needs separate owner permission and controlled rollback.

## Known limitations

- Deduplication is bounded to one manager/process and expires; NOT durable
  globally exactly-once.
- `telegram_sent=false` means delivery was unconfirmed, not proof no Telegram
  message was received.
- Real Machine C unknown-triggered delivery and Production acceptance remain
  NOT PROVEN.
- Receipt stays PARTIAL until fresh tests, owner scope confirmation and human
  approval; this document does not authorize Merge or deployment.
