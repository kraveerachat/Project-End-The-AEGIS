# IDEA1 Vault convergence and high-resolution UX implementation plan

> **For Codex:** Execute with the `superpowers:executing-plans` workflow. Apply
> strict `superpowers:test-driven-development`: write each RED test, run it and
> observe the expected failure before changing production code.

**Goal:** Converge every account on `VaultTreeScreen`, give Files and Vault one
full-main-pane marquee contract, expose semantic Vault upload collisions, and
support measured/bounded high-resolution client-only image thumbnails.

**Architecture:** A pure protocol-state decision module selects setup, locked,
convergence, or TREE UI without role input. App owns a generic Files/Vault
interaction surface. Upload queue presentation maps preserved TREE error codes.
Image thumbnail work uses a second-stage decode admission gate with one
high-resolution slot and a shared 256 MiB reservation budget; poster generation
reuses one bitmap.

**Stack:** React 19, Vite 7, Node test runner, jsdom, Web Crypto,
`createImageBitmap`, `OffscreenCanvas`, existing TREE_V1 client protocol.

**Base:** `1183df33698588788a82df42bfd616fb5b11d759`
**Branch:** `fix/idea1-vault-convergence-highres-ux`
**Design:** `docs/superpowers/specs/2026-09-26-idea1-vault-convergence-highres-ux-design.md`

## Guardrails for every task

- Do not modify PR #216, #218, or #219.
- Do not mutate Production or Production data.
- Do not create a final receipt or mark a Draft PR Ready.
- Do not change Files upload/download transport, Vault upload concurrency,
  Vault chunk size, networking, Docker, server media workers, or cache policy.
- Do not introduce server plaintext thumbnails or derivatives.
- Keep `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`.
- Stop if implementation needs destructive migration, automatic non-empty
  migration, server plaintext, or shared transfer changes.
- All focused tests run serially (`--test-concurrency=1`).
- Stage exact paths only. Never use `git add .`.

---

## Task 1: Pin protocol convergence decisions in a pure module

**Files:**

- Create: `IDEA1-AEGIS_Drive_LC/src/lib/vaultConvergence.js`
- Create: `IDEA1-AEGIS_Drive_LC/tests/vaultConvergence.test.js`

### Step 1: Write RED decision-table tests

Cover these inputs and exact results:

```js
decideVaultExperience({ configured: false })
// { kind: 'SETUP' }

decideVaultExperience({ configured: true, unlocked: false })
// { kind: 'LOCKED' }

decideVaultExperience({
  configured: true, unlocked: true, inventoryReady: true, blobCount: 0,
  protocolState: 'FLAT', flags: allTreeFlags,
})
// { kind: 'AUTO_EMPTY_GENESIS' }

decideVaultExperience({
  configured: true, unlocked: true, inventoryReady: true, blobCount: 2,
  protocolState: 'FLAT', flags: allTreeFlags,
})
// { kind: 'EXPLICIT_MIGRATION', requiresHumanAction: true }

decideVaultExperience({ protocolState: 'MIGRATING_TREE_V1', ...ready })
// { kind: 'RESUME_MIGRATION' }

decideVaultExperience({ protocolState: 'TREE_V1', ...ready })
// { kind: 'TREE' }
```

Also assert:

- missing/loading inventory returns `LOADING`, never empty genesis;
- unavailable schema/protocol/genesis/tree-UI flags return `UNAVAILABLE`;
- adding `role: 'Admin'` or `role: 'DataLake-User'` does not affect output;
- non-empty FLAT never returns an automatic state.

### Step 2: Run and observe RED

```powershell
cd IDEA1-AEGIS_Drive_LC
node --test --test-concurrency=1 tests/vaultConvergence.test.js
```

Expected: module-not-found failure.

### Step 3: Implement the smallest pure decision function

Use explicit constants for result kinds. Accept only observable configuration,
unlock, inventory, protocol, and flag facts. Do not accept role.

### Step 4: Run GREEN

