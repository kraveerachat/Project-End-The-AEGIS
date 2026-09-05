---
title: Task Receipt — SECURITY-2 Vault auto-lock duration truthfulness + 1-minute option
date: 2026-09-05T15:50:32+07:00
owner: kla
area: idea1
branch: fix/idea1-security2-vault-autolock-duration
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — SECURITY-2 Vault auto-lock duration

Status is `partial`, not `complete`: the fix is implemented and verified locally,
but SECURITY-2 is explicitly **not closed** until the production acceptance walk
(set 1 minute → save → refresh → unlock → idle ~60 s → observe the lock and the
message) passes on the real host. Neither that walk nor the PostgreSQL run of the
new migration has happened. Recorded under Known limitations.

## What changed

Two defects, one root cause: the auto-lock duration was configurable in the
timer but hard-coded in the copy, and the shortest option a user could pick was
five minutes.

**1. The post-lock message lied for every account not set to 10.**
`vaultAutoLocked` was the fixed string *"Vault re-locked after 10 minutes of
inactivity."* The timer itself was already correct — it read
`settings.vaultAutoLockMinutes` — so an account set to 5 was locked after 5
minutes and then told it had been 10. The message is now a template, and the
number in it is the duration that **actually armed the timer that fired**.

That last part is the subtle half. The duration is captured when the timer is
armed and passed into `lock(auto, afterMinutes)`, rather than re-read from
settings at lock time. If it were re-read, an account value that changed between
arming and firing (another tab, a slow refetch) would make the message describe a
policy that never applied. `AUTOLOCK-10c` pins exactly that: arm at 5, change the
account to 30, fire — the message must still say 5.

**2. A 1-minute option now exists**, end to end and in the four places that must
agree or a value the user can pick is rejected on save: the Settings control, the
server validator, the fresh schema, and the CHECK on databases that already exist.

`1` is an option, never the new default. The column still `DEFAULT 10`, and
`DEFAULT_SECURITY_SETTINGS` still says 10, so a new account is unchanged.

Wording is singular at 1 in all three locales — "1 minute", never "1 minutes".
Thai and Chinese do not inflect for number, so their singular entries read the
same as the plural with the number substituted; the separate key exists so the
choice is made once for every locale rather than only for English.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/db/migrations/008_vault_autolock_1_minute.sql` —
  **new.** Replaces the CHECK on an existing database. 007 is deployed and was
  not edited.
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — fresh installs accept
  `(1, 5, 10, 15, 30, 60)`; `DEFAULT 10` unchanged. Comment corrected — it used
  to say the default "reproduces the constant it replaced", which is no longer
  the whole story.
- `IDEA1-AEGIS_Drive_LC/server/db/connection.js` — `VAULT_AUTOLOCK_MINUTES` gains
  `1`. Everything else about the fail-closed validator is untouched.
- `IDEA1-AEGIS_Drive_LC/src/components/SettingsPanels.jsx` — `AUTO_LOCK_CHOICES`
  gains `1`; options now carry their unit ("1 minute" / "5 minutes") instead of a
  bare number.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — `idleLockMinutes` is resolved
  alongside `idleLockMs`; the timer captures `armedMinutes`; `lock()` takes the
  duration that fired; `autoLocked` holds that number instead of a boolean; the
  now-unused `IDLE_LOCK_MS` constant is removed. Two Thai comments that still
  said "10 นาที" were corrected.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `vaultAutoLocked` becomes a
  template; `vaultAutoLockedOne` and `vaultAutoLockUnitOne` added in EN/TH/ZH;
  `autoLockUnitKey()` / `autoLockedMessageKey()` exported so the Settings control
  and the Vault message can never disagree about how a number is worded.
- `IDEA1-AEGIS_Drive_LC/tests/vaultAutoLockDuration.test.js` — **new**, 9 tests
  (AUTOLOCK-1..7, 11, 12).
- `IDEA1-AEGIS_Drive_LC/tests/vaultAutoLockTimer.test.js` — **new**, 9 tests
  (AUTOLOCK-8, 8b, 9, 10, 10b, 10c, 13, 14, 14b).

### Existing tests updated, and why

Four assertions pinned the behaviour this task changes. All four keep their
intent; none was weakened to make the build pass.

- `tests/settingsSecurityContract.test.js` — rejected `vaultAutoLockMinutes: 1`.
  `1` is now valid, so the rejection case moved to `2` (still outside the set),
  and `0` and `-1` were added so the fail-closed path is covered more tightly
  than before, not less.
- `tests/settingsFunctionalRedesign.test.js` — asserted `'10 minutes'` was absent
  from the Settings render. It is now legitimately present as an unselected
  option, so the assertion became "which option is **selected**", which is what
  it was always trying to say. The source-level assertion about the timer was
  updated for the new `lock(true, armedMinutes)` form, and tightened with
  `assert.doesNotMatch(source, /const IDLE_LOCK_MS =/)`.
- `tests/vaultMediaPreview.test.js`, `tests/vaultStateSync.test.js` — both built a
  `RegExp` from `t('vaultAutoLocked')`, which is now a template containing `{n}`.
  Both now assert the interpolated message for the 10-minute fallback their
  fixtures actually exercise. Their stale comments describing a fixed
  product-wide 10-minute window were corrected to describe the fallback.

## Verification evidence

- `npm test` (IDEA1-AEGIS_Drive_LC) — pass: **1012 tests, 945 pass, 0 fail, 67
  skipped.** The 67 skips are the pre-existing PostgreSQL-gated suites.
  - `node --test tests/vaultAutoLockDuration.test.js` — pass: 9/9.
  - `node --test tests/vaultAutoLockTimer.test.js` — pass: 9/9.
- `npm run build` — pass. `dist/` was rebuilt only to verify and then restored
  with `git checkout -- dist/`; it is not part of this change.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings).
- Collaboration policy — validated locally against the PR body before pushing.

### What the new tests actually prove

`AUTOLOCK-8` arms the real component at each of 1/5/10/15/30/60 and asserts a
timer of exactly that many milliseconds is armed — so the timer is read from the
account, not from a constant. `AUTOLOCK-9`/`10`/`10b` fire that exact timer and
read the rendered text, so a message can only be right for the right reason.
`AUTOLOCK-13` dispatches each approved activity and asserts the previous timer
was cancelled and exactly one fresh timer armed, at 1 minute too. `AUTOLOCK-14`
locks with the button and asserts the auto-lock sentence is absent.

## Canonical notes updated

- `None` — not merged, not deployed, and SECURITY-2 is not closed. The durable
  fact (a 1-minute option exists and the message names the real duration) becomes
  true for `main` on merge and true for production only after migration 008 is
  applied and the acceptance walk passes. Reconciliation is under Integration
  requests.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`.

