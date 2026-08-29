---
title: Task Receipt — IDEA1 LFT-V2-E1 truthful transfer rate and 32 GiB deployment ceiling
date: 2026-08-29T20:10:13+07:00
owner: kla
area: idea1
branch: feat/idea1-lft-v2-e1-rate-eta-limits
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-E1 truthful transfer rate and 32 GiB deployment ceiling

## What changed

- The Vault transfer panel now states a real transfer speed and a real
  time-remaining — `58.4 MB/s · เหลือประมาณ 12 วินาที` — derived only from bytes
  that actually moved. Every number is withheld rather than invented when the
  evidence for it does not exist yet.
- A deployment may now configure a logical file ceiling up to **32 GiB**
  (`34,359,738,368` bytes). **No deployment's effective limit changed**: the
  default is still 5 GiB, and the new constant only bounds what the environment
  is allowed to name. Previously the bound was `Number.MAX_SAFE_INTEGER`, which
  was an implicit claim that files of any size work.
- Both `/limits` endpoints now distinguish *what this server accepts today*
  (`maxLogicalFileBytes`) from *what an administrator could configure*
  (`maxSupportedLogicalFileBytes`).
- A pre-existing 1-in-256 flaky test was diagnosed and fixed.

This stage changed no transfer protocol, no cryptography, no schema, no route
behaviour and no RBAC/identity boundary.

### Why the estimator behaves the way it does

| Rule | Reason |
| :--- | :--- |
| 5-second rolling window, not a cumulative average | A cumulative average makes the estimate "remember" a slow patch forever, so a user whose link recovered still sees minutes that will not happen. |
| First sample of a session is a reference point, never a measurement | Resume starts from a non-zero byte count; counting those bytes as freshly transferred yields an impossible GB/s first reading. |
| ≥3 real byte advances **and** ≥750 ms span before any number is shown | Three progress events 20 ms apart are not evidence of a rate. |
| 4 s without byte growth → `stalled`, rate and ETA both `null` | Leaving the last known speed on screen while nothing moves is the most convincing lie this panel can tell. |
| Byte regression re-baselines instead of reporting a negative rate | Progress legitimately moves backwards when an in-flight chunk fails and the count falls back to what the server confirmed. |
| No rate at all during `committing` | The server is hashing its own bytes; nothing is on the wire. A "waiting for the network" warning there is a false alarm that invites cancelling a healthy commit. |

`transferRateLine(t, rate)` was placed in the library rather than in `Vault.jsx`
specifically so Normal Files can render the identical sentence without a second
copy of the formatting logic.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/transferRate.js` — **new.** Dependency-free rate/ETA
  estimator plus the shared `transferRateLine()` formatter. Takes an explicit
  timestamp and never reads a clock itself, so it is deterministically testable.
- `IDEA1-AEGIS_Drive_LC/src/lib/format.js` — added `fmtRate()`; returns `null` for
  "not known yet" rather than `0 B/s`, and uses the same 1024-based units as
  `fmtBytes` so the speed line and the byte line divide into each other.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — EN/TH/ZH copy for the rate line, the
  three ETA units, the measuring state and the stalled state.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — one estimator per transfer, created
  fresh on start *and on resume*; sampling happens outside the state updater
  because React may invoke an updater twice; renders the speed/ETA line under the
  progress bar with reserved height so the panel does not jump.
- `IDEA1-AEGIS_Drive_LC/server/config/transferLimits.js` — added
  `MAX_SUPPORTED_LOGICAL_FILE_BYTES` (32 GiB) and used it as the parser bound for
  `MAX_LOGICAL_FILE_BYTES`; documented the commit-time budget table.
- `IDEA1-AEGIS_Drive_LC/server/config/vaultTransferLimits.js` — added
  `MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES` and used it as the parser bound for
  `MAX_VAULT_LOGICAL_FILE_BYTES`.
- `IDEA1-AEGIS_Drive_LC/server/routes/uploads.js` — `/limits` returns
  `maxSupportedLogicalFileBytes`.
- `IDEA1-AEGIS_Drive_LC/server/routes/vaultUploads.js` — same for the Vault `/limits`.
- `IDEA1-AEGIS_Drive_LC/tests/transferRate.test.js` — **new**, 13 tests.
- `IDEA1-AEGIS_Drive_LC/tests/transferLimitsConfig.test.js` — **new**, 9 tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultV2ScreenUi.test.js` — 3 new tests: the rendered
  rate line under a test-controlled clock, the stalled state, and EN/TH/ZH copy
  including the exact example named in the task.
- `IDEA1-AEGIS_Drive_LC/tests/vaultV2Api.test.js` — asserts the two limit fields are
  distinct and truthful; **fixed a pre-existing flaky test** (see below).

### The flaky test, stated plainly

`tests/vaultV2Api.test.js` simulated on-disk corruption by writing `0xff` over
one byte of a `randomBytes()` buffer. When that byte already *was* `0xff` — once
in 256 runs — the tamper was a no-op, commit correctly succeeded, and the test
failed while production code behaved perfectly. It now flips the byte
(`original ^ 0xff`), which corrupts deterministically. This was observed live:
one full-suite run failed there before the cause was found, which is exactly the
kind of intermittent red that erodes trust in a suite.

## Verification evidence

- `npm test` (in `IDEA1-AEGIS_Drive_LC/`) — **pass**: 611 tests, 544 pass, 0 fail,
  67 skipped. The 67 skips are the pre-existing PostgreSQL-gated tests in
  in-memory mode, unchanged in count from `origin/main`.
