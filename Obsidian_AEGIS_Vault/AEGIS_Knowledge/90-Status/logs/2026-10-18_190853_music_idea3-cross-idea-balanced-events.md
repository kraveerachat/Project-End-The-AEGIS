---
title: Task Receipt — IDEA3 Cross-IDEA Balanced Recent Events
date: 2026-10-18T19:08:53+07:00
owner: music
area: idea3
branch: fix/idea3-cross-idea-fair-recent-events-20261018
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Cross-IDEA Balanced Recent Events

## What changed

- Fixed newest-first, balanced selection of IDEA1 and IDEA2 events in IDEA3 Web source.
- Reallocated unused snapshot capacity between the two producers.
- Before the fix, Production read-only evidence showed each upstream returning 200 events, while the oldest-first first 100 included IDEA1 only.
- Local validation passed; the fix has not been merged or deployed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js` — balanced recent selection.
- `IDEA3-AEGIS_Lockdown/web/tests/server/liveIntegrationProvider.test.js` — regression tests.

## Verification evidence

- `npm test -- tests/server/liveIntegrationProvider.test.js` — PASS, 28/28.
- `npm test` — PASS after restoring original tracked test fixtures into the development worktree.
- `npm run acceptance` — PASS.
- `npm run build` — PASS.
- `git diff --check` — PASS.
- STEP 41.47 read-only Production distribution test — PASS.

## Canonical notes updated

- None — source and test fix only; deployment status will require owner reconciliation after a separately approved release.

## Shared surfaces touched

- None — all changed paths are IDEA3-owned source, tests and this receipt.

## Integration requests

- IDEA3 owner and Kla: review selection semantics, incident correlation and containment eligibility.
- IDEA2 owner Pub: verify historical detection rendering following the future IDEA3-only deployment.
- Any Production release requires a separate approval, rollback and UI verification.

## Known limitations

- PR #445 has not been merged or deployed.
- Snapshot selection also feeds correlation and eligible-event counts; reviewer acceptance is required.
- Historical STALE evidence must remain STALE and containment-ineligible.
- Core LIVE is separately blocked by the machine-client CRL issue.
- Physical CUT, relay execution and RESTORE are not verified by this change.