Run the same command. Expected: all convergence table tests pass.

### Step 5: Commit

```powershell
git add IDEA1-AEGIS_Drive_LC/src/lib/vaultConvergence.js IDEA1-AEGIS_Drive_LC/tests/vaultConvergence.test.js
git commit -m "test(idea1): pin vault protocol convergence states"
```

---

## Task 2: Replace legacy operational routing with convergence gates

**Files:**

- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultMigrationDialog.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/strings.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultTreeMigrationUi.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultTreeScreen.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/helpers/vaultScreenHarness.js` if the
  harness needs zero-blob/setup states

### Step 1: Write RED lifecycle UI tests

Add tests proving:

1. Setup success with zero blobs enters automatic genesis progress and never
   renders legacy Upload or legacy cards.
2. Existing unlocked zero-blob FLAT enters automatic genesis once.
3. Existing unlocked non-empty FLAT renders the migration-only explanation and
   does not call begin until the Human clicks Start.
4. `MIGRATING_TREE_V1` renders only resume/remote/takeover recovery UI.
5. Successful commit refreshes `/api/vault/tree/state` and renders
   `VaultTreeScreen` without reload.
6. Existing `TREE_V1` goes directly to `VaultTreeScreen`.
7. Admin and DataLake fixtures produce identical operational component trees.
8. Missing flags/schema render an honest unavailable state, not legacy cards.

Use spies around `beginMigration`, `takeoverMigration`, `commitGenesis`, and the
state refresh. Do not mock a successful state without the existing encrypted
genesis sequence.

### Step 2: Run and observe RED

```powershell
cd IDEA1-AEGIS_Drive_LC
node --test --test-concurrency=1 tests/vaultConvergence.test.js tests/vaultTreeMigrationUi.test.js tests/vaultTreeScreen.test.js
```

Expected failures: zero-blob auto-start absent; legacy FLAT UI visible; commit
does not deterministically refresh state.

### Step 3: Wire the pure decision into `Vault.jsx`

- Wait for both Vault inventory and tree state before deciding emptiness.
- Keep setup and lock modals unchanged.
- After setup metadata succeeds, refresh Vault and tree state, then route through
  `AUTO_EMPTY_GENESIS`.
- For `AUTO_EMPTY_GENESIS`, invoke the existing `runGenesis` protocol through
  the migration component with an explicit `autoStart` mode.
- For `EXPLICIT_MIGRATION`, render only the migration gate. Start occurs only on
  the existing Human button.
- For `RESUME_MIGRATION`, render only recovery/resume/remote lease UI.
- For `TREE`, render only `VaultTreeScreen`.
- On commit, await/trigger `treeStateApi.refresh()` before rendering TREE.
- Never pass user role into this decision.

### Step 4: Make migration dialog modes explicit

Add a small mode API such as:

```jsx
<VaultMigrationDialog mode="auto-empty" ... />
<VaultMigrationDialog mode="explicit" ... />
<VaultMigrationDialog mode="resume" ... />
```

`auto-empty` starts once after confirming the frozen inventory is empty.
`explicit` retains the Human start button. `resume` follows existing lease
rules. Closing or failure returns to the convergence gate, never legacy files.

### Step 5: Remove the reachable legacy operational surface

Delete or isolate unreachable legacy upload/card controls after the new routing
tests pass. Preserve only compatibility code needed to unlock/decrypt old blob
metadata and perform secure migration. Do not delete blobs or old crypto
readers.

### Step 6: Run GREEN and regression tests

```powershell
node --test --test-concurrency=1 tests/vaultConvergence.test.js tests/vaultTreeMigration.test.js tests/vaultTreeMigrationUi.test.js tests/vaultTreeScreen.test.js tests/vaultTreeUi.test.js
```

### Step 7: Commit

```powershell
git add IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx IDEA1-AEGIS_Drive_LC/src/components/vault/VaultMigrationDialog.jsx IDEA1-AEGIS_Drive_LC/src/lib/strings.js IDEA1-AEGIS_Drive_LC/tests/vaultConvergence.test.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeMigrationUi.test.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeScreen.test.js IDEA1-AEGIS_Drive_LC/tests/helpers/vaultScreenHarness.js
git commit -m "feat(idea1): converge vault accounts on tree UI"
```

Omit the helper path from `git add` if unchanged.

---

## Task 3: Generalize the App full-pane marquee surface

**Files:**

- Modify: `IDEA1-AEGIS_Drive_LC/src/App.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/Files.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/useMarqueeSelection.js`
- Modify: `IDEA1-AEGIS_Drive_LC/src/index.css`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/filesInteractionPolish.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultTreeUi.test.js`

