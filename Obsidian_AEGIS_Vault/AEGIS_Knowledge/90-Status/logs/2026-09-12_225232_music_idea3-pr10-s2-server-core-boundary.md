---
title: Task Receipt — IDEA3 PR10 S2 Server → Core accepted-action boundary
date: 2026-09-12T22:52:32+07:00
owner: music
area: idea3
branch: feat/idea3-pr10-s2-server-core-boundary
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR10 S2 Server → Core accepted-action boundary

## What changed

**PR10 S2** implemented the Server → Core durable accepted-action machine
boundary in IDEA3: inventory §13.3, D7, and the IDEA3 side of D5. The work is
**repository-only and non-Production**. It is an S2 receipt, **not** the
final PR10 receipt.

```text
TASK                      = IDEA3 PR10 S2 — Server → Core durable accepted-action machine boundary (repository-only, non-Production)
PR                        = #123 (Draft) — feat(idea3): implement PR10 S2 server-core accepted-action boundary
BRANCH                    = feat/idea3-pr10-s2-server-core-boundary
S2 BASE SHA               = b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95 (PR #122 merge; origin/main unchanged at closeout)
FINAL IMPLEMENTATION/EVIDENCE CHECKPOINT = 7d6e216f1d3e15964cbffc4d9396fce5db8150c4 (Task 10 record, immediately preceding this receipt)
FINAL HEAD                = the receipt-bearing closeout commit; recorded in PR #123 and the final report after Git assigns it
G1                        = APPROVED by the owner (2026-09-12) at 32545cebcba8bd8ed9f7a60a930a5e622d8aa717
PR10_S2                   = PASS / CLOSED
PR10                      = IN PROGRESS
EVIDENCE_CLASS            = LOCAL / SIMULATED
PRODUCTION_CHANGE_AUTHORIZED = NONE
PRODUCTION_MUTATION       = NONE
PRODUCTION_DEPLOYED       = NO
IDEA3_PRODUCTION_COMPLETE = NO
TWINGATE_USED             = NO
SSH_USED                  = NO
REAL_MQTT_USED            = NO
REAL_CERTIFICATES_OR_KEYS_USED = NO
HARDWARE_CONTACTED        = NO
VITEST_UPGRADED           = NO
```

### Plan and scope

This PR continues PR10 under the continuation model the owner approved. It
references:

- PR #120 and merge `93170862`, the premature S1 documentation checkpoint;
- the S1 inventory;
- PR #121, the reconciliation;
- PR #122 (`b2f61ebf`), the S1 closeout.

The approved design is
`IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-12-idea3-pr10-s2-server-core-boundary-design.md`,
and the TDD plan is
`IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-12-idea3-pr10-s2-server-core-boundary.md`.

Every piece of evidence uses temporary SQLite files, fakes, injected clocks,
and loopback only.

### Task status

| Task | Result | Checkpoint |
|---|---|---|
| G1 design + TDD plan | APPROVED by the owner 2026-09-12 | `32545ceb` (earlier `6076ef85`, `f1c5c1e1`) |
| 0 regression baseline | recorded | `640cebc9` |
| 1 Web schema v3 + dispatch domain (W1, W2, W3, W14) | PASS | `677acbe6` |
| 2 dispatch action at acceptance (W4, W5, W14; W8/W11 repository side) | PASS | `3f67cd85`; coverage follow-up `94cfb2bf` |
| 3 machine app, identity, claim (W6, W7, W9, W10; completes W8, W11) | PASS | `5cae52e3` |
| 4 evidence ingest + dispatch display (W12, W13) | PASS; acknowledgement refinement owner-accepted | `93143422` |
| 5 Core dispatch ledger (C3, C4, C6) | PASS | `9f0f7930` |
| 6 Core dispatch client (C2, C7, C8 transport) | PASS | `ba07feb4` |
| 7 Core worker + supervisor integration (completes C1–C10) | PASS | `1e4af697` |
| 8 shared Web↔Core contract fixture | PASS | `82a67326`; record `b5c41e27` |
| 9 negative controls NC1–NC5 | PASS | `74eb2c99` (C6 test); record `ed9efc4e` |
| 10 full regression bar | PASS | at `ed9efc4e`; record `7d6e216f` |
| 11 closeout, receipt, Draft PR | PASS | this closeout commit |

### Implementation

**Web:**