Note for the reviewer: `008_vault_autolock_1_minute.sql` and `schema.sql` touch
only the IDEA1-owned `aegis_drive.users` table, create no role or grant, and add
no cross-module contract — so this is not a shared surface. It does carry a
deployment ordering requirement, recorded below.

## Integration requests

- **Deployment ordering (kla):** migration `008_vault_autolock_1_minute.sql` must
  be applied **before** the new Drive image is activated. Until it runs, the old
  CHECK is still in force and a user who selects 1 minute gets a rejected save
  (the server validator would accept it; the database would not). Rollback is
  safe in the other direction: the previous image never sends 1, and the widened
  constraint accepts everything the old one did, so the image can be rolled back
  without reverting the migration.
- **Owner reconciliation after merge (kla):** record in `idea1/idea1-status.md`
  that Vault auto-lock offers 1/5/10/15/30/60 minutes and that the post-lock
  message names the configured duration.
- **SECURITY-2 closure (kla):** run the production acceptance walk in the task
  brief (A–I) after merge and deployment. This receipt does not close SECURITY-2.

## Known limitations

- **The PostgreSQL path of migration 008 has not been executed.** The repository
  has an isolated workflow for exactly this (`sh scripts/pg-integration-env.sh up`,
  which builds a disposable PostgreSQL 15 container with the production role
  split), but Docker Desktop's engine was not running in this environment
  (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file
  specified`), so the container could not be started. The 67 PostgreSQL-gated
  suites skipped for the same reason. AUTOLOCK-4 and AUTOLOCK-5 therefore assert
  the migration's **executable SQL text** — comments stripped — not its effect on
  a live database. Specifically **unproven**: that the catalog lookup finds the
  constraint 007 created, that `DROP CONSTRAINT` succeeds, and that
  `ADD CONSTRAINT` validates existing rows. Before deployment, run:

  ```
  sh scripts/pg-integration-env.sh up
  # then, against aegis_drive_test: apply 008 and confirm
  #   \d+ users        -> DEFAULT 10, NOT NULL, CHECK IN (1,5,10,15,30,60)
  #   INSERT/UPDATE with 1 succeeds, with 2 fails
  sh scripts/pg-integration-env.sh down
  ```

- **SECURITY-2 is NOT closed.** The production acceptance walk (1 minute → save →
  refresh → unlock → ~60 s idle → auto-lock → "Vault re-locked after 1 minute of
  inactivity." → then 5 minutes → restore the normal setting) has not been run.
  No production deployment was performed in this task.
- **The 1-minute option is short by design and is not defaulted.** An operator who
  selects it will be asked to re-enter the passphrase after a minute of genuine
  inactivity. That is the requested behaviour, but it is worth stating in the
  acceptance note so it is not later reported as a regression.
- **007 still declares the original set**, correctly — it is deployed and
  immutable, and a database that has only ever seen 007 keeps the narrow CHECK
  until 008 runs. AUTOLOCK-5 asserts 007 was not edited.
- Comments in historical Obsidian receipts that describe the old fixed 10-minute
  behaviour were deliberately left alone; they were true when written.