### Step 1: Write RED shared-surface tests

Extend jsdom geometry tests for both screens:

- left gutter drag intersects a tile;
- right gutter drag starts immediately;
- bottom whitespace drag starts immediately;
- blank space between Folders and Files starts immediately;
- blank primary click below threshold clears selection;
- Ctrl and Cmd blank clicks do not clear existing selection;
- controls, tiles, headings, inputs, menus, and non-primary buttons do not start;
- list mode does not start;
- App source exposes one generic Files/Vault surface condition, not Vault-only
  refs/attributes;
- Admin/DataLake props cannot change pointer registration.

### Step 2: Run and observe RED

```powershell
cd IDEA1-AEGIS_Drive_LC
node --test --test-concurrency=1 tests/filesInteractionPolish.test.js tests/vaultTreeUi.test.js
```

Expected: Files gutter/bottom and blank-click assertions fail; App remains
Vault-specific.

### Step 3: Remove Files' duplicate hook

Import `useMarqueeSelection` from `src/lib`. Add optional external surface ref
and handler registration to `Files`/`FilesSections`, matching Vault's ownership
pattern. When App owns the surface, the Files section must not create a nearer
positioned containing block for the overlay.

### Step 4: Generalize App ownership and CSS naming

- Replace Vault-specific refs with generic workspace refs.
- Activate only for `files` and `vault`.
- Give both screens the full-width/full-height relative surface.
- Keep page header and visual content inside a shared centered content class.
- Preserve existing responsive padding and 1440px visual measure.
- Keep all other screens' layout unchanged.

### Step 5: Run GREEN

Run the Step 2 command. Then run the existing folder history and drag/drop
tests that cover Files and Vault interactions.

### Step 6: Commit

```powershell
git add IDEA1-AEGIS_Drive_LC/src/App.jsx IDEA1-AEGIS_Drive_LC/src/screens/Files.jsx IDEA1-AEGIS_Drive_LC/src/lib/useMarqueeSelection.js IDEA1-AEGIS_Drive_LC/src/index.css IDEA1-AEGIS_Drive_LC/tests/filesInteractionPolish.test.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeUi.test.js
git commit -m "fix(idea1): share full-pane marquee across workspaces"
```

---

## Task 4: Surface semantic Vault upload collisions

**Files:**

- Modify: `IDEA1-AEGIS_Drive_LC/src/components/UploadStatusTray.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/strings.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultTreeUploadClient.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultTreeOps.test.js`
- Create: `IDEA1-AEGIS_Drive_LC/tests/vaultUploadSemanticReason.test.js`

### Step 1: Write RED semantic-path tests

Pin all layers:

1. Real `attachBlob` against exact existing sibling throws `COLLISION`.
2. Real `attachBlob` for `EXAMPLE.JPG` against `example.jpg` throws
   `COLLISION` through the pinned Unicode case fold.
3. A different name returns a new node and attach reference.
4. `uploadTreeFile`/queue preserves the thrown `COLLISION` code.
5. `UploadStatusRow` renders the localized collision reason under Failed.
6. No test observes rename or overwrite.

### Step 2: Run and observe RED