- `npm run build` — **pass**: built in 12.79 s. The >500 kB chunk advisory is
  pre-existing and unchanged.
- `node --test tests/transferRate.test.js` — **pass**: 13/13.
- `node --test tests/transferLimitsConfig.test.js` — **pass**: 9/9.
- `node --test tests/vaultV2ScreenUi.test.js tests/transferRate.test.js` — **pass**: 33/33.
- `node --test tests/vaultV2Api.test.js` — **pass**: 24/24 (run four times).
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` (repo
  root) — **pass**: 25/25.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` —
  **pass** with 2 pre-existing canvas warnings, unchanged from `origin/main`.
- Baseline comparison: `origin/main` was run under `git stash` before this work to
  establish 586 tests / 519 pass / 0 fail / 67 skipped. The 25 added tests account
  for the difference.

HUB CSP parity tests were **not** run because this change touches no preview
delivery path, no CSP directive and no edge configuration.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added the
  LFT-V2-E1 section: the estimator's rules and the reason for each, the 32 GiB
  bound and the fact that defaults did not move, the commit-budget arithmetic,
  the flaky-test fix, and the verification totals. `LARGE_FILE_TRANSFER_V2`
  remains `IN_PROGRESS`.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — a
  cross-area concept note outside the `idea1/` boundary. §4.6 now states the
  configurable range and its 32 GiB bound; §7.8 points `LARGE_V2_VIDEO_PREVIEW`
  at the planned LFT-V2-E3 work; a new §11 documents the estimator, the
  commit-time budget table and the full environment-variable list.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — the consolidated cross-area outstanding list; the
  `LARGE_FILE_TRANSFER_V2 = IN_PROGRESS` row now records LFT-V2-E1 as
  source-complete and locally verified, explicitly not deployed and not measured.

Both were updated because this task was explicitly scoped to update them. No
code, deployment, gateway, database, authentication or network surface outside
`IDEA1-AEGIS_Drive_LC/` was touched.

## Integration requests

- **Kla — `gateway/nginx.conf` and the HUB edge, decision required before any
  deployment raises its ceiling.** `committing` reads the whole staged file to
  verify SHA-256, so it is linear in file size: ~90 s at 5 GiB and ~570 s at
  32 GiB on a ~60 MB/s edge-box disk. The current `proxy_read_timeout 600s` on
  the two commit routes is sufficient to roughly 16 GiB and **insufficient at
  32 GiB**. Any deployment that sets `MAX_LOGICAL_FILE_BYTES` or
  `MAX_VAULT_LOGICAL_FILE_BYTES` above ~8 GiB must also raise `proxy_read_timeout`
  on **those two commit routes only** and raise `UPLOAD_COMMIT_LEASE_MS` /
  `VAULT_COMMIT_LEASE_MS` (already environment-controlled, settable to 24 h).
  **Deliberately not changed here**: no deployment has opted into a ceiling above
  5 GiB, so broadening a shared edge timeout now would carry downside with no
  benefit. Rollback for that future change is reverting the two `location`
  blocks; downstream effect is limited to how long the edge waits on those two
  routes.
- **Kla — review of the two shared vault notes listed above** before merge, since
  both sit outside the `idea1/` ownership boundary.

## Known limitations

- **Normal Files is not wired to the shared estimator.** `UploadDrawer` and
  `Uploads` still render their own progress line. `transferRateLine()` was placed
  in `src/lib/transferRate.js` precisely so that integration needs no duplicated
  logic, but it is **not done** and is carried forward as outstanding.
- **No throughput was measured.** The estimator is pinned by deterministic
  fake-clock tests. This task produced no real-world MB/s figure, and none is
  claimed anywhere. The task brief stated that a real ~1.1 GB MP4 has been moved
  through the deployed Vault V2 path; that could not be confirmed from this
  repository, where `idea1-status.md` still records the largest file moved
  through the Vault protocol in any test as ~16 MiB and records nothing as
  deployed. The brief's claim is left unrecorded rather than repeated.
- **No 32 GiB file was transferred.** The 32 GiB support is a configuration bound
  plus arithmetic on the commit path, verified by unit tests for parsing, safe
  integer range and the free-space reserve rule. It is not an acceptance result.
- **The commit-budget table assumes ~60 MB/s sequential read** on the edge box.
  That figure is an estimate for planning the timeout, not a measurement of the
  production disk.
- **Nothing was deployed and no production acceptance was performed.**
  `LARGE_FILE_TRANSFER_V2` stays `IN_PROGRESS` pending `LFT-V2-D`.
- **Scope split.** The task brief bundled four goals. Bounded-concurrency Vault
  upload (`VAULT_UPLOAD_CONCURRENCY`, 32 MiB default chunk) and the Service
  Worker large-encrypted-video preview are **not** in this branch; they are
  planned as LFT-V2-E2 and LFT-V2-E3 so that a crypto-scheduling change and a
  plaintext-delivery change each get their own reviewable diff.
  `VAULT_UPLOAD_CONCURRENCY` is intentionally undocumented until the code that
  reads it exists.
- The branch prefix is `feat/`, not the `perf/` named in the brief:
  `AGENTS.md` §4 and `scripts/validate-collaboration-policy.mjs` accept only
  `feat|fix|docs|infra|deploy|chore|codex`, so `perf/` would fail the policy check.
