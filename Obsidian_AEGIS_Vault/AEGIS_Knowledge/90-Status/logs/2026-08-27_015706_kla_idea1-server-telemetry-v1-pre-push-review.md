---
title: Task Receipt — IDEA1 Server Telemetry V1 independent pre-push review
date: 2026-08-27T01:57:06+07:00
owner: kla
area: idea1
branch: feat/idea1-server-telemetry-v1
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Server Telemetry V1 independent pre-push review

`SERVER_TELEMETRY_V1_REVIEW = REVIEWED / FINDINGS FIXED / NOT PUSHED`

`PUSH_PERFORMED = NO`
`PR_CREATED = NO`
`PRODUCTION_CHANGED = NO`
`DEPLOYMENT_PERFORMED = NO`

Independent review of the committed implementation, read from the diff and the
source rather than from the implementation session's own conclusions. Nothing in
this task touched a running host, container, gateway, firewall, or database.

## Scope reviewed

`REVIEW_BASE = 2e0a39023f32276edbff28dcf9e2ef5d22561ad0` (identical to
`origin/main` at review time)
`REVIEW_HEAD = 17fd54df9a97fbae270340826555a5a925642851`

36 files, +4186 / −65, one commit. Every path falls inside the expected
categories: the host agent package, the Drive telemetry backend, the
authenticated `/api/telemetry` route, the Dashboard integration, focused tests,
systemd packaging templates, one implementation receipt, and the IDEA1 status
note.

**No scope creep found.** The diff contains no nginx, Compose, Monitor,
database schema or migration, firewall, Twingate, MikroTik, Docker-socket,
privileged-container, or Formal Report change. Confirmed by path scan, not by
reading the summary.

## What changed

Review only, plus the fixes the review required. No new feature work.

Two IMPORTANT findings were found and fixed, one owner-approved UI correction was
made alongside them, and ten MINOR findings were recorded without change. The
feature under review is otherwise unaltered: the host agent's collection logic,
the schema, the client, the disk projection, and the Drive contract are exactly
as the implementation task committed them.

## Source files changed

| File | Change |
|---|---|
| `IDEA1-AEGIS_Drive_LC/server/routes/api.js` | pass `includeHostMetrics` from `req.user.role` |
| `IDEA1-AEGIS_Drive_LC/server/telemetry/index.js` | `includeHostMetrics` option, `withheld()` shape, role-aware `ok` |
| `IDEA1-AEGIS_Drive_LC/src/components/ServerTelemetry.jsx` | `loading` and `restricted` tile states |
| `IDEA1-AEGIS_Drive_LC/src/App.jsx` | thread `telemetryLoading` to the Dashboard |
| `IDEA1-AEGIS_Drive_LC/src/screens/Dashboard.jsx` | thread `loading` to `ServerTelemetry` |
| `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` | two new keys in EN, TH and ZH |
| `IDEA1-AEGIS_Drive_LC/tests/telemetryApi.test.js` | four `TELEM-API-11` role tests, replacing the test that asserted the old behaviour |
| `IDEA1-AEGIS_Drive_LC/tests/serverTelemetryUi.test.js` | `TELEM-UI-11` (three) and `TELEM-UI-12` |
| `shared/host-telemetry-agent/deploy/aegis-telemetry.service` | move `StartLimit*` from `[Service]` to `[Unit]` |
| `shared/host-telemetry-agent/tests/deploy.test.js` | section-aware parser, two new section tests |

Both IMPORTANT fixes were written test-first: each new test was run and observed
failing against the unfixed tree before the fix was applied.

## Findings

`CRITICAL_FINDINGS = 0`
`IMPORTANT_FINDINGS = 2 (both fixed)`
`MINOR_FINDINGS = 10 (recorded, not fixed)`

### IMPORTANT-1 — host counters were readable by every authenticated role

`GET /api/telemetry` was gated by `requireAuth` alone. The Dashboard is a
`DataLake-User` screen, so the lowest-privileged account received exact host RAM
size, live CPU percentage, the NIC name, live rx/tx throughput, and host uptime.
Host uptime in particular discloses the patch window. In a feature whose entire
framing is least-privilege, that is a design gap rather than a code defect, so it
was **raised for an owner decision rather than changed unilaterally**.

Owner ruling: split, host counters Admin-only.

