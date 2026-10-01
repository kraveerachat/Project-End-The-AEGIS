# AEGIS IDEA2 Physical Producer Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authorized Monitor stream route acquire one physical-camera producer generation and one demand per viewer, then send the DB-generated generation to Engine without leaking authority to the browser.

**Architecture:** Preserve migrations 001–004 and add migration 005 so epochs belong to physical camera/Node while demands retain logical alias, user, and session context. A PostgreSQL transaction locks the physical-camera row and serializes acquisition, renewal, expiry, and release. The strict Operator stream route owns a demand for its entire response and sends both Engine headers server-side.

**Tech Stack:** Node.js ESM, Express, `pg`, PostgreSQL 15 SQL, Node test runner; existing Python Engine test suite only where applicable.

**Spec:** `docs/superpowers/specs/2026-10-01-idea2-physical-producer-generation-design.md`

## Global Constraints

- Base branch `feat/idea2-machine-a-no-powershell-runtime`; work only in clean successor `fix/idea2-camera-producer-generation`, starting from design commit `f836fa099ed46eecd78d10fcc0404264ae9e7a90`.
- Physical camera plus registered Node owns an epoch. Two authorized aliases on that physical camera share its generation; the same alias on different physical cameras does not conflict.
- Migration 005 follows committed 001–004; never rewrite prior migrations, invent Node registration, or fabricate physical provenance from heartbeat.
- Strict Operator authorization and live `camera_assignment` check precede demand acquisition and Engine fetch. Absent schema/registry/DB fails closed without a legacy downgrade. Acquisition and renewal then lock and revalidate the authoritative rows in their own transaction before writing demand/epoch authority; the route precheck alone is insufficient.
- Do not change Engine generation validation, trained model, UI, Production, installed Machine A runtime, or the original dirty worktree.
- No Production migrations, provisioning, deployment, direct push to `main`, rebase, force push, or PR merge. The stacked PR remains Draft for human review.
- `docs/superpowers/specs/2026-10-01-idea2-physical-producer-generation-design.md` and this plan are exact cross-scope documentation paths to declare in the PR and final receipt.

## Exact hash and lease contract

- `session_binding_hash`: `"v1:" + lowercase_hex(HMAC-SHA-256(key=UTF8(SESSION_SECRET), data=UTF8("AEGIS/producer-demand/session/v1:") || base64url_decode_canonical(nodeSessionBinding)))`.
- `nodeSessionBinding` is the existing 32-random-byte, canonical Base64URL token minted by `establishSession`; reject missing/noncanonical/wrong-length binding. Require a nonempty configured `SESSION_SECRET` on the strict demand path. Never persist, return, or log the raw binding or HMAC key. A key rotation invalidates old demands rather than silently reauthorizing them.
- Deterministic vector: secret `fixture-session-secret-32-bytes-long!!!`, binding `ERERERERERERERERERERERERERERERERERERERERERE` (32 bytes `0x11`) produces `v1:3ea22f47d36d9f663887968c05f7f8114993867dbb408c261fae83086f295c8b`.
- Checked-in constants in `server/db/producerLifecycle.js`: `PRODUCER_LEASE_MS = 30_000`, `DEMAND_LEASE_MS = 30_000`, `STREAM_REVALIDATE_MS = 10_000`, `RENEW_BEFORE_MS = 20_000`. No browser, heartbeat, or mutable environment override. Route and tests import these constants; replace the route's private revalidation literal with this shared value.
- PostgreSQL `transaction_timestamp()` is the sole lease clock. Acquisition sets both expiries to DB time + 30 seconds. At each 10-second revalidation the route renews the exact active generation/demand when at or inside the 20-second renewal margin; it closes the stream if authorization, DB access, or renewal fails. `lease_expires_at <= transaction_timestamp()` is expired, never revived. Test time boundaries by changing lease timestamps only in disposable test schemas, not by sleeping 30 seconds.
- Preserve generation as a canonical positive decimal string from PostgreSQL `BIGINT`; never convert it to a JavaScript `Number` or accept a browser value.

## Review Focus

