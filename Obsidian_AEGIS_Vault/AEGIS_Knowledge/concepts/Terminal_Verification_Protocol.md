---
title: Terminal Verification Protocol
tags: [aegis, concept, testing, verification, rbac, curl]
type: concept
created: 2026-08-06
updated: 2026-08-07
sources: ["docs/auth-test.md"]
---

# 🧪 Terminal Verification Protocol

> **Why this note exists**: `docs/auth-test.md` (828 lines, 15+ numbered sections) is the project's *proof* that its security claims hold — but it sits outside the vault, and [[index]] could only reference it as a bare file path. This note gives it a real graph node so every security claim can link to the test that proves it.
>
> ⚠️ The file itself lives at **`docs/auth-test.md` in the repository root**, not in the vault. It is intentionally not copied here — it is executable documentation that must stay next to the code it tests.

---

## The governing principle

> Everything proven in that file is enforced **server-side**. Hiding a menu in the UI is not a security control — what counts is what the endpoint returns when hit directly with `curl`, bypassing the screen entirely.

This is principle #1 of [[06 - 🤖 Agent Operating Rules]], expressed as a test methodology. Every command in the file is copy-pasteable against a localhost stack (`docker compose up -d --build`).

Base URLs go through the gateway:
- IDEA1 AEGIS Drive → `http://localhost/drive/api/...`
- IDEA2 AEGIS Monitor → `http://localhost/monitor/api/...`

## What the sections cover

| Area | Proves | Linked concept |
|---|---|---|
| Auth & session | Uniform auth errors, session cookie behaviour, `401` on unauthenticated | [[concepts/OWASP_Security_Defense]] |
| RBAC | Role-gated endpoints return `403`, not a filtered success | [[05 - 🛡️ Security Architecture]] |
| Scoped view via `camera_assignment` | An operator requesting another operator's camera gets `403` | [[concepts/Schema_Ownership_Map]] |
| Storage Layer round-trip | Upload → download is byte-for-byte identical (sha256 + `cmp`) | [[concepts/Three_Layer_Data_Lake]] |
| SQL-level Identity Decoupling (§11) | Cross-database connect fails with `permission denied` | [[concepts/Identity_Decoupling]] |
| Rate limiting (§8) | Attempt 6 → `429` with `Retry-After` | [[concepts/OWASP_Security_Defense]] |
| HUB has no auth (§12) | No credentials in the bundle; `/api/login` → `405` | [[01 - 🚪 HUB-AEGIS Entry]] |
| In-web Add Operator (§13) | `201` + one-time temp password; duplicate → `409` + rollback | [[03 - 📹 IDEA2 AEGIS Monitor]] |
| Detection Engine `/internal` (§14) | No key / wrong key → `401`; gateway → `404` | [[entities/Detection_Engine_Service]] |
| Private Vault against real Postgres (§15) | Plaintext absent from `pg_dump`, statement logs, and app logs | [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] |

## Isolated PostgreSQL test-database rule

`TEST_DATABASE_URL` is not a harmless switch. Enabling it moves the entire IDEA1 Node suite onto the production PostgreSQL code path, where test helpers intentionally delete all rows from Vault/share tables, reset profile/avatar fields, delete and recreate a seed account to prove FK cascades, and may replace seed-account passwords after the force-reset gate. There is no suite-wide transaction rollback. **Never point it at the database used by a running Drive instance.**

The verified release procedure is:

1. Create a temporary database in the existing Postgres container and load the same Drive schema/seed.
2. Compare `current_database()`, database OID, and critical row counts against live before running.
3. Mount source read-only into an ephemeral runner; inject `TEST_DATABASE_URL` only on the test process, not into `.env` or the Drive container.
4. Run the complete suite serially (`--test-concurrency=1`).
5. Recheck live counts and health, remove the runner/volume, close only test-database sessions, drop the database, then verify it is absent from `pg_database`.

The 2026-08-07 execution followed this procedure: `aegis_drive` OID 16385 and `aegis_drive_test` OID 16672; both began with `users=2`, `vault_blobs=0`, `vault_meta=0`, `shares=0`; **119/119 passed with no skips**; live counts and health were unchanged; the test database and runner were removed. The first runner used Node 20 and stopped at test discovery because that runtime did not expand the quoted `tests/**/*.test.js` argument. Node 24 matched the working local runtime and completed the suite; no source or test file was changed to work around the tooling difference.

## Why this matters beyond testing

`PRODUCT.md` names **graders / code reviewers** as a first-class audience (see [[07 - 🎨 Design System & UI Language]]). For that audience this file *is* the deliverable — it is how a reviewer confirms least-privilege behaviour without reading every line of source.

## Verification discipline established across sessions

Patterns that recur throughout [[log]] and are worth preserving as house rules:

- **Verify against the built bundle, not the source** — several regressions (dead i18n strings, fabricated overlay text, a missing route) were invisible in source and only caught by grepping `dist/`.
- **Control checks alongside negative checks** — a grep returning 0 hits proves nothing unless a deliberate positive control also returns hits.
- **Measure both directions of a fix** — record the broken behaviour *and* the fixed behaviour (e.g. `403` before / `200` after), not just the working end state.
- **Name what was not verified.** Sessions that could not run a browser, or relied on a disposable container instead of the real NAS, say so explicitly rather than implying full coverage.

---

## Related
[[05 - 🛡️ Security Architecture]] · [[concepts/OWASP_Security_Defense]] · [[concepts/Identity_Decoupling]] · [[concepts/Schema_Ownership_Map]] · [[entities/Detection_Engine_Service]] · [[summaries/02_Security_Auth_and_Identity]] · [[06 - 🤖 Agent Operating Rules]] · [[START_HERE]]
