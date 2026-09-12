# IDEA3 PR10 S2 Server → Core Boundary — TDD and Verification Plan

> **For agentic workers:** execute task by task with test-first steps. Each
> step uses checkbox (`- [ ]`) syntax for tracking. **Gate G1 must be approved
> by the owner before Task 1.**

**Goal:** implement and verify, in the repository only, the durable
authenticated Server → Core accepted-action boundary from inventory §13.3,
decision D7, and the IDEA3 side of decision D5.

**Architecture:**

- **Web:**
  - an additive SQLite schema v3 dispatch ledger;
  - Admin acceptance mints an action with a 120 s TTL;
  - a separate machine Express app for list, claim, and evidence, with a
    machine-identity check.
- **Core:**
  - a durable dispatch ledger;
  - an injectable HTTPS client;
  - a worker that claims and publishes only through
    `AegisSupervisor.issue_command`.
- **Default:** both halves are off by default.

**Tech stack:**

- Python with pytest (`pytest.ini`: `pythonpath = .`) and Ruff
  (`ruff.toml`);
- Node.js with Express 5, `node:sqlite`, zod, Vitest, supertest, and Vite.

**Spec:**
`IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-12-idea3-pr10-s2-server-core-boundary-design.md`

**Base:** `b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95`

**Branch:** `feat/idea3-pr10-s2-server-core-boundary`

## Global constraints

- **Safety settings:**
  - `PRODUCTION_MUTATION_ALLOWED = NO`;
  - `PRODUCTION_CHANGE_AUTHORIZED = NONE`;
  - evidence class LOCAL / SIMULATED only.
- **Test resources:** only disposable temporary directories, in-memory or
  temporary SQLite, loopback listeners, injected clocks, fake transports, fake
  MQTT managers, and dry-run controllers.
- **Preserved properties:**
  - `WEB_TO_MQTT = NO`;
  - `Requested ≠ Published ≠ ACK ≠ Executed ≠ Relay ≠ Physical`;
  - no RESTORE on any shutdown, restart, or boundary path.
- **Forbidden actions:**
  - no NGINX, Compose, Docker, network, firewall, router, VLAN, Twingate,
    certificate, firmware, broker, or hardware action;
  - no SSH;
  - no IDEA1, IDEA2, or shared path.
- **Stop rule:** if a non-IDEA3 path becomes necessary, stop and report.
- **Topology (spec §4.4):**
  - `AEGIS_IDEA3_DISPATCH_PORT` is an application/container-internal listener
    port. No new host-published port is created.
  - HUB/NGINX on HTTPS 443 stays the only external entry.
  - In Production, the machine listener is reachable only over the HUB↔IDEA3
    internal network, and must not be bound only to container loopback.
  - The machine listener's bind address comes from `AEGIS_IDEA3_DISPATCH_HOST`;
    loopback is never hard-coded as the only possible bind address. Local and
    test execution may use the `127.0.0.1` default.
  - The Production bind value is neither selected nor deployed in S2. It is
    deferred, with the network wiring, to K4/K5/K7 (and D3).
  - Loopback listeners and addresses in tests are local fixtures, not the
    Production topology.
- **Commits and merges:**
  - each task ends with an implementation/evidence commit, followed by a
    documentation commit that records its SHA in the S2 Session Register
    (two-commit pattern);
  - if `origin/main` advances, `git merge origin/main`; no rebase, no
    force-push.
- **Test honesty:** existing tests change only where S2 deliberately changes
  behaviour (schema v2 → v3 expectations). Each such change is named in the
  commit and the session record.

## Test matrix

### Regression suites (run in Task 0 and Task 10)