1. A canonical-looking but wrong-length session token or missing `SESSION_SECRET` must fail before DB writes (Task 2 hash tests).
2. A PostgreSQL `BIGINT` generation above `Number.MAX_SAFE_INTEGER` must remain exact in the Engine header (Tasks 2–3 tests).
3. Revocation between route precheck and transaction acquisition must leave no demand/upstream request (Task 2 transactional-authority test).
   Real disposable-PostgreSQL races must cover assignment revocation, account-alias/policy change, and Node/physical deactivation. A revocation committed before acquisition's authority locks wins; otherwise the conflicting update waits until acquisition completes.
4. An expired last demand followed by a new viewer must allocate a new generation, never revive the old one (Task 2 real-DB test).
5. A route error after acquisition but before response streaming must release only its demand, including when upstream returns non-2xx (Task 3 tests).

## File map

| File | Responsibility |
|---|---|
| `IDEA2-AEGIS_Monitor/server/db/migrations/005_physical_producer_ownership.sql` | Upgrade previously migrated databases without rewriting 001–004 |
| `IDEA2-AEGIS_Monitor/server/db/schema.sql` | Fresh-schema parity with post-005 ownership |
| `IDEA2-AEGIS_Monitor/server/auth/demandSessionHash.js` | Canonical, keyed session-binding digest only |
| `IDEA2-AEGIS_Monitor/server/db/producerLifecycle.js` | PostgreSQL physical-row-locked acquire, renew, release |
| `IDEA2-AEGIS_Monitor/server/auth/cameraAccess.js` | Return live verified key version and preserve fixed/account alias resolution as authorized, without changing physical ownership |
| `IDEA2-AEGIS_Monitor/server/routes/api.js` | Authorize, acquire demand, send both Engine headers, renew, release on every exit |
| `IDEA2-AEGIS_Monitor/server/streamLifecycle.js` | Reuse existing abort/cancel behavior; edit only if a focused cleanup test proves necessary |
| `IDEA2-AEGIS_Monitor/tests/registryMigrations.test.mjs` | Static plus real disposable PostgreSQL migration-chain tests |
| `IDEA2-AEGIS_Monitor/tests/producerLifecycle.test.mjs` | Hash/service unit negatives and controlled transaction tests |
| `IDEA2-AEGIS_Monitor/tests/producerLifecyclePostgres.test.mjs` | Real disposable PostgreSQL concurrency, expiry, alias-sharing, history tests |
| `IDEA2-AEGIS_Monitor/tests/physicalCameraStreamRouting.test.mjs` and `tests/streamLifecycle.test.mjs` | HTTP header, authorization-before-fetch, and lifecycle cleanup tests |
| `IDEA2-AEGIS_Monitor/package.json` | Include new suites in explicit `npm test` list |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` | Pub-owned current task/session truth and checkpoint SHA |
| One new `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_pub_idea2-physical-producer-generation.md` | Exactly one final task receipt, only at final PR-ready handoff |

---

### Task 1: Migration 005 and fresh-schema parity

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/db/migrations/005_physical_producer_ownership.sql`
- Modify: `IDEA2-AEGIS_Monitor/server/db/schema.sql`
- Modify/Test: `IDEA2-AEGIS_Monitor/tests/registryMigrations.test.mjs`

**Interfaces:** Migration 005 produces nullable historical `camera_producer_epochs.logical_camera_id`, no active-logical unique index, retained active-physical unique index, non-null `camera_producer_demands.logical_camera_id`, and nullable historical `viewer_user_id`. New code must set `viewer_user_id` for every demand.

