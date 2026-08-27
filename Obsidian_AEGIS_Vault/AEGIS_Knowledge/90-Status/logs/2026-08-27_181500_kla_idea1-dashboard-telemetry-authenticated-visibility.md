---
title: Task Receipt — IDEA1 Dashboard Telemetry Authenticated Visibility
date: 2026-08-27T18:15:00+07:00
owner: kla
area: idea1
branch: fix/idea1-dashboard-telemetry-authenticated-visibility
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Dashboard Telemetry Authenticated Visibility

`POLICY = ALL AUTHENTICATED USERS MAY VIEW APPROVED HOST TELEMETRY`

`ANONYMOUS = 401`

`IMPLEMENTATION = SOURCE + TESTS / LOCALLY VERIFIED / NOT DEPLOYED`

`PRODUCTION_CHANGED = NO`

`TWINGATE = TRUTHFUL UNAVAILABLE / FUTURE SCOPE`

## What changed

An explicit product/RBAC decision replaced the telemetry visibility contract
that Server Telemetry V1 shipped with. This is a server-side policy change, not
a frontend workaround — the Dashboard already rendered whatever the API
reported, so the fix had to happen in the response itself.

- **OLD:** host metrics were Admin-only. `GET /api/telemetry` called
  `buildTelemetry({ includeHostMetrics: req.user.role === ROLES.ADMIN })`, and a
  DataLake-User received `available: false` / `reason: 'requires-admin'` for
  CPU, RAM, network and host uptime. The tiles read **Restricted / Requires an
  Admin role**.
- **NEW:** host telemetry is visible to all authenticated Drive users. Admin and
  DataLake-User both receive CPU, RAM, network throughput with the
  already-approved interface name, host uptime, Data Lake disk capacity, and
  Drive service uptime.
- **UNCHANGED:** anonymous = 401; the strict V1 response allowlist; least
  privilege on the agent; Twingate = `no-approved-source`.

The role-conditional branch and the `withheld()` / `requires-admin` reason were
removed from `server/telemetry/index.js` rather than merely left defaulted.
`requireAuth` is now the whole authorization boundary and is enforced once, at
the route. Keeping a role branch no caller takes would have left an untested
second policy able to disagree with the first, and one shared code path is also
what makes the Admin and DataLake-User responses provably identical in shape.

`requireAuth` was not weakened. No telemetry field was added.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — the route calls
  `buildTelemetry()` with no role argument; the Thai comment block that declared
  host counters Admin-only is replaced with the new visibility policy, the
  statement that `requireAuth` is the entire boundary, and the note that "who
  sees it" changed while "what is in it" did not.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/index.js` — removes the
  `includeHostMetrics` option, the `withheld()` helper and the `requires-admin`
  reason; host metrics, host uptime and the `ok` computation now have one path
  for every caller. The header comment records the decision, what stayed fixed,
  and the accepted load consequence.
- `IDEA1-AEGIS_Drive_LC/src/components/ServerTelemetry.jsx` — comments only. The
  generic `restricted` state is **kept** as a defensive contract and documented
  as unreachable from the current API; no rendering behavior changed.
- `IDEA1-AEGIS_Drive_LC/tests/telemetryApi.test.js` — TELEM-API-11 rewritten:
  an authenticated non-admin now reads the approved host telemetry, no body
  contains `requires-admin`, and an admin/non-admin structural comparison proves
  equal — not broader — visibility. Anonymous 401, the response allowlist,
  the environment/path leak scan, query-parameter inertness, `no-store`, audit
  hygiene and Twingate truthfulness are now asserted for **both** roles.