| Suite | Command (cwd) | Pass bar |
|---|---|---|
| Python full | `python -m pytest -p no:cacheprovider -q` (`IDEA3-AEGIS_Lockdown`) | 0 failed; count recorded against the Task 0 baseline. PR9 recorded 245 passed / 6 skipped |
| Ruff | `ruff check .` (`IDEA3-AEGIS_Lockdown`) | clean |
| Compile | `python -m compileall -q aegis_soc` (`IDEA3-AEGIS_Lockdown`) | exit 0 |
| Web full | `npm test` (`IDEA3-AEGIS_Lockdown/web`) | 0 failed; PR9 recorded 309/309 |
| Web build | `npm run build` (`IDEA3-AEGIS_Lockdown/web`) | exit 0 |
| npm audit | `npm audit` (`IDEA3-AEGIS_Lockdown/web`) | 0 vulnerabilities |
| PR9 acceptance driver | `deploy/production-like-acceptance.py`, loopback only, dispatch disabled | `PRODUCTION_LIKE_VERIFIED` |
| PR9 negative-control driver | `deploy/production-like-negative-controls.py`, loopback only | 13/13 |
| Repository | `node --test --test-concurrency=1 tests/*.test.mjs` (repo root) | 0 failed; PR9 recorded 63/63 |
| Vault | `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` | pass |
| Policy | `node scripts/validate-collaboration-policy.mjs` with a Draft event and `git diff --name-status` input | pass |
| Diff and hygiene | `git diff --check`; secret/key/artifact scan of changed paths | pass |

### New Web tests

| ID | Test | File |
|---|---|---|
| W1 | a fresh database is created at v3 with the dispatch tables | `web/tests/server/dispatchLedger.test.js` |
| W2 | a v2 database with rows upgrades to v3 with every row kept; reopening changes nothing | same |
| W3 | readiness returns 200 only at v3; an unknown version fails closed | `web/tests/server/sqliteRepository.test.js` |
| W4 | acceptance mints exactly one `action_id` (UUID, not the incident ID) in the same transaction; an injected failure writes neither the decision nor the action | `dispatchLedger.test.js`, `containmentAcceptance.test.js` |
| W5 | a repeat acceptance is `UNCHANGED` and returns the same action; the opposite decision is 409; no second action exists | same |
| W6 | a claim within the TTL → 200 `CORE_CLAIMED` with an audit row | `web/tests/server/machineRoutes.test.js` |
| W7 | parallel claims (`Promise.all`), and two repository connections on one temporary file: exactly one winner, the rest 409 | `machineRoutes.test.js`, `dispatchLedger.test.js` |
| W8 | at 120 s + 1 ms (fake clock): `EXPIRED`, not listed, claim 410 | same |
| W9 | each of these returns 403 with no state change: boundary disabled (listener absent / 404); wrong peer; verify ≠ `SUCCESS`; wrong subject; missing headers; escaped/multi-valued/duplicate-CN DN; any `Cookie`; any `Origin` | `machineRoutes.test.js` |
| W10 | the browser app returns 404 for every machine path (and its case variants); the machine app returns 404 for Admin, auth, and security routes | same |
| W11 | minting or claiming anything other than `CUT_UPLINK` is refused by both the domain check and the SQL `CHECK` | `dispatchLedger.test.js` |
| W12 | evidence is append-only; an identical replay is `UNCHANGED`; a changed replay is 409; an unknown action is 404; an unclaimed action is 409; an ACK never sets `executed` or `physical_evidence`; the `detail` allowlist is enforced | `dispatchLedger.test.js`, `machineRoutes.test.js` |
| W13 | pending with no machine contact → `DISPATCH_UNAVAILABLE`; no state ever shows "Contained"; `OUTCOME_UNKNOWN` is surfaced; the dashboard acknowledgement allowlist is correct | `machineRoutes.test.js`, `status.test.js` |
| W14 | the database is closed and reopened: pending actions are kept until expiry | `dispatchLedger.test.js` |

### New Core tests