- [ ] **Step 1: Add RED static and disposable-PostgreSQL migration tests.** Name cases `migration_005_fresh_chain_matches_schema`, `migration_005_upgrades_existing_001_004_rows`, `migration_005_rerun_is_idempotent`, and `migration_005_unbackfillable_alias_rolls_back`. Assert that `pg_indexes` has active physical uniqueness but no active logical uniqueness; one epoch accepts CAM-01 and CAM-02 demand rows; separate physical epochs may each have CAM-01; historical epoch/demand row IDs and values survive; a rerun changes neither data nor target column/index shape. For the negative case, deliberately create a drifted disposable fixture by dropping the old epoch alias NOT NULL constraint, setting one referenced historical epoch alias NULL, and asserting 005 fails atomically without partial schema change. Never construct that drift in a live DB.
- [ ] **Step 2: Run RED.** `cd IDEA2-AEGIS_Monitor; node --test tests/registryMigrations.test.mjs` with an approved disposable `AEGIS_MONITOR_TEST_DATABASE_URL`; expect new assertions to fail because 005 is absent and old constraints remain. If no disposable PostgreSQL is available, stop before claiming this task green.
- [ ] **Step 3: Implement 005.** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` demand alias/user fields; backfill demand alias only from its referenced epoch; require no NULL aliases before `SET NOT NULL`; drop only `camera_producer_epochs_active_logical_idx`; drop only epoch alias `NOT NULL`; retain historical values and active physical unique index. Order transactional statements so an unsafe backfill rolls back entirely. Make rerun idempotent without overwriting demand alias/user context.
- [ ] **Step 4: Match `schema.sql` and rerun the static and real-DB tests.** Expected all new cases pass, zero failures and zero conditional skips for the real PostgreSQL gate. Do not mutate any existing H1 or Production database.
- [ ] **Step 5: Review the exact SQL diff and checkpoint only Task 1 files.** `git diff --check`, stage exact paths, `git diff --cached --check`, commit `feat(idea2): align producer schema with physical ownership`.

### Task 2: Server-authoritative DB producer and demand lifecycle

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/auth/demandSessionHash.js`
- Create: `IDEA2-AEGIS_Monitor/server/db/producerLifecycle.js`
- Create/Test: `IDEA2-AEGIS_Monitor/tests/producerLifecycle.test.mjs`
- Create/Test: `IDEA2-AEGIS_Monitor/tests/producerLifecyclePostgres.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/auth/cameraAccess.js`

**Interfaces:** `hashProducerSessionBinding(binding, secret) -> "v1:<64 lowercase hex>"`; `createProducerLifecycle({ transact = withTransaction, secret = process.env.SESSION_SECRET, randomBytes = crypto.randomBytes }) -> { acquire({ access, sessionBinding }), renew({ handle, access, sessionBinding }), release(handle) }`. `access` is server-resolved `{ userId, nodeId, physicalCameraId, logicalCameraId, keyVersion }`; `handle` is server-only `{ producerGeneration: string, demandOwnerId: string, sessionBindingHash: string, ... }`. `release` is idempotent and callable after logout without the live session. Never serialize `handle` to a client.