```powershell
cd IDEA1-AEGIS_Drive_LC
node --test --test-concurrency=1 tests/vaultTreeOps.test.js tests/vaultTreeUploadClient.test.js tests/vaultUploadSemanticReason.test.js
```

Expected: semantic operation tests pass where already covered; final visible
reason test fails because `REASON_LABEL` lacks `COLLISION`.

### Step 3: Add presentation mapping only

Map uppercase `COLLISION` to the existing localized
`vaultTreeNameCollision` key or a dedicated upload collision key if context
requires it. Do not alter collision detection, manifest semantics, queue retry,
or orphan lifecycle.

### Step 4: Run GREEN and commit

```powershell
node --test --test-concurrency=1 tests/vaultTreeOps.test.js tests/vaultTreeUploadClient.test.js tests/vaultUploadSemanticReason.test.js
git add IDEA1-AEGIS_Drive_LC/src/components/UploadStatusTray.jsx IDEA1-AEGIS_Drive_LC/src/lib/strings.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeOps.test.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeUploadClient.test.js IDEA1-AEGIS_Drive_LC/tests/vaultUploadSemanticReason.test.js
git commit -m "fix(idea1): explain vault upload name collisions"
```

---

## Task 5: Add RED tests for two-lane decode admission

**Files:**

- Create: `IDEA1-AEGIS_Drive_LC/tests/vaultImageDecodeAdmission.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultImageThumb.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultThumbScheduler.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultTreeLimits.test.js`

### Step 1: Write RED admission tests

Use deferred promises and injected byte counts. Assert:

- four small normal jobs may enter concurrently;
- two >16 MP jobs never decode together;
- a high-resolution job waits when its reservation plus live preview memory
  exceeds 256 MiB;
- releasing a job starts the next eligible waiter;
- abort removes a queued waiter immediately;
- `releaseAll` leaves running=0, queued=0, reservedBytes=0;
- a late completion after abort cannot publish a result;
- the default global ceiling remains exactly 256 MiB.

### Step 2: Write RED thumbnail tests

With injected limits, fixtures, decoder, and poster:

- 736×981 uses normal lane;
- 6240×4160 uses high-resolution lane when the injected cap allows it;
- one decoder call and one bitmap close occur;
- poster receives the same decoded bitmap object;
- `fullBytesRef.bytes` is null after success, failure, and abort;
- above injected cap returns `HIGH_RES_TOO_LARGE` before decode;
- no URL exists on abort/failure;
- completion retains only bounded poster bytes.

Do not set the production high-resolution cap yet.

### Step 3: Run and observe RED

```powershell
cd IDEA1-AEGIS_Drive_LC
node --test --test-concurrency=1 tests/vaultTreeLimits.test.js tests/vaultImageDecodeAdmission.test.js tests/vaultImageThumb.test.js tests/vaultThumbScheduler.test.js
```

Expected: missing admission module/new limits; 25.96 MP rejected; poster decoder
called twice under production defaults.

### Step 4: Commit RED tests only

```powershell
git add IDEA1-AEGIS_Drive_LC/tests/vaultImageDecodeAdmission.test.js IDEA1-AEGIS_Drive_LC/tests/vaultImageThumb.test.js IDEA1-AEGIS_Drive_LC/tests/vaultThumbScheduler.test.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeLimits.test.js
git commit -m "test(idea1): define bounded high-res thumbnail lane"
```

---

## Task 6: Implement decode admission with no selected production cap

**Files:**