| ID | Test | File |
|---|---|---|
| C1 | `CLAIM_REQUESTED` is durable before the claim call. A simulated crash after the claim and before the publish → restart gives `OUTCOME_UNKNOWN` with no publish | `tests/test_dispatch_boundary.py` |
| C2 | expired on the Core clock (including a clock-ahead skew) → no claim, or `EXPIRED_AT_CORE` with no publish | same |
| C3 | a replayed or duplicate `action_id` → no second `issue_command` call | `tests/test_dispatch_ledger.py`, `test_dispatch_boundary.py` |
| C4 | the action → nonce link is stored; the ACK/STATUS correlation is stored; a mismatched nonce is ignored | same |
| C5 | no ACK after `ACK_TIMEOUT_SEC`, a non-OK ACK, or no correlated STATUS → `OUTCOME_UNKNOWN`, no retry | `test_dispatch_boundary.py` |
| C6 | the worker never issues RESTORE; a non-`CUT_UPLINK` pending action is refused; the ledger `CHECK` refuses RESTORE; supervisor shutdown publishes no `RESTORE_UPLINK` with the worker enabled | same |
| C7 | server unreachable → the outbox is kept; later delivered in order and idempotently; a definitive 4xx is `REJECTED_BY_SERVER` | `tests/test_dispatch_client.py`, `test_dispatch_boundary.py` |
| C8 | a missing certificate, key, or CA file, or a TLS/certificate transport failure → `PAUSED_CREDENTIAL`, no claim, no publish, no CUT | same |
| C9 | publishing happens only through `issue_command`; a source-scan test proves the dispatch modules never import or call the controller, MQTT, or `publish` | `test_dispatch_boundary.py` |
| C10 | dispatch disabled → no worker; existing supervisor behaviour and the PR9 drivers are unchanged | `test_dispatch_boundary.py`, regression suites |

A shared contract fixture,
`IDEA3-AEGIS_Lockdown/tests/fixtures/dispatch-contract.json`, is read by both
Vitest and pytest. It pins the paths, fields, stages, and status codes, so the
two halves cannot drift apart.

### Negative controls (Task 9; never committed)

| Control | Mutation (temporary, local) | Expected failure |
|---|---|---|
| NC1 unique dispatch | drop `UNIQUE` on `incident_id` / the domain duplicate guard | W5 |
| NC2 expiry | remove `expires_at > ?` from the claim | W8 |
| NC3 machine identity | skip the subject comparison | W9 |
| NC4 claim-before-publish | publish before `begin_claim` is committed | C1 |
| NC5 RESTORE rejection | allow a non-`CUT_UPLINK` action in the worker | C6 / W11 |

For each control: apply the mutation, observe the named test fail, restore
with `git checkout -- <file>`, observe the pass, and prove
`git status --short` is clean for that file. Record the control, the
mutation, the observed failure, the restoration, the final pass, and the
residue check.

---

### Gate G1 — owner review (STOP)

- [ ] The spec and this plan are committed and pushed; the S2 Session Register
      records the G1 checkpoint SHA.
- [ ] **Stop.** No source file changes until the owner explicitly approves G1,
      including the §11 design choices in the spec.

### Task 0: Baseline (no source change)

- [ ] Record the Python and Node versions, the OS, and `git rev-parse HEAD`.
- [ ] Run every regression suite in the matrix at the G1 head; record the
      exact counts and exit codes as the S2 baseline.
- [ ] Record any pre-existing failure honestly as pre-existing. Do not fix
      unrelated failures in S2.

### Task 1: Web schema v3 and dispatch domain (W1, W2, W3, W14)

**Files:**

- **Create:** `web/server/domain/dispatch.js` (vocabulary, TTL constant,
  stage allowlist, state derivation).
- **Modify:**
  - `web/server/repositories/sqliteRepository.js` (v3 tables,
    `MIGRATABLE_VERSIONS = {1, 2}`);
  - `web/server/repositories/memoryRepository.js` (parity);
  - `web/server/createApp.js` (readiness requires v3).
