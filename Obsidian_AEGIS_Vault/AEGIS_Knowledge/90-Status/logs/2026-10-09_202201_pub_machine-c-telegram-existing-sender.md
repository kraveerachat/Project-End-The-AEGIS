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

## What changed

Source-only implementation checkpoint:
`61ef23341e9f0ada44a78e16317f5cfafd0eb53f`.
Base: PR #348 `db263207f355678315e1a85fcfbc73df0e9be2dc`.
Stacked dependency: PR #344 -> PR #348 -> this Draft task PR.
Source work is locally verified; runtime delivery is NOT TESTED.

- Reuse the existing AlertManager/sendPhoto sender; no server-managed sender,
  second bot, group, notification worker, schema migration or historical replay.
- Optional caption-only display produces `Node: Machine C (mr-tk-01)`;
  canonical Node, camera alias and generation remain unchanged.
- Default settings preserve Machine A's caption, retry/backoff and cooldown.
- Opt-in mode retries explicit API rejection only. Timeout, transport error,
  redirect, 5xx or malformed acknowledgement is unconfirmed and not resent.
  Only HTTP 200 plus boolean `ok=true` sets `telegram_sent=true`.
- Duplicate claims are bounded to 256 per manager/process, keyed by Node,
  camera, generation, frame sequence and event timestamp. In-flight claims do
  not expire; completed claims last max(60, cooldown, 3*HTTP timeout+11) seconds.
  This is NOT durable exactly-once delivery across expiry, restarts or processes.
  At capacity, new Telegram sends are suppressed but API/Monitor alerts persist.
- Both Telegram credentials are masked in startup config. No response bodies or
  request/exception strings are logged by the sender.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/alert_manager.py` — existing sender caption, opted-in duplicate/ambiguous-delivery safeguards and safe logging.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — default-inactive display/safe-mode fields, environment parsing, bounded display validation and chat masking.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_telegram_delivery.py` — 26 mocked regression cases, no hardware/network requests.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — blank display and false safe-mode defaults only; no credentials.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — opt-in contract, bounded deduplication and honest unconfirmed-delivery semantics.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — current task/session and source-only maturity.

## Verification evidence

Environment: isolated Windows development worktree, Python 3.12 through an
existing development venv (no installed runtime changes), Node 24.14.0.
Engine commands below run from `IDEA2-AEGIS_CCTV-Operator/detection-engine`;
Node/governance commands run from repository root.

- Initial `python -m unittest discover -s tests -p test_telegram_delivery.py -v`
  — RED: 9 tests, 6 expected failures / 3 pass (caption, options, dedup, timeout
  retry and credential-leaking logs). The first fixture setup error was corrected
  before this genuine behavior RED; it was not counted as defect reproduction.
- `python -B -m unittest discover -s tests -p test_telegram_delivery.py -q`
  — final GREEN: 26 pass / 0 fail / 0 skip. Includes exact Machine A caption,
  timeout/options/backoff, Node/camera/generation isolation, Unknown/cooldown,
  concurrent duplicate, blocked-send time jump, ledger capacity, malformed/5xx/
  timeout response, no confirmed-success on ambiguity and credential redaction.
- Independent reviewer repeated the focused command with `-v`:
  26 pass / 0 fail / 0 skip; source diff check PASS.
- `python -B -m unittest discover -s tests -p test_*.py -q`
  — approved offline regression rerun: 423 pass / 0 fail / 0 skip, 55.757s.
  Simulated capture/model/recording and disposable pipe tests are not real
  camera, GPU, Telegram or installed Agent acceptance.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs`
  — approved rerun: 59 pass / 0 fail / 0 skip.
- Earlier sandbox governance attempt: 58 pass / 1 environmental failure because
  disposable `git init` could not write its sandbox temp config. The earlier
  sandbox Engine run hit temporary synthetic-recording permission errors and
  was interrupted; it is NOT counted as green. No source changes bypassed either
  permission boundary; normal approved escalation reruns passed.
- Python `ast.parse` of the three changed Python files — PASS.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — PASS, two pre-existing owner-data canvas warnings.
- `git diff --check` and staged diff check — PASS.
- Changed-content private-key, Telegram/GitHub token and AWS credential pattern
  scan — no matches; fixture strings are synthetic, and manual diff review found
  no real credentials, .env, recordings, dependencies or generated output.
- `git diff --exit-code db263207f355678315e1a85fcfbc73df0e9be2dc HEAD -- IDEA2-AEGIS_Monitor IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/recording_authority.py IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/segment_recorder.py IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent`
  — PASS: protected sources byte-identical to base.
- Independent source review: no remaining Critical / Important / Minor findings.
  An Important capacity-edge regression was reproduced and fixed: new alert
  publication/persistence must survive a full Telegram ledger.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — source task,
  session checkpoint, offline results and remaining owner gates.

## Shared surfaces touched

None — all application/configuration changes are inside the IDEA2 Engine boundary.

## Integration requests

- Pub: independent human source approval, dependency acceptance and approval of
  any later Machine C configuration/installation step. Existing canonical
  `AEGIS_NODE_ID=mr-tk-01` remains unchanged; the two optional runtime fields are
  `AEGIS_TELEGRAM_NODE_DISPLAY_NAME=Machine C` and
  `AEGIS_TELEGRAM_NO_AMBIGUOUS_RETRY=true`.
- Reuse existing owner-managed bot/group credentials out-of-band; neither their
  presence on C nor delivery is proven here. Do not change Machine A settings.
- Keep Draft. No Ready, merge, deployment or runtime acceptance was authorized.
  Any later rollout/rollback requires separate owner authorization; rollback
  affects only this Engine sender patch/config and must not alter camera authority.

## Known limitations

- Delivery on Machine C is NOT TESTED. No real send, bot/group inspection,
  microphone/webcam operation or installed runtime access occurred.
- No Production, Machine A/C, Twingate, clock, tunnel, Agent, capture, recording,
  Archive, UI or GPU mutation. PR #410/#418 are separate and untouched.
- Duplicate protection is a bounded process-local safety control, not durable
  global exactly-once delivery. Capacity-suppressed alerts still persist as
  unconfirmed; their delivery is not claimed.
- The receipt closes the SOURCE task with intentionally partial runtime maturity.
  Human approval, dependency merge order, runtime configuration and independently
  authorized actual Machine C delivery remain pending.