- `IDEA1-AEGIS_Drive_LC/tests/serverTelemetryUi.test.js` — TELEM-UI-12 rewritten:
  the normal authenticated response renders real CPU/RAM/network/host-uptime
  readings and shows no `Restricted` / `Requires an Admin role` anywhere; a
  third test keeps the withheld-vs-unmeasurable distinction covered as a
  defensive contract. Adds TELEM-UI-13 pinning the Twingate tile to
  Unavailable and never Online/Connected/Reachable.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new canonical
  subsection "Dashboard telemetry visibility policy (2026-08-27)" recording
  OLD / NEW / UNCHANGED.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-27_181500_kla_idea1-dashboard-telemetry-authenticated-visibility.md`
  — this immutable task receipt.

No string, localization, deployment, systemd, Compose, gateway, database, agent,
or Twingate file was changed.

## Verification evidence

- `node --test --test-concurrency=1 tests/telemetryApi.test.js` — PASS: 25
  discovered, 25 passed, 0 failed, 0 skipped.
  - Anonymous `GET /api/telemetry` → **401**, no `metrics`, no `enp1s0` in body.
  - Admin → **200** with CPU, memory, network (`interface=enp1s0`), host uptime,
    disk and Drive uptime all `available: true`.
  - DataLake-User → **200** with the same six available, `reason: undefined`,
    and `requires-admin` absent from the entire body.
  - Admin vs DataLake-User: identical response shape and identical host metric
    values from one snapshot.
  - `Cache-Control: no-store`, allowlist, leak scan and query-parameter
    inertness asserted for both roles; 8 admin + 8 user polls added **0** audit
    rows; malformed / unreachable / stale agent cases unchanged.
- `node --test --test-concurrency=1 tests/serverTelemetryUi.test.js` — PASS: 20
  discovered, 20 passed, 0 failed, 0 skipped.
- `npm test` in `IDEA1-AEGIS_Drive_LC` — PASS: 307 discovered, **288 passed, 0
  failed**, 19 skipped (pre-existing `TEST_DATABASE_URL` Postgres skips).
- `npm run build` in `IDEA1-AEGIS_Drive_LC` — PASS: production build succeeded.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — PASS: 53 discovered, 53 passed, 0 failed, 0 skipped.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — PASS (see limitations for unchanged pre-existing warnings).
- `node scripts/validate-collaboration-policy.mjs` — PASS.
- `git diff --check` — PASS, no whitespace error.
- Targeted secret scan over the diff for key material, tokens, passwords and
  `.env` content — no match.

All commands ran in a clean worktree created from `origin/main` at
`47342b46a7fe14276a15ea24341ecb26497d2277`.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — adds
  "Dashboard telemetry visibility policy (2026-08-27)". Replaces the durable
  fact that host metrics are Admin-only with the fact that approved host
  telemetry is visible to every authenticated Drive user, and restates what did
  not move: anonymous 401, the strict V1 allowlist, agent least privilege, and
  Twingate `no-approved-source`.

The existing "Server Telemetry V1 implementation (2026-08-27)" subsection was
left intact; this task appends its own subsection rather than rewriting that
record.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — changes the effective RBAC
  contract of a live authenticated endpoint. Authorization is a security
  boundary and reviewing a change to who may read host-level data is not an
  IDEA1-local decision.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/index.js` — the module that decides
  what leaves the process toward every Drive session, and the consumer of the
  shared host telemetry agent contract in `shared/host-telemetry-agent/`.

Both paths sit inside the IDEA1 code boundary, so they are owned rather than
cross-scope; they are declared here because their behavior is an authorization
and data-exposure contract, which `AGENTS.md` §3 classifies as a shared surface.
No path outside `IDEA1-AEGIS_Drive_LC/` and the vault was changed.

## Integration requests

- **Reviewer: Kla (integration).** Decision required: accept the RBAC contract
  change that every authenticated Drive user — not only Admin — may read the
  approved host telemetry (CPU, RAM, network throughput and approved interface
  name, host uptime, Data Lake capacity, Drive service uptime). Confirm the
  disclosure judgement explicitly: host uptime discloses the patch window and
  RAM/CPU/NIC describe the machine rather than the storage product. That was the
  stated reason for the original Admin-only rule and the product decision now
  overrides it.
- **Downstream effect:** every authenticated Dashboard poll now opens the agent
  Unix socket, where previously only an Admin's did. The agent answers from an
  in-memory snapshot behind the existing 1500 ms client ceiling, so the extra
  work is bounded and local, but concurrent non-admin sessions are a new source
  of agent traffic and should be watched during production acceptance.
- **Rollout:** source and tests only. No deployment is included, and the
  production server was not touched. Rollout is a later, separate task that must
  rebuild the Drive image and re-run acceptance.
- **Rollback:** revert this single commit. The telemetry agent, its socket,
  GID `29100`, the systemd unit, the read-only bind, the Compose delta, and the
  V1 response schema are all untouched, so rollback needs no host, agent, or
  database action — only a Drive redeploy at the previous image.

## Known limitations

- **Nothing was deployed or accepted in production.** No image was rebuilt, no
  container was recreated, and no live `/api/telemetry` response from a real
  DataLake-User session on the server was observed. Every result above is local.
- The task brief states that Server Telemetry V1 is now production accepted
  (agent active and enabled, `RuntimeDirectoryPreserve=yes`, controlled
  stop/start regression PASS, Drive seeing the socket without container
  recreation, Admin `/api/telemetry` PASS). That state is **not evidenced in
  this repository**: `idea1-status.md` still records
  `PRODUCTION_DEPLOYMENT = NOT PERFORMED` and
  `PRODUCTION_ACCEPTANCE = NOT STARTED` from the V1 integration receipt, and the
  runtime-directory receipt records `PRODUCTION_ACCEPTANCE = PENDING`. This task
  did not verify the server and therefore did not update those markers. Closing
  that gap is a separate deployment/acceptance task and its own receipt.
- The screenshot requirement in the brief is satisfied at the contract level
  only: the API no longer emits `requires-admin` and the UI test asserts the
  normal authenticated response renders no **Restricted** chip and no "Requires
  an Admin role" copy. No browser screenshot was captured, because the change is
  not deployed anywhere a real DataLake-User session could be photographed.
- The `restricted` tile state and its three localized strings are now dead in
  practice — no current API response reaches them. They were kept deliberately
  as a defensive contract and are covered by a test that says so. If the
  reviewer prefers them removed, that is a follow-up.
- `node scripts/validate-vault.mjs` reports the same two owner-review Canvas
  warnings recorded in the previous telemetry receipt. They pre-date this task
  and were not introduced or resolved by it.
- Twingate connector telemetry remains without an approved source and was
  neither implemented nor fabricated. The tile and the API both continue to
  report `available: false` / `no-approved-source`. Future scope, non-blocking.