- [ ] **Step 1: Write RED hash tests.** Cases `hash_binding_matches_v1_vector`, `hash_binding_rejects_noncanonical_or_missing_input`, and `hash_binding_is_keyed_and_redacted` assert the exact vector above; reject a 31-byte token, padded Base64URL, empty secret, and missing binding; changing either key or binding changes the 64-hex digest; captured errors/logs contain neither raw binding nor secret.
- [ ] **Step 2: Run RED.** `cd IDEA2-AEGIS_Monitor; node --test tests/producerLifecycle.test.mjs`; expect missing hash/service exports, not fixture or syntax failures.
- [ ] **Step 3: Implement hash helper only, then rerun its focused tests.** Decode with the existing canonical Base64URL parser, HMAC with explicit domain separation, return `v1:` plus hex. No browser-derived field or persisted raw binding.
- [ ] **Step 4: Write RED service tests and real-DB cases.** Name cases `concurrent_aliases_share_one_physical_generation`, `same_alias_on_distinct_physical_producers_does_not_conflict`, `six_account_machine_combinations_keep_physical_owner`, `transactional_revocation_prevents_acquire`, `expired_demand_never_revives_generation`, `nonfinal_release_keeps_epoch`, `final_release_retires_epoch`, `stale_renewal_is_denied`, and `generation_beyond_js_safe_integer_is_exact`. Assert one physical epoch/two differently aliased demands after concurrent acquire; two physical epochs for the same CAM-01 alias on distinct Nodes; A/B/C each keeps its own physical ID for both accounts; zero new rows on stale/mismatched authority or assignment/policy revocation; `lease_expires_at <= DB_now` cannot renew; first release leaves epoch active, final/repeated release is idempotent; a fresh acquire after expiry/release receives a different identity; `9007199254740993` remains that exact decimal string. Include both fixed and account alias policy tests. Real cases use a random disposable PostgreSQL schema and an injected transaction adapter with exact-owned-schema cleanup. Use two real connections and controlled transaction barriers to prove that assignment revocation, account-alias/policy updates, and Node/physical deactivation either commit before acquisition and deny it with zero new authority, or serialize after an acquisition that already holds every applicable authority lock.
- [ ] **Step 5: Run RED unit and real-DB tests.** Expect missing lifecycle methods/old schema assumptions; do not treat missing PostgreSQL as a product RED.
- [ ] **Step 6: Implement the service.** In acquisition and renewal use one deterministic authority-lock order: authenticated `users` row, `detection_nodes` row, `physical_cameras` row, `node_camera_alias_policy` row, applicable `node_account_camera_alias` row in account mode, then `camera_assignment` row. Use locks that conflict with non-key UPDATE/DELETE on authority rows (for example `FOR SHARE`), with `FOR UPDATE` for the physical producer row; merely locking physical camera while reading other authority rows unlocked is forbidden. Re-read/revalidate user activity, Node activity/key version, physical binding/activity, policy mode, account alias when relevant, and the live assignment **after locks are obtained and before inserting or renewing**. In `READ COMMITTED`, a change committed first must be observed and deny creation/renewal; if acquisition locks first, a conflicting change must wait. Under the physical lock retire expired rows; select only the unexpired active epoch for that physical/Node; otherwise insert one DB-identity epoch. Insert one demand per response with new 32-byte random owner token, HMAC binding, user ID, alias, and 30-second DB-clock lease. Count only unreleased, unexpired demands with non-NULL `viewer_user_id` and logical alias as valid current demand; pre-005 historical rows with NULL user are preserved but never renewed or used to keep an epoch active. Renew/release only on exact handle and current state. Preserve unique-index conflict fail-closed behavior; never use unsafe SELECT-then-INSERT outside the row lock.
- [ ] **Step 7: Run unit and real-DB GREEN and checkpoint only Task 2 files.** Include exact A/B/C alias tests; `git diff --check`, cached diff review, commit `feat(idea2): acquire physical producer and viewer demands`.

### Task 3: Stream-route integration and complete cleanup

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/server/routes/api.js`
- Modify: `IDEA2-AEGIS_Monitor/server/streamLifecycle.js` only if a focused RED test proves needed
- Modify/Test: `IDEA2-AEGIS_Monitor/tests/physicalCameraStreamRouting.test.mjs`
- Modify/Test: `IDEA2-AEGIS_Monitor/tests/streamLifecycle.test.mjs`
- Modify/Test: `IDEA2-AEGIS_Monitor/tests/machineAAccountSymmetry.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Route obtains `access` from `resolveOperatorAccess`, checks `canSeeCamera` before acquire, calls Task 2 `acquire`, and passes only `handle.producerGeneration` to the server-side Engine header. Renewal uses the same handle and live re-resolved access. Every exit passes the handle once to idempotent `release`. Do not change the compatibility route into an authority fallback.

