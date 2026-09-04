---
title: Task Receipt — IDEA1 Settings functional redesign (Security, Storage, Administrator)
date: 2026-09-04T19:25:03+07:00
owner: kla
area: idea1
branch: feat/idea1-settings-functional-redesign
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Settings functional redesign

Status is `partial`, not `complete`: every deliverable below is implemented and
verified locally, but one item in the brief (a "Lock Vault now" action in
Settings) was **not built** because the current architecture cannot back it
truthfully, and the PostgreSQL path of the new migration has not been executed
anywhere. Both are recorded under Known limitations.

## What changed

Settings' three functional tabs stopped being status boards and became a real
settings surface, without inventing a single capability the system does not have.

- **Two genuinely new configurable settings**, stored per account and bounded by
  both a server validator and a database CHECK constraint:
  - Vault auto-lock duration (5/10/15/30/60 min) — replaces the hard-coded
    `IDLE_LOCK_MS = 10 * 60_000` constant in `Vault.jsx`.
  - Secure Share defaults (expiry, network scope, require-password) — the Create
    share form now initialises from them.
- **One new real action**: "Sign out other sessions", which revokes every other
  live session for the account, preserves the caller's, is confirmed before it
  runs, reports the number actually revoked, and writes an audit event.
- **One new real read**: a self-scoped security activity summary from the
  existing audit ledger (`GET /api/audit/me`).
- **Dead and misleading controls removed**: the permanently-disabled
  "Generate 12-word recovery phrase" button, the "Inactive" Twingate connector
  chip (a measurement Drive never took), and the "snapshot scheduling is not
  implemented" placeholder that was the main content of the Storage & Data tab.
- Every panel now declares itself **Configurable / Action / System managed**, so
  a value the architecture fixes never reads as a control someone forgot to wire.

## Source files changed

Server

- `IDEA1-AEGIS_Drive_LC/server/db/migrations/007_security_settings.sql` — new;
  additive, idempotent, CHECK-constrained columns for the two new settings.
  Defaults reproduce today's behaviour exactly (10 min / 24h / zones / password).
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — same columns for new databases.
- `IDEA1-AEGIS_Drive_LC/server/db/connection.js` — `DEFAULT_SECURITY_SETTINGS`,
  fail-closed `normalizeSecuritySettings`, `updateSecuritySettings`,
  `readSecuritySettings`, and `readActorSecurityActivity` (returns a derived
  summary, never raw audit rows).
- `IDEA1-AEGIS_Drive_LC/server/auth/session.js` — `revokeOtherSessions(req)`;
  skips the current session and any session belonging to another account.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — `GET`/`PATCH
  /api/security/settings`, `GET /api/audit/me`, `POST /api/sessions/revoke-others`.
  New audit actions: `SECURITY_SETTINGS_UPDATE`, `SESSION_REVOKE_OTHERS`.

Client

- `IDEA1-AEGIS_Drive_LC/src/components/SettingsPanels.jsx` — new; the redesigned
  panels and the Configurable/Action/System-managed vocabulary.
- `IDEA1-AEGIS_Drive_LC/src/screens/Settings.jsx` — Security & Privacy, Storage &
  Data and Administrator rebuilt from those panels; zone deletion now confirmed;
  "Sign out other sessions" added to the sessions card.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — idle budget read from the
  account setting; the old constant survives only as the documented fallback.
- `IDEA1-AEGIS_Drive_LC/src/screens/Shares.jsx` — Create share initialises from
  the saved defaults, one-way (editing a share never rewrites the defaults).
- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — passes `go` to Settings for navigation.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — 101 new keys in EN/TH/ZH.

Tests

- `IDEA1-AEGIS_Drive_LC/tests/settingsSecurityContract.test.js` — new; server
  contract (22 tests).
- `IDEA1-AEGIS_Drive_LC/tests/settingsFunctionalRedesign.test.js` — new; rendered
  Settings behaviour (23 tests).
- `IDEA1-AEGIS_Drive_LC/tests/allScreensEmptyState.test.js` — **updated**, see
  below.

### One existing test was rewritten, deliberately

`allScreensEmptyState.test.js` asserted the presence of `remoteInactive`,
`vaultRecoveryNotConnected`, `generateRecoveryPhrase` and a `disabled`
attribute — that is, it pinned the exact dead controls this task was asked to
remove. Its intent (no invented remote channel, no control implying vault
recovery exists) is unchanged and now asserted more strictly: the recovery
generator must be **absent entirely** rather than present-and-disabled, and the
connector row must say telemetry is unmeasured rather than show "Inactive".

## Verification evidence

- `npm test` — pass: **950 tests, 883 pass, 0 fail, 67 skipped**. The 67 skips
  are the pre-existing PostgreSQL-gated suites, which skip without a live
  database; that count is unchanged by this branch.