- **Tests:**
  - create `web/tests/server/dispatchLedger.test.js`;
  - modify `web/tests/server/sqliteRepository.test.js` (the v2 expectations
    become v3 — a deliberate change).

- [ ] RED: write W1, W2, W3, and W14; run
      `npx vitest run tests/server/dispatchLedger.test.js tests/server/sqliteRepository.test.js`;
      confirm they fail for the expected reason.
- [ ] GREEN: implement the minimum schema and migration; rerun until they pass.
- [ ] Run the full `npm test`; commit `feat(idea3): add PR10 dispatch schema v3`.

### Task 2: Minting at acceptance, expiry, and CUT-only (W4, W5, W8, W11)

**Files:**

- **Modify:**
  - `web/server/repositories/sqliteRepository.js` and `memoryRepository.js`
    (mint in the decision transaction; expiry);
  - `web/server/domain/containment.js` (response and boundary mapping);
  - `web/server/routes/securityRoutes.js`;
  - `web/server/config.js` (dispatch keys);
  - `IDEA3-AEGIS_Lockdown/.env.example` (placeholder keys).
- **Tests:**
  - `dispatchLedger.test.js`;
  - `containmentAcceptance.test.js`;
  - `config.test.js` (key validation). This includes `AEGIS_IDEA3_DISPATCH_HOST`:
    - the `127.0.0.1` default outside production;
    - a non-loopback RFC 5737 documentation address is accepted;
    - hostnames, the unspecified addresses, and invalid values are rejected;
    - production with dispatch enabled requires an explicit non-loopback
      value.

    These are supporting config tests, not new W IDs.

- [ ] RED, then GREEN, per test.
- [ ] Existing acceptance tests stay green with dispatch disabled; the
      disabled response is unchanged.
- [ ] Run the full `npm test`; commit
      `feat(idea3): mint PR10 dispatch actions at acceptance`.

### Task 3: Machine app, identity, and claim (W6, W7, W9, W10)

**Files:**

- **Create:**
  - `web/server/createMachineApp.js`;
  - `web/server/routes/machineRoutes.js`;
  - `web/server/security/machineIdentity.js`.
- **Modify:** `web/server/index.js` (one shared repository and contact
  tracker). The machine listener starts only when enabled. It listens on the
  application-internal `AEGIS_IDEA3_DISPATCH_PORT` and the configured
  `AEGIS_IDEA3_DISPATCH_HOST`, never a hard-coded address. A test with an
  injected `listen` proves the configured host and port are used. Tests bind
  loopback, which is a local fixture rather than the Production topology.
- **Tests:** create `web/tests/server/machineRoutes.test.js`.

- [ ] RED: identity negatives first (W9), then the claim (W6, W7), then
      isolation (W10).
- [ ] GREEN: implement until they pass.
- [ ] Run the full `npm test`; commit
      `feat(idea3): add PR10 machine dispatch endpoints`.

### Task 4: Evidence ingest and display (W12, W13)

**Files:**

- **Modify:**
  - the repositories (evidence and `apply()` overlay);
  - `web/server/domain/dispatch.js`;
  - `web/server/routes/machineRoutes.js`;
  - UI files, only if W13 requires them: `web/src/lib/dashboard.js` and/or
    `web/src/pages/DashboardPage.jsx` (acknowledgement allowlist), and
    `web/src/lib/i18n.js` (labels).
- **Tests:** `dispatchLedger.test.js`, `machineRoutes.test.js`,
  `status.test.js`.

- [ ] RED, then GREEN.
- [ ] Run `npm test` and `npm run build`; commit
      `feat(idea3): reconcile PR10 dispatch evidence and status`.

### Task 5: Core dispatch ledger (C3, C4 storage, C6 CHECK)

**Files:**

- **Create:**
  - `aegis_soc/dispatch_ledger.py`;
  - `tests/test_dispatch_ledger.py`.