- [ ] **Step 1: Write RED HTTP tests.** Cases `strict_stream_sends_server_generation_and_key`, `client_generation_claim_cannot_override`, `unauthorized_assignment_has_zero_side_effects`, `two_account_aliases_share_physical_upstream`, `close_and_every_upstream_failure_release_demand`, and `logout_revocation_or_renewal_failure_abort_and_release` use a controlled fake Engine and injected lifecycle. Assert exact `X-Detection-Engine-Key` and `X-Aegis-Producer-Generation` headers; generation equals returned DB decimal string despite forged query/body/header; response contains neither header value; unauthorized access is 403 with `acquireCalls === 0` and `fetchCalls === 0`; both aliases are independently authorized to the same physical/Node; release is called once for normal close, socket close, upstream non-2xx, fetch throw, route failure, idle timeout, logout, assignment revocation, and failed renewal. Assert a second viewer remains after one closes and final release retires its epoch. Preserve existing abort/reader-cancel assertions.
- [ ] **Step 2: Run RED.** `cd IDEA2-AEGIS_Monitor; node --test tests/physicalCameraStreamRouting.test.mjs tests/streamLifecycle.test.mjs tests/machineAAccountSymmetry.test.mjs`; expected missing generation/demand and cleanup failures, not fixture errors.
- [ ] **Step 3: Integrate acquisition into strict Operator path only.** Revalidate live assignment before acquisition; acquire before `fetch`; send both server-only Engine headers; restructure response lifetime so an outer `finally` releases on every post-acquire path. Preserve existing abort, reader cancellation, idle watchdog, and legacy compatibility behavior. Replace overlapping `setInterval` async revalidation with one serialized, awaited 10-second cycle that renews or fails closed.
- [ ] **Step 4: Run focused GREEN and `npm test`.** Add both new suites to the explicit package test list. Ensure zero new Monitor failures and record conditional PostgreSQL skips separately; the real-DB suite must also pass with the approved disposable URL.
- [ ] **Step 5: Scoped review and checkpoint only Task 3 files.** Inspect auth-before-network ordering, no browser leakage, exact cleanup ownership, session revocation, and stale generation; run `git diff --check` and cached review; commit `fix(idea2): bind stream fetch to physical producer generation`.

### Task 4: Final verification, canonical status, and stacked Draft PR

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Create at final source-task closeout only: one `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_pub_idea2-physical-producer-generation.md`
- No other source path unless a fresh RED test proves a defect; re-review any expansion before editing.

**Interfaces:** Status/receipt report source/local verification separately from owner-provided live Engine preflight and unperformed Production rollout. PR base is `feat/idea2-machine-a-no-powershell-runtime`, head is `fix/idea2-camera-producer-generation`, Draft throughout.

- [ ] **Step 1: Run exact final matrix.** New focused suites; `physicalCameraStreamRouting`, `machineAAccountSymmetry`, `streamLifecycle`, `nodeRegistry`, `registryMigrations`, `physicalCameraHeartbeat`, `viewerDemandAvailability`, `liveCamera`; full `npm test`; applicable Engine generation tests if present (otherwise report `NOT_PRESENT_IN_THIS_SOURCE_BRANCH` and use controlled Monitor upstream contract evidence); Vite build; `git diff --check`; changed-content secret scan; scoped security review. Inspect `server/routes/internal.js`, `server/db/store.js`, and host-side `server/cli/manage_nodes.py` against the unchanged heartbeat/registration boundary; add a focused RED test before any newly justified source edit. Require real disposable PostgreSQL migration/concurrency/expiry tests without skips before declaring source complete.
- [ ] **Step 2: Verify scope and provenance.** Confirm no Engine, UI, original dirty worktree, Production, installed Machine A, or unrelated owner path changed. Confirm migrations 001–004 byte-identical to design base. Review exact `origin/<stacked-base>...HEAD` diff and declare the two cross-scope design/plan docs in PR/receipt.
- [ ] **Step 3: Update Pub-owned canonical status and checkpoint it.** Record current task/session state, exact implementation SHA, measured tests, remaining Production migrations/registration/rollout gates, explicit presence/configuration of `SESSION_SECRET` as a Production prerequisite (never its value), and known live/source Engine-version discrepancy. Validate Vault/governance and commit exact status path.
- [ ] **Step 4: Create one final partial/source-complete receipt only when local gates are clean.** Use receipt template; record exact files, commands/counts, base/implementation SHA, cross-scope docs, honest limitations, integration requests, and Production mutation `NO`. Validate collaboration policy, Vault, diff, and secret scan; commit exact receipt path. Do not call Production or external acceptance complete.
- [ ] **Step 5: Push normally and create one Draft stacked PR.** No force push, rebase, merge, or Production action. Verify remote head, PR base/head/state, exact PR files, policy/check results; stop for human and integration review.