- `node --test tests/settingsSecurityContract.test.js` — pass: 22/22.
- `node --test tests/settingsFunctionalRedesign.test.js` — pass: 23/23.
- `npm run build` — pass: built in 6.58s, no errors.
- `git diff --check` — pass: no whitespace errors.
- Browser QA (vite :5174 + Drive API :8001, in-memory auth store, admin account):
  - Security & Privacy, Storage & Data, Administrator rendered in **Classic and
    Neo**, **light and dark**, EN and TH.
  - Auto-lock set to 30 in the UI; `GET /api/security/settings` returned
    `vaultAutoLockMinutes: 30`.
  - Share defaults set to 7d / any; Create share then initialised to
    `7 days` / `Password` / `Any AEGIS-reachable network`.
  - Changing the Create share form to `1h` left the stored defaults at `7d`
    (one-way, as required).
  - Network zones: invalid CIDR rejected with the correct alert and no row
    created; valid zone added; delete confirmation names the zone and states
    that existing shares keep their snapshot; zone removed.
  - Storage overview rendered the host's real measured capacity, with
    `Disk Health: Not measured` and `RAID: Not configured`.
  - No horizontal overflow at 420 px in either language
    (`documentElement.scrollWidth === clientWidth`).
- `dist/` was rebuilt only to verify the build and then restored with
  `git checkout -- dist/`; it is not part of this change.

## Canonical notes updated

- `None` — this branch is not merged and has not been deployed. The durable
  IDEA1 facts it would change (two new configurable settings, a new migration,
  three new endpoints) become true for `main` only on merge, and true for
  production only after the migration is applied there. Updating
  `idea1/idea1-status.md` now would record a state that does not exist yet.
  The reconciliation entry is listed under Integration requests.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`.

Note for the reviewer: `server/db/migrations/007_security_settings.sql` and
`server/db/schema.sql` sit inside the IDEA1 boundary and touch only the
IDEA1-owned `aegis_drive.users` table. The migration creates no role, no grant,
and no cross-module contract, so it is not classified as a shared surface — but
it **does** carry a deployment ordering requirement, recorded below.

## Integration requests

- **Owner reconciliation after merge (kla):** add to `idea1/idea1-status.md`
  that Drive now stores two per-account security settings (vault auto-lock,
  secure-share defaults) behind `/api/security/settings`, and that Settings
  exposes a self-scoped security activity summary via `/api/audit/me`. Deferred
  until merge for the reason given under Canonical notes updated.
- **Deployment ordering (kla):** migration `007_security_settings.sql` must be
  applied and verified **before** the new Drive image is activated. The
  application reads four columns that do not exist until it runs. Rollback is
  safe in the other direction: the columns are additive and the previous image
  never selects them, so the image can be rolled back without dropping them.

## Known limitations

- **"Lock Vault now" from Settings was not built — architecture blocker, not an
  oversight.** The brief asked for it and instructed a stop-and-report if it
  could not be done safely. `App.jsx` builds exactly one screen at a time
  (`const screenEl = {...}[screen]`), and the vault KEK lives in `Vault.jsx`
  component state, so navigating to Settings already unmounts Vault and discards
  the key. A lock button there would report a success it did not cause, and a
  "Locked / Unlocked" readout would be a constant dressed as a measurement.
  Settings now states this invariant in words instead. Making it real would
  require lifting vault key custody above the screen — an invasive change to the
  zero-knowledge boundary, and its own task.
- **The PostgreSQL path of migration 007 has not been executed.** No database
  was available in this environment, so the 67 PostgreSQL-gated tests skipped and
  the new `UPDATE ... RETURNING` statements were exercised only against the
  in-memory fallback store. The SQL text is asserted by test, but "the migration
  applies cleanly to the real `aegis_drive`" is **not** evidenced by this branch.
- **Security activity is a new authenticated read surface.** `/api/audit/me` did
  not exist before; it returns a derived summary (timestamps and two counts) for
  the caller's own `actor_id` only, with no source IPs, target hashes, or other
  actors. It is covered by tests, but it is new attack surface on a
  security-graded codebase and deserves explicit reviewer attention.
- **Share "download permission" was dropped from the brief.** The share contract
  (`store.createShare`) has no such field — only expiry, authType and scope — so
  the setting would have been a control that silently did nothing.
- **Pre-existing, not fixed here:** a malformed JSON body (for example a literal
  `null`) is rejected by body-parser as `entity.parse.failed` with
  `err.status = 400`, but `errorHandler` ignores `err.status` and returns 500.
  This affects every mutating route in the app, not just the new ones. Fixing it
  changes error semantics app-wide and does not belong in a Settings change.
- **No production deployment or production acceptance was performed.**