- **Modify:**
  - `aegis_soc/paths.py` (`dispatch_db`);
  - `aegis_soc/production_runtime.py` (pass `AEGIS_CORE_DISPATCH_DB_PATH`);
  - `tests/test_paths.py`;
  - `tests/test_production_runtime.py`.

- [ ] RED, then GREEN, using `tmp_path` databases only.
- [ ] Run the full pytest and Ruff; commit
      `feat(idea3): add PR10 Core dispatch ledger`.

### Task 6: Core client and credential pause (C7 transport, C8)

**Files:**

- **Create:**
  - `aegis_soc/dispatch_client.py`;
  - `tests/test_dispatch_client.py`.

- [ ] RED, then GREEN with a fake transport only. The TLS-context builder is
      tested for refusing missing or relative paths without loading any key.
- [ ] Commit `feat(idea3): add PR10 Core dispatch client`.

### Task 7: Worker and supervisor integration (C1, C2, C3, C5, C6, C7, C9, C10)

**Files:**

- **Create:**
  - `aegis_soc/dispatch_worker.py`;
  - `tests/test_dispatch_boundary.py`.
- **Modify:** `aegis_soc/supervisor.py` (optional worker; `tick` in the loop;
  forward correlated ACK/STATUS).

- [ ] RED, then GREEN, using a dry-run controller or a fake MQTT manager, a
      fake client, and injected clocks.
- [ ] Run the full pytest, Ruff, and compileall; commit
      `feat(idea3): add PR10 Core dispatch worker`.

### Task 8: Shared contract fixture

**Files:**

- **Create:** `tests/fixtures/dispatch-contract.json`.
- **Modify:** the Web and Core tests that read it.

- [ ] Both suites assert the same paths, fields, stages, and codes; commit
      `test(idea3): pin PR10 dispatch contract`.

### Task 9: Negative controls NC1–NC5

- [ ] Execute each control per the table above. Record the evidence in the S2
      session record, not in the receipt only.
- [ ] Prove the working tree is clean afterwards.

### Task 10: Full regression and governance

- [ ] Run every suite in the matrix. Compare against the Task 0 baseline.
      Explain every count change: new tests added, or deliberate changed
      expectations.
- [ ] Run the PR9 drivers loopback-only with dispatch disabled.
- [ ] Run the vault validator, the policy validator, `git diff --check`, and
      the secret/key/artifact scan.

### Task 11: Canonical closeout and Draft PR (STOP before Ready)

- [ ] Update `idea3/idea3-status.md`:
  - the S2 session end fields (§7 of the workflow);
  - the register row CLOSED/PASS, only with evidence;
  - the dashboard.
- [ ] Update `idea3-moc.md` minimally.
- [ ] Update the inventory state lines.
- [ ] Add one receipt,
      `90-Status/logs/<date>_<time>_music_idea3-pr10-s2-server-core-boundary.md`.
      It is an S2 receipt, not the final PR10 receipt.
- [ ] Push and open or update a **Draft** PR titled
      `feat(idea3): implement PR10 S2 server-core accepted-action boundary`.
      Its body references PR #120 / `93170862`, the S1 inventory, PR #121, and
      PR #122 / `b2f61ebf`.
- [ ] **Stop before Ready.** A human reviewer merges.

## Acceptance criteria (S2)

1. G1 was approved by the owner before any source change.
2. W1–W14 and C1–C10 pass; NC1–NC5 are recorded with no residue.
3. Every regression suite meets its bar. The PR9 drivers still report
   `PRODUCTION_LIKE_VERIFIED` and 13/13.
4. Dispatch is disabled by default on both halves; PR9 behaviour is unchanged.
5. There is no real network, broker, certificate, or hardware use. Every piece
   of evidence is labelled LOCAL / SIMULATED.
6. The canonical S2 record is current, with checkpoint SHAs. There is one
   receipt, and the vault, policy, and diff checks pass.
7. The Draft PR contains only IDEA3 paths. The agent stops before Ready.