- **Schema v3:** `dispatch_actions` and `dispatch_evidence`, with
  `AUDIT_SCHEMA_VERSION = 3`. The v2 → v3 migration moves forward only and
  keeps every row.
- **Minting:** an Admin `ACCEPT` mints exactly one pending `CUT_UPLINK`
  action (UUID, 120 s expiry) in the same transaction as the decision.
- **Separate machine app:** disabled by default. It binds through
  `AEGIS_IDEA3_DISPATCH_HOST`/`PORT`, defaulting to `127.0.0.1`.
- **Machine identity guard:** it requires the pinned peer,
  `X-AEGIS-Client-Verify: SUCCESS`, and a subject with exactly one CN. It
  rejects any cookie or `Origin`.
- **Machine routes:** list pending actions, atomic single-shot claim, and
  allowlisted append-only evidence ingest.
- **Dashboard:** it shows each dispatch stage without upgrading it. It never
  shows "Contained", and it surfaces `DISPATCH_UNAVAILABLE` and
  `OUTCOME_UNKNOWN`.

**Core:**

- **`DispatchLedger`:** durable SQLite storage, forward-only states, and an
  evidence outbox.
- **`DispatchClient`:** typed results. Failures are reported as `NETWORK`,
  `CREDENTIAL`, `SERVER`, or `PROTOCOL`.
- **`DispatchWorker`:**
  - it records the claim intent durably before sending the claim;
  - it publishes only through `supervisor.issue_command`;
  - after a restart, unresolved work becomes `OUTCOME_UNKNOWN` and is never
    republished;
  - it checks expiry on the Core clock;
  - it correlates ACK and STATUS by nonce, and turns timeouts into
    `OUTCOME_UNKNOWN`;
  - it keeps outbox evidence and delivers it idempotently;
  - it pauses on a credential failure.
- `build_dispatch_worker_from_environment` is disabled by default.

**Shared contract:** `tests/fixtures/dispatch-contract.json` is read by both
suites.

The evidence ladder is preserved: Requested ≠ Published ≠ ACK ≠ Executed ≠
Relay Confirmation ≠ Physical Evidence. No machine evidence sets `executed` or
`physical_evidence`.

### Test matrix

- **W1–W14 (Web): all PASS.** They cover:
  - v3 creation and migration;
  - readiness failing closed;
  - atomic, unique minting;
  - claim within the TTL, and parallel claims with exactly one winner;
  - expiry at 120 s;
  - every machine-identity failure → 403 with no state change;
  - browser and machine apps sharing no routes;
  - `CUT_UPLINK` only, enforced by the domain check and the SQL `CHECK`;
  - append-only allowlisted evidence;
  - the display states;
  - persistence across a restart.
- **C1–C10 (Core): all PASS.** They cover:
  - claim intent before the claim, with restart → `OUTCOME_UNKNOWN`;
  - Core-clock expiry;
  - no replayed publish;
  - nonce correlation;
  - timeout → `OUTCOME_UNKNOWN` with no retry;
  - never RESTORE;
  - the idempotent outbox;
  - the credential pause;
  - publishing only through `issue_command`;
  - disabled by default, with PR9 unchanged.
- **Contract:** Web 9/9, Core 7/7. No Web/Core mismatch was found.

### Negative controls NC1–NC5

Each control temporarily broke exactly one invariant. The source was
restored with `git checkout -- <file>`, and `git diff --quiet` proved no
residue. Nothing injected was committed.

| Control | Mutated run | Restored | Verdict |
|---|---|---|---|
| NC1 unique dispatch (drop `UNIQUE` + duplicate guard) | 9 W5 tests FAIL | 9/9 PASS | OBSERVED |
| NC2 expiry, plan-exact (remove `expires_at > ?`) | 7/7 W8 PASS | 7/7 PASS | NOT OBSERVED — masked by the claim's in-transaction expiry sweep |
| NC2B (clause + sweep removed) | the W8 claim test FAILS (`CLAIMED` instead of `EXPIRED`) | 7/7 PASS | OBSERVED |
| NC3 machine identity (skip the subject check) | 6 W9 subject tests FAIL (200 instead of 403) | 17/17 PASS | OBSERVED |
| NC4 claim-before-publish (`begin_claim` after `issue_command`) | the C1 ordering test FAILS | 1/1 PASS | OBSERVED |
| NC5 RESTORE rejection (worker filter removed), first run | 52/52 PASS | 52/52 PASS | NOT OBSERVED — C6 worker-test gap |
| NC5 after test-only fix `74eb2c99` | 3 new C6 cases FAIL (`ValueError`) | 55/55 PASS | OBSERVED |