Implemented as `buildTelemetry({ includeHostMetrics })`, decided from
`req.user.role` — session state, never client input. A `DataLake-User` keeps
exactly what Drive already showed them elsewhere: Data Lake capacity (also on
`/api/storage`) and Drive's own process uptime. The decision is taken **before**
the agent is contacted, so an unprivileged poll never opens the socket and the
host data never enters the process at all.

Withheld is reported as `{ available: false, reason: 'requires-admin' }` — a
distinct fact from unmeasurable, so the tile can say "not available to your role"
instead of the untrue "no telemetry source connected". `ok` counts only what the
caller is entitled to, so a `DataLake-User` does not see a permanently degraded
dashboard describing a healthy system.

### IMPORTANT-2 — the systemd start rate limit was written where systemd ignores it

`StartLimitIntervalSec=60` and `StartLimitBurst=5` sat in `[Service]`. Both are
`[Unit]` keys; systemd moved them in v230 and only the legacy spellings survive
under `[Service]` as ignored compat entries. The unit's own comment states the
intent — "a failed start is a configuration error worth surfacing rather than
retrying forever" — and that intent did not hold. The manager default of 10 s
would apply instead, and with `RestartSec=5s` five restarts span more than 10 s,
so the burst can never trip: a misconfigured interface would restart-loop
indefinitely instead of entering `failed`.

`tests/deploy.test.js` could not catch this. Its parser flattened the whole unit
into one map with no section tracking, so a directive in the wrong section was
indistinguishable from a correct one. The parser is now section-aware, and every
load-bearing directive is asserted against the section systemd reads it from.

### MINOR — recorded, not fixed

1. The agent's HTTP server keeps no persistent `'error'` listener after a
   successful `listen()`; an accept-time error (EMFILE) would become an uncaught
   exception rather than a logged failure.
2. `prepareSocketPath` uses `stat`, not `lstat`, for its "is this really a
   socket" check. Not exploitable — the RuntimeDirectory is `0750` and owned by
   the agent — but `lstat` is the correct call.
3. The liveness probe treats every connect error as "dead", so `EAGAIN` from a
   full accept backlog would read as an unused socket. Unreachable under
   single-instance systemd.
4. `createAgent()` sits outside the `try` in `src/index.js`, so a bad interface
   or interval produces a raw stack trace in the journal rather than the terse
   line the surrounding comment promises.
5. `void sampleOnce()` is unguarded in both call sites. Every known throw site is
   already covered, but a future one would become an unhandled rejection.
6. `sampler.stop()` clears the timer without cancelling an in-flight cycle, which
   may still publish afterwards.