- Create: `IDEA1-AEGIS_Drive_LC/src/lib/vaultImageDecodeAdmission.js`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeLimits.js`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/vaultImageThumb.js`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/vaultUnlockedState.js` only if a small
  buffer-holder lifecycle helper is required
- Modify the tests from Task 5

### Step 1: Add explicit limits without raising the active cap

Add versioned/validated keys such as:

```js
imageNormalMaxDecodedPixels: 16_000_000,
imageHighResMaxDecodedPixels: 16_000_000, // unchanged until measurement passes
imageHighResMaxConcurrentJobs: 1,
memoryCeilingBytes: 256 * MIB,
```

If compatibility requires retaining `imageMaxDecodedPixels`, define the
migration/alias deliberately and pin it by test. Do not silently reinterpret
unknown overrides.

### Step 2: Implement admission queue

The admission module must:

- classify normal/high-res from parsed pixels;
- enforce high-res concurrency 1;
- retain normal maximum 4 when budget allows;
- reserve input + RGBA + bounded poster allowance;
- incorporate live scheduler memory via an injected callback;
- use FIFO with head-of-line bypass only where a later job safely fits;
- remove aborted waiters;
- return an idempotent release function;
- expose read-only stats for tests/diagnosis;
- contain no storage or network API.

### Step 3: Refactor `makeImageThumb` to one decode

- Parse header before admission.
- Return `HIGH_RES_TOO_LARGE` above the injected cap.
- Await admission before `createImageBitmap`.
- Pass the resulting bitmap to poster generation.
- Close bitmap and release reservation in `finally`.
- Clear/overwrite owned byte holders best-effort in `finally`.
- Reject late results after abort/purge.
- Never mint an Object URL until bounded poster bytes exist and the Vault is
  still unlocked.

### Step 4: Run GREEN

Run Task 5's command. Confirm all unit tests pass while production defaults
still reject >16 MP.

### Step 5: Storage/security static proof

Extend `vaultStorageAbsence.test.js` to include the new module and prove it has
no Cache API, IndexedDB, local/session storage, filesystem, Sharp, FFmpeg, or
server import.

### Step 6: Commit

```powershell
git add IDEA1-AEGIS_Drive_LC/src/lib/vaultImageDecodeAdmission.js IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeLimits.js IDEA1-AEGIS_Drive_LC/src/lib/vaultImageThumb.js IDEA1-AEGIS_Drive_LC/src/lib/vaultUnlockedState.js IDEA1-AEGIS_Drive_LC/tests/vaultImageDecodeAdmission.test.js IDEA1-AEGIS_Drive_LC/tests/vaultImageThumb.test.js IDEA1-AEGIS_Drive_LC/tests/vaultThumbScheduler.test.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeLimits.test.js IDEA1-AEGIS_Drive_LC/tests/vaultStorageAbsence.test.js
git commit -m "feat(idea1): bound vault image decode admission"
```

Omit `vaultUnlockedState.js` from staging if unchanged.

---

## Task 7: Wire the admission lane into Vault TREE media UI

**Files:**

- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultFileTile.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/strings.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/vaultTreeUi.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/filesVaultPresentation.test.js`

### Step 1: Write RED integration tests

- One admission instance exists per unlocked TREE screen.
- Image load delegates byte ownership to `makeImageThumb`; it does not retain a
  second outer `bytes` reference.
- Scheduler live-memory stats feed decode admission.
- `HIGH_RES_TOO_LARGE` renders a visible localized tile explanation.
- Lock/unmount calls scheduler release, aborts admission waiters, and produces no
  late poster URL.
- Video/GIF paths remain unchanged.

### Step 2: Run RED

```powershell
cd IDEA1-AEGIS_Drive_LC
node --test --test-concurrency=1 tests/vaultTreeUi.test.js tests/filesVaultPresentation.test.js tests/vaultImageDecodeAdmission.test.js tests/vaultImageThumb.test.js tests/vaultThumbScheduler.test.js
```

### Step 3: Wire production components

- Create the admission gate with `useMemo` for one unlocked screen lifetime.
- Pass a live scheduler memory callback without rebuilding the scheduler.
- Let `makeImageThumb` own the image byte-return promise and holder lifecycle.
- Map permanent high-res rejection to translated tile status.
- Keep poster/Object URL registration in the existing unlocked state.

### Step 4: Run GREEN and commit