### Production safety evidence

No Twingate, SSH, live AEGIS Server, live Core host, real MQTT broker, real
CA, certificate, or key, hardware, firmware flashing, or physical CUT or
RESTORE was used.

No HUB, NGINX, Production Docker or Compose, network, firewall, router, VLAN,
Twingate, IDEA1, IDEA2, or shared runtime surface was modified.

The PR9 drivers:

- ran one at a time, with dispatch disabled;
- left 0 surviving processes and no new listeners;
- reported `productionMutation = false`.

## Source files changed

All 45 paths are against `b2f61ebf`. Every one is IDEA3-owned or this receipt.

- **Modified (`M`), under `IDEA3-AEGIS_Lockdown/`:**
  - `.env.example`;
  - `aegis_soc/paths.py`, `aegis_soc/production_runtime.py`,
    `aegis_soc/supervisor.py`;
  - `deploy/production-like-acceptance.py`;
  - `docs/operations/PR10_DEPLOYMENT_INVENTORY.md` — state lines only;
  - `tests/test_paths.py`, `tests/test_production_runtime.py`;
  - `web/server/config.js`, `web/server/createApp.js`,
    `web/server/domain/containment.js`, `web/server/index.js`,
    `web/server/repositories/memoryRepository.js`,
    `web/server/repositories/sqliteRepository.js`,
    `web/server/routes/securityRoutes.js`, `web/server/runtime.js`;
  - `web/src/lib/dashboard.js`, `web/src/lib/i18n.js`,
    `web/src/pages/DashboardPage.jsx`;
  - `web/tests/server/config.test.js`,
    `web/tests/server/containmentAcceptance.test.js`,
    `web/tests/server/productionRuntime.test.js`,
    `web/tests/server/sqliteRepository.test.js`,
    `web/tests/server/status.test.js`.
- **Added (`A`), under `IDEA3-AEGIS_Lockdown/`:**
  - `aegis_soc/dispatch_client.py`, `aegis_soc/dispatch_ledger.py`,
    `aegis_soc/dispatch_worker.py`;
  - `docs/superpowers/plans/2026-09-12-idea3-pr10-s2-server-core-boundary.md`;
  - `docs/superpowers/specs/2026-09-12-idea3-pr10-s2-server-core-boundary-design.md`;
  - `tests/fixtures/dispatch-contract.json`;
  - `tests/test_dispatch_boundary.py`, `tests/test_dispatch_client.py`,
    `tests/test_dispatch_contract.py`, `tests/test_dispatch_ledger.py`;
  - `web/server/createMachineApp.js`, `web/server/domain/dispatch.js`,
    `web/server/routes/machineRoutes.js`,
    `web/server/security/machineIdentity.js`;
  - `web/tests/client/dashboardDispatch.test.jsx`;
  - `web/tests/server/dispatchContract.test.js`,
    `web/tests/server/dispatchLedger.test.js`,
    `web/tests/server/machineRoutes.test.js`.
- **Modified (`M`), under `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/`:**
  `idea3-moc.md`, `idea3-status.md`.