7. The `uptime` group is always `available: true` (Drive's own uptime always is)
   and carries no `stale` key, so its chip reads Normal even when the host half
   is unknown or 40 s old. The row text is truthful; the chip is not.
8. Two different unavailable shapes exist for disk — `disk.js` includes `scope`
   and `health`, the `buildTelemetry` catch path does not.
9. The socket is `0770`, not `0660`, during the window between `listen()` and
   `chmod`. Not a widening — `UMask=0007` and the `0750` directory mean nothing
   outside the group can reach it either way — but the unit comment and a test
   comment both state `0660`, and the safety rests on the unit's `UMask` rather
   than on the code.
10. The schema validates `usedBytes <= totalBytes` and `0 <= percent <= 100`
    independently, so a compromised agent could send internally inconsistent but
    individually valid values.

None of these materially affect security or correctness, and none were fixed —
scope was held to the two IMPORTANT findings and the owner-approved UI item.

## Additional fix — first-paint honesty (owner-approved)

Before the first response landed, all six tiles rendered "Unavailable / No
telemetry source connected" — a claim about a source nothing had queried yet.
`STATE_META.loading` and `telemetryStateLoading` already existed in all three
languages but were unreachable: `metricState` never returned `'loading'` and
`App` passed only `telemetryApi.data`.

The component now distinguishes three separate facts: `loading` (not asked yet),
`restricted` (measured, not shown to this role), and `unavailable` (asked, and
the source could not answer). A refresh over data already on screen leaves that
data visible — blanking a real reading to announce a newer one loses information.

## Verification evidence

- `node --test --test-concurrency=1 "tests/**/*.test.js"` (shared/host-telemetry-agent) — **pass: 56 discovered, 53 pass, 0 fail, 3 skipped**.
- `node --test --test-concurrency=1 "tests/**/*.test.js"` (IDEA1-AEGIS_Drive_LC)
  — **pass: 300 discovered, 281 pass, 0 fail, 19 skipped**. The 19 skips are the
  pre-existing `TEST_DATABASE_URL` Postgres-gated tests, unchanged by this branch.
- `node --test --test-concurrency=1 tests/telemetryApi.test.js tests/telemetryClient.test.js tests/telemetrySchema.test.js tests/dataLakeCapacity.test.js tests/serverTelemetryUi.test.js`
  — **pass: 62 discovered, 62 pass, 0 fail, 0 skipped** before the fixes; the
  same focused set passes after, at 21 and 17 for the two files that grew.
- `node --test --test-concurrency=1 "tests/**/*.test.mjs"` (repository root)
  — **pass: 53 discovered, 53 pass, 0 fail, 0 skipped**.
- `npm run build` (IDEA1-AEGIS_Drive_LC) — **pass**, built in 6.47s. Output
  reverted; `dist/` is not part of this commit.
- `node --check` on each of the 25 changed `.js` files — **pass**, all 25 OK.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — **pass**, 2 warnings, both pre-existing canvas notes unrelated to this branch.
- `git diff --check` — **pass**, clean.
- Conflict-marker scan over the diff — **pass**, none found.
- Secret scan over all added lines — **pass**. Every match is a test fixture, a
  path-traversal test string, or prose describing what must not leak.
- `filesystemCapacity()` executed on its real production default path — **pass**,
  `used + free === total` exactly on a live filesystem.

Every command above was run in this session against the fixed tree. No output was
reused from the implementation session.

The host agent suite was run three consecutive times before the fix, with
identical counts each time. No flakiness observed.

One test written during this task was itself found flaky before commit and
rewritten: it scanned the response body for short numerics (`512`, `1024`), which
occur inside the real `statfs` byte counts the response legitimately carries. It
now asserts structurally that a withheld metric has exactly the keys `available`
and `reason`, and substring-scans only for values distinctive enough that a match
cannot be coincidence. That is the same flake shape already recorded for
`TELEM-SOCKET-5` in the implementation receipt.

## Disk semantics

`DISK_SEMANTICS_PRESERVED = YES`

Verified against the source, and additionally by executing the production default
path: `total = blocks × bsize`, `free = bavail × bsize`, `used = total − free`.
`bfree` is **not** substituted anywhere, root-reserved blocks therefore remain
counted as used, and `used + free == total` held exactly on a live filesystem.

All three production call sites — `db/store.js:701`, `db/store.js:876`, and
`telemetry/disk.js` — invoke `filesystemCapacity()` with no arguments, so the new
`{ statfs, root }` parameters are test-only as documented and production
behaviour is byte-for-byte unchanged. The function is never passed as a callback,
which would have injected an array index as its options object.

## Skipped POSIX tests — decision

`POSIX_SKIPPED_TESTS_DECISION = A — production-critical, must run on Linux before merge`

The three skipped tests are stale-socket reclamation, socket removal on stop, and
the `0660` mode assertion. They are not incidental: the mode assertion is the only
automated proof that host metrics are not world-readable, and the reclamation
test is the only proof the agent recovers from a `SIGKILL`. Deferring them to
production preparation would mean the socket's permission boundary was never
tested anywhere. They must run on Linux before merge, not before deployment.

## CI

`CI_HOST_AGENT_DISCOVERY = NOT WIRED` — independently confirmed. The repository
has exactly one workflow, `.github/workflows/collaboration-guardrails.yml`, which
runs the collaboration-policy and vault validators only. There is no root
`package.json`, so nothing discovers either `IDEA1-AEGIS_Drive_LC/tests` or
`shared/host-telemetry-agent/tests`.

`CI_RECOMMENDATION = OPTION_CI_1` — add a focused Linux job in this branch before
opening the PR.

Rationale: `OPTION_CI_3` is disproven above. `OPTION_CI_2` leaves the decision to
merge-time discipline while the three tests that prove the socket's permission
boundary have still never executed on any Linux machine — the same gap, moved
later. A Linux `ubuntu-latest` job running both suites costs one workflow file,
un-skips all three tests automatically, and is the only option that produces
evidence rather than a promise.

## Canonical notes updated

None. This review changed no canonical note. `idea1/idea1-status.md` was updated
by the implementation task under review and its claims were re-checked here
against fresh output rather than rewritten — every figure it states
(`274/274` IDEA1 pass with 19 Postgres skips, `51 pass / 3 skipped` host agent,
`53/53` root, build pass) reproduced exactly before the fixes in this task
raised the counts to 281 and 53. Nothing in that note overclaims, so nothing in
it needed correcting.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — the `/api/telemetry` route only.
  No other route, middleware, or middleware order was changed. `requireAuth`
  still runs before the handler and CSRF still exempts GET.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/index.js` — added the
  `includeHostMetrics` option. Default `true`, so every existing caller and test
  is unaffected.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — two new keys
  (`telemetryStateRestricted`, `telemetryRestricted`) added in EN, TH and ZH.
  No existing string was changed. `TELEM-UI-10` verifies all three languages
  resolve.
- `IDEA1-AEGIS_Drive_LC/src/App.jsx`, `src/screens/Dashboard.jsx` — one added
  prop threaded through to `ServerTelemetry`. No other screen touched.
- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — two directives
  moved between sections. Nothing added, nothing removed, no hardening directive
  altered.

`IDEA1-AEGIS_Drive_LC/dist/` was deliberately **not** committed. The production
build was run as verification and its output reverted, matching the convention of
the implementation commit, which also left `dist/` untouched.

No file owned by another module was modified. No shared schema, no shared
migration, no shared configuration.

## Integration requests

1. **CI — the one blocking request.** Add a Linux job running both
   `IDEA1-AEGIS_Drive_LC` and `shared/host-telemetry-agent` test suites before
   this branch opens a PR (`OPTION_CI_1` above). Three tests that prove the
   socket's permission boundary have never executed on any Linux machine, and
   nothing in the current workflow will ever discover them.
2. **Deployment packaging remains proposed, not applied.** The Drive delta in
   `shared/host-telemetry-agent/deploy/production-delta.md` — `group_add:
   ["29100"]` plus the read-only bind `/run/aegis-telemetry:/run/aegis-telemetry:ro`
   — still awaits integration review. This task did not touch it.
3. **`systemd-analyze verify` should be run against the corrected unit.** It
   would have caught IMPORTANT-2 and is the cheapest confirmation that the
   section move is correct on the real systemd version the host runs.

## Known limitations

- **The two IMPORTANT fixes are verified by test, not by runtime.** The role
  split is proven end-to-end through the real Express app (`TELEM-API-11`, four
  tests). The systemd section fix is proven only by a static section-aware
  parser — no systemd was executed, and `systemd-analyze verify` remains unrun.
- **`SYSTEMD_RUNTIME_VERIFIED = NO`** and
  **`AF_UNIX_NODE_COMPATIBILITY_VERIFIED_ON_PRODUCTION = NO`** stand unchanged
  from the implementation receipt. This review did not and could not close them.
- **The three POSIX-skipped tests are still skipped.** This review ran on
  Windows. The decision recorded above is that they are production-critical and
  must run on Linux before merge; that run has not happened.
- **The ten MINOR findings are recorded and unfixed** by deliberate choice.
  Several are one-line changes, but none affects security or correctness, and
  expanding a review commit to sweep them up would have made the two fixes that
  matter harder to review.
- **The role split changes what a `DataLake-User` sees on the Dashboard.** It is
  an owner-approved behaviour change made during review, not a defect fix. A
  `DataLake-User` now sees four Restricted tiles where they previously saw host
  numbers. No user-facing acceptance of that screen has been performed.
- **`ok: true` for a `DataLake-User` is a deliberate contract choice.** It means
  "everything this caller is entitled to was measured", not "the host is
  healthy". Any future consumer of `ok` must read it that way.
- **No push, no Pull Request, no container build, no deployment, no production
  acceptance.** `READY_FOR_PRODUCTION_DEPLOYMENT = NO`.

## Gates

`READY_FOR_PUSH = YES` (owner decision pending on the CI job)
`READY_FOR_PR = NO` — blocked on `OPTION_CI_1`
`READY_FOR_MERGE = NO`
`READY_FOR_PRODUCTION_DEPLOYMENT = NO`

`NEXT_REQUIRED_GATE` — add the Linux CI job, confirm the three POSIX tests pass
there, then open the PR. `systemd-analyze verify` / `security` and the five-read
host smoke test remain required and unrun, and `SYSTEMD_RUNTIME_VERIFIED = NO`
and `AF_UNIX_NODE_COMPATIBILITY_VERIFIED_ON_PRODUCTION = NO` both stand
unchanged.

## Related

- [[90-Status/logs/2026-08-27_004957_kla_idea1-server-telemetry-v1-implementation]]
- [[idea1/idea1-status]]
- [[concepts/Honest_Telemetry_and_Unavailable_States]]