```powershell
node --test --test-concurrency=1 tests/vaultTreeUi.test.js tests/filesVaultPresentation.test.js tests/vaultImageDecodeAdmission.test.js tests/vaultImageThumb.test.js tests/vaultThumbScheduler.test.js tests/vaultStorageAbsence.test.js
git add IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx IDEA1-AEGIS_Drive_LC/src/components/vault/VaultFileTile.jsx IDEA1-AEGIS_Drive_LC/src/lib/strings.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeUi.test.js IDEA1-AEGIS_Drive_LC/tests/filesVaultPresentation.test.js
git commit -m "feat(idea1): wire bounded high-res vault previews"
```

---

## Task 8: Measure real browser/runtime memory before selecting a cap

**Files:**

- Do not commit raw fixtures, screenshots, process dumps, profiles, or generated
  images.
- Modify after PASS only:
  `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeLimits.js`
- Modify after PASS only:
  `IDEA1-AEGIS_Drive_LC/tests/vaultTreeLimits.test.js`
- Modify after PASS only:
  `IDEA1-AEGIS_Drive_LC/tests/vaultImageThumb.test.js`
- Record summarized evidence later in:
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`

### Step 1: Prepare disposable local fixtures outside Git

Generate non-private JPEG fixtures at:

- 736×981 control;
- 6240×4160 representative input;
- 32,000,000-pixel proposed upper-bound geometry;
- slightly above the proposed bound.

Fixture generation may use local development tooling, but never product server
routes. Confirm `git status --short` stays free of fixtures.

### Step 2: Use an isolated real browser process

Launch a disposable local Chrome/Edge profile and a local-only measurement page
that runs the production single-decode/admission functions. Record the browser
root PID and child process set before measurement. Do not use the owner's normal
profile or private files.

### Step 3: Measure native/process working-set delta

Sample aggregate working set for the isolated browser process tree at a fixed
short interval. For each fixture record:

- process baseline before preview;
- peak incremental working-set delta;
- post-close/post-release settling delta;
- admission reserved bytes and peak reservations;
- decode calls, concurrent high-res decode count, bitmap closes;
- retained bounded poster bytes and URLs;
- result after lock while queued and while running.

Also record JS heap where available, but never use it as sole evidence.

### Step 4: Decide the cap

- PASS 32 MP only if representative and upper-bound runs remain bounded under
  the 256 MiB preview policy with documented safety margin and high-res
  concurrency exactly 1.
- If 32 MP fails but 25.96 MP passes safely, choose the smallest justified cap
  above 25,958,400 pixels and rerun its boundary/above-boundary cases.
- If 25.96 MP cannot be shown bounded, STOP. Do not change production default.

### Step 5: Promote the measured cap through RED → GREEN

First change tests to the measured exact cap and run them RED against the still
16 MP production default. Then update `vaultTreeLimits.js` and rerun GREEN.

### Step 6: Commit only summarized policy/code

```powershell
git add IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeLimits.js IDEA1-AEGIS_Drive_LC/tests/vaultTreeLimits.test.js IDEA1-AEGIS_Drive_LC/tests/vaultImageThumb.test.js
git commit -m "perf(idea1): adopt measured vault image preview cap"
```

Do not use a `perf` claim if measurement is blocked; report `PARTIAL/BLOCKED`
instead and leave the default at 16 MP.

---

## Task 9: Full focused verification and Impeccable review loop

**Files:** production/test files already changed; no new feature scope.

### Step 1: Run the affected matrix

```powershell
cd IDEA1-AEGIS_Drive_LC
node --test --test-concurrency=1 tests/vaultConvergence.test.js tests/vaultTreeMigration.test.js tests/vaultTreeMigrationUi.test.js tests/vaultTreeScreen.test.js tests/vaultTreeUi.test.js tests/vaultTreeOps.test.js tests/vaultTreeUploadClient.test.js tests/vaultUploadSemanticReason.test.js tests/filesInteractionPolish.test.js tests/filesVaultPresentation.test.js tests/vaultTreeLimits.test.js tests/vaultImageDecodeAdmission.test.js tests/vaultImageThumb.test.js tests/vaultThumbScheduler.test.js tests/vaultStorageAbsence.test.js
```

Record exact pass/fail/skip counts. Classify every failure as introduced,
pre-existing, environmental, or dependency-related. Fix introduced failures by
returning to RED first.

### Step 2: Run build

```powershell
npm run build
```

Restore tracked generated `dist/index.html` to the branch base if the build
changes it. Do not commit generated build output.

### Step 3: Run Impeccable critique/audit/harden/polish

Inspect the real running surface at normal desktop and QHD-style wide desktop:

- centered visual measure unchanged;
- Files and Vault left/right/bottom/inter-section marquee;
- controls excluded and overlay coordinates exact;
- convergence/setup/migration/recovery states truthful;
- semantic collision copy localized and accessible;
- high-res rejection explanation visible but visually secondary;
- keyboard, touch/coarse pointer, reduced motion, light/dark, and responsive
  behavior unchanged or improved;
- lock/unlock and late-result behavior fail secure.

Any product bug discovered returns to TDD. Do not declare Human acceptance.

### Step 4: Run governance and repository checks

From repository root:

```powershell
node --test --test-concurrency=1 tests/collaborationPolicy.test.mjs
node scripts/validate-vault.mjs
git diff --check
git status --short
git diff --name-status 1183df33698588788a82df42bfd616fb5b11d759...HEAD
```

Run an added-line secret scan against the task base. Review every match; do not
print actual secrets. Confirm no `.env`, credentials, fixtures, profiles,
generated media, process dumps, or browser data entered Git.

### Step 5: Commit fixes only if needed

Use focused commits. No receipt, Ready transition, merge, or Production action.

---

## Task 10: Canonical status, Draft PR, and Human handoff

**Files:**

- Modify:
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
- No receipt file.

### Step 1: Update the current task/session register

Record:

- branch and exact base;
- approved design/spec/plan paths;
- root causes and selected measured cap, or honest measurement blocker;
- exact changed paths;
- RED/GREEN evidence and final test counts;
- runtime measurement method, baseline/peak delta/safety margin;
- `MAIN_TRANSFER_BASELINE_IMPACT=NO`;
- `VAULT_MEDIA_PREVIEW_BEHAVIOR_CHANGED=YES`;
- PR #216/#218/#219 untouched;
- Production untouched;
- no final receipt;
- Human browser acceptance pending.

Do not retain stale claims that pre-change media benchmarks are valid
post-change.

### Step 2: Validate and checkpoint documentation

```powershell
node scripts/validate-vault.mjs
git diff --check
git add Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md docs/superpowers/specs/2026-09-26-idea1-vault-convergence-highres-ux-design.md docs/superpowers/plans/2026-09-26-idea1-vault-convergence-highres-ux.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs(idea1): record vault convergence verification"
```

Only stage spec/plan if they have intentional post-approval corrections not
already committed.

### Step 3: Push and open a Draft stacked PR

Push the same branch normally. Open a Draft PR against
`fix/idea1-files-vault-parity-recovery` while PR #219 remains unmerged. State
the dependency and include the unchanged hidden collaboration-policy block.

PR body must list:

- area `idea1`, owner `kla`, receipt pending;
- exact summary and changed paths;
- measurement result and selected cap or blocker;
- exact verification commands/results;
- no shared/cross-scope paths unless the final diff proves otherwise;
- PR #216/#218/#219 untouched;
- transfer/network/server-media boundaries unchanged;
- Production untouched;
- Human acceptance pending;
- Draft / `DO_NOT_MERGE`.

Attach the created PR to this task. Wait for collaboration guardrails on the
exact remote head.

### Step 4: Stop for Human browser acceptance

Return the task's required report fields. Keep:

```text
HUMAN_ACCEPTANCE=NOT_TESTED
FINAL_RECEIPT_CREATED=NO
NEXT_GATE=HUMAN_OWNER_BROWSER_ACCEPTANCE
```

Do not mark Ready or merge.