- **Added (`A`):**
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-12_225232_music_idea3-pr10-s2-server-core-boundary.md`
  — this single receipt.

## Verification evidence

- `python -m pytest -p no:cacheprovider -q` — pass: 334 passed, 6 skipped.
  This is 245 → 334 against the Task 0 baseline, and all +89 are new S2 Core
  tests. The 6 skips are the baseline PowerShell 7 skips.
- `ruff check --no-cache aegis_soc tests windows deploy detector.py sim_auto_detector.py server_admin.py`
  — pass.
- `python -m compileall -q aegis_soc deploy windows detector.py server_admin.py sim_auto_detector.py tests`
  — pass.
- `npx vitest run` — pass: 493 passed in 28 files. This is 309 in 24 → 493 in
  28 against the baseline.
- `npx vite build` — pass: 1,677 modules.
- `npm audit --omit=dev --offline` — pass: 0 vulnerabilities.
- `npm audit --omit=dev` — pass: 0 vulnerabilities.
- `npm audit` (full) — exit 1, 2 moderate. This is only the **known dev-only
  baseline** GHSA-82fw-gwwq-j7x9 (`vitest@3.2.7` via `@vitest/mocker`), which
  the owner accepted on 2026-09-12. There is no new finding, and Vitest was
  not upgraded.
- `python deploy/production-like-acceptance.py --data-root <disposable path with spaces>`
  — pass: `PRODUCTION_LIKE_VERIFIED`. Details:
  - 2 generations; Web `READY`;
  - audit `PERSISTED_ACROSS_RESTART`;
  - IDEA1, IDEA2, and MQTT `NOT_CONFIGURED`; ESP32 and physical evidence
    `UNKNOWN`;
  - 3 processes per generation, 0 surviving;
  - control token `ABSENT`; final `STOPPED`; `productionMutation = false`.
- `python deploy/production-like-negative-controls.py --data-root <disposable path with spaces>`
  — pass: 13 cases, 0 failed.
- `node --test --test-concurrency=1 tests/*.test.mjs` — pass: 63/63, including
  the collaboration-policy tests.
- `node scripts/validate-vault.mjs` — pass, with the 2 known owner-data canvas
  warnings.
- `node scripts/validate-collaboration-policy.mjs --event <Draft event> --changed-files <git diff --name-status origin/main HEAD>`
  — pass, on the PR #123 body with the final changed paths including this
  receipt.
- `git diff --check origin/main HEAD` — pass.
- Secret, key, and artifact scan of the added lines — pass. The only hit is
  the existing test-fixture password `correct-horse-battery-staple`.
- Changed-path check — pass: IDEA3 paths plus this receipt only.

All results above come from the full regression bar (Task 10) at `ed9efc4e`.
The unit suites ran first, then the PR9 drivers one at a time.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`:
  - the S2 session record (Tasks 0–11, with the §7 session-end fields);
  - the S2 register row, CLOSED / PASS;
  - the PR10 Current Task state;
  - the PR10 Task Status Dashboard.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — the PR10 entry
  sentence.

## Shared surfaces touched

- None. Every changed path is Music-owned IDEA3 source, tests, or
  documentation, or this receipt. No IDEA1, IDEA2, HUB, infrastructure,
  shared, or runtime file changed.

## Integration requests

- None required for this repository-only PR.
- Remaining Production dependencies, each needing its own reviewed and
  authorized change (none is authorized by S2):
  - **Kla:** K1 (HUB NGINX Git↔runtime baseline), K2 (the `/security/`
    contract), K4/K5 (the IDEA3 subnet and internal network, which also select
    the Production `AEGIS_IDEA3_DISPATCH_HOST`), K6 (no host-firewall change),
    K7 (the HUB recreate), K8 (the VLAN 20 → HUB 443 machine route), K9 (the
    SNI block with required mTLS and verified identity headers), K10 (the
    machine-client CA and certificate issuance), K11 (optional source
    allowlisting), and K3 (sequencing with PR #118 / S5.5).
  - **Kla + IDEA1:** K12 (S5.5 state and reboot persistence) before any PR10
    rollout.
  - **Pub / IDEA2:** D6.

## Known limitations

- **Evidence class:** LOCAL / SIMULATED only. These are **not proven**:
  - real HUB mTLS;
  - the VLAN 20 → 443 path;
  - real source-address visibility;
  - the Production bind;
  - clock sync between hosts;
  - the real MQTT broker, real certificates and keys, and hardware.
- **Expiry clause:** the SQL `expires_at > ?` claim clause is kept as
  defence in depth but is not independently tested (the NC2 finding). The
  claim's expiry sweep is the tested guard.
- **C6 gap:** the worker-level refusal of a non-`CUT_UPLINK` action had no
  test until Task 9 (`74eb2c99`). Task 7's C1–C10 PASS stands, with that gap
  closed.
- **Pre-existing, not introduced by S2:**
  - the dev-only Vitest advisory;
  - `ruff format --check` drift in `tests/test_dispatch_boundary.py`, which is
    not part of the Ruff bar.
- **Remaining external or operational steps:**
  - human review and merge of Draft PR #123 (an agent never marks it Ready,
    approves it, or merges it);
  - any next PR10 session needs the owner's explicit approval;
  - Production integration is **not started**;
  - PR11 live cross-IDEA E2E stays open;
  - the final PR10 receipt comes at PR10 closeout.
- **Final task state:** `PR10_S2 = PASS / CLOSED`; `PR10 = IN PROGRESS`;
  `PRODUCTION_DEPLOYED = NO`; `IDEA3_PRODUCTION_COMPLETE = NO`.
