# IDEA1 Vault convergence, full-pane selection, and high-resolution thumbnails

**Task:** `IDEA1-VAULT-CONVERGENCE-HIGHRES-UX-1`

**Area / owner:** IDEA1 / Kla (`kla`)

**Approved:** 2026-09-26, with the conditions recorded below

**Exact source:** `1183df33698588788a82df42bfd616fb5b11d759`

**Dependency:** Draft PR #219, stacked on Draft PR #218

**Status:** design approved; implementation and Human acceptance pending

## 1. Purpose

This task removes four connected inconsistencies without changing the transfer,
network, server-media, or zero-knowledge contracts:

1. Every account converges to the same operational Private Vault UI.
2. Files and Private Vault share one full-main-pane marquee interaction model.
3. Vault upload failures surface their actual semantic reason.
4. A bounded client-only lane may generate thumbnails for representative
   6240×4160 JPEG images if runtime measurement proves the lane remains within
   the unchanged 256 MiB preview-memory policy.

The design does not deploy Production, migrate Production accounts, enable
destructive purge, modify PR #216/#218/#219, or create a final receipt.

## 2. Proven current-state causes

### 2.1 Account-dependent Vault UI

`Vault.jsx` renders `VaultTreeScreen` only while the Vault is unlocked, the
server reports `TREE_V1`, and `treeUiEnabled` is true. An unlocked `FLAT` owner
continues into the legacy card UI. `MIGRATING_TREE_V1` opens the migration
dialog, while the legacy body remains the surrounding operational surface.

Role is not the direct selector. Protocol state is. The resulting product is
still account-dependent because accounts can remain in different protocol
states indefinitely.

### 2.2 Files marquee geometry

Vault delegates marquee pointer ownership to the App-level main-pane surface.
Files owns a separate `useMarqueeSelection` implementation inside
`FilesSections`, whose canvas is limited to the centered content and
`min-h-[50vh]`. Wide gutters and main-pane space below that canvas cannot begin
selection.

The local Files hook also differs from the shared hook: it does not implement
the accepted sub-threshold blank-click clear behavior.

### 2.3 Generic upload failure

The tree upload path is:

```text
VaultUploadDrawer
  → VaultTreeScreen.runVaultUpload
  → uploadTreeFile
  → session.commit(attachBlob)
  → applyIntent(opAttachBlob)
  → checkCollision
  → OpError("COLLISION")
```

`VaultUploadDrawer` catches the exception and preserves `error.code` as the
queue reason. `UploadStatusTray` has no label for `COLLISION`, so the row shows
only the generic failed-stage label. Collision detection itself is correct and
uses the manifest's NFC plus version-pinned full Unicode case fold.

### 2.4 High-resolution image rejection and double decode

The observed images are below the 16 MiB compressed-input ceiling but above
the 16,000,000 decoded-pixel ceiling:

| File | Bytes | Dimensions | Pixels | Current result |
|---|---:|---:|---:|---|
| `karina01.jpg` | 114,072 | 736×981 | 722,016 | normal thumbnail lane |
| `IMG_3107.JPG` | 6,495,642 | 6240×4160 | 25,958,400 | rejected by pixel limit |
| `IMG_3207.JPG` | 7,174,628 | 6240×4160 | 25,958,400 | rejected by pixel limit |

Filename-extension casing is not involved.

`makeImageThumb` currently calls `decode(full)` and then passes the same bytes
to `defaultPoster`, which calls `defaultDecode(bytes)` again. The production
poster path therefore decodes the full image twice and temporarily retains
more heavyweight browser resources than necessary.

## 3. Chosen architecture

### 3.1 Vault protocol convergence gate

Vault protocol state, not role, drives one convergence state machine:

```text
UNCONFIGURED
  └─ Human completes existing zero-knowledge setup
       └─ create metadata
            └─ automatic zero-item genesis
                 └─ TREE_V1 → VaultTreeScreen

FLAT + zero blobs
  └─ automatic zero-item genesis
       └─ TREE_V1 → VaultTreeScreen

FLAT + one or more blobs
  └─ migration-only gate after unlock
       └─ explicit Human start
            └─ existing secure genesis migration
                 └─ TREE_V1 → VaultTreeScreen

MIGRATING_TREE_V1
  └─ recovery/resume/takeover gate only
       └─ existing secure migration completes
            └─ TREE_V1 → VaultTreeScreen

TREE_V1
  └─ VaultTreeScreen
```

The existing `/api/vault/setup`, tree state, migration lease, frozen inventory,
encrypted manifest, revision publish, ciphertext PUT, and genesis commit
protocols remain authoritative. No new destructive migration exists.

For a new or empty Vault, the server can briefly and recoverably report `FLAT`
or `MIGRATING_TREE_V1` while the existing multi-step protocol completes. The UI
does not expose the legacy operational surface during this interval. Failure
shows a retry/resume state; it never falls through to legacy cards.

An existing non-empty `FLAT` Vault never starts genesis without explicit Human
action. Its migration gate may report opaque counts and migration state, but it
does not become a second file-management implementation.

If required TREE flags or schema are unavailable, the UI fails closed with an
honest unavailable/retry state. It does not use role or legacy UI as fallback.

### 3.2 Full-main-pane interaction surface

App owns one generic workspace interaction surface for `files` and `vault`:

```text
Authenticated main pane
└── full-width/full-height interaction surface
    ├── centered/max-width page header
    └── centered/max-width Files or Vault visual content
```

The existing 1440px visual measure and responsive padding remain. Only the
invisible interaction surface expands.

Files removes its duplicate marquee hook and consumes the shared
`useMarqueeSelection`. Files and Vault register their active grid handler and
tile elements with the App-owned surface. The active screen owns only one
selection set; App does not duplicate business state.

The shared contract is:

- primary mouse/pen drag from blank left gutter, right gutter, bottom space, or
  inter-section space starts marquee after the existing threshold;
- a primary blank click below threshold clears selection when not additive;
- Ctrl/Cmd preserves the previous selection and adds intersected items;
- tiles, controls, inputs, labels, links, menus, dialogs, and marked headings
  cannot start marquee;
- touch does not start desktop marquee;
- list mode disables marquee;
- Escape restores the pre-drag selection;
- overlay coordinates remain relative to the App interaction surface.

There is no role branch.

### 3.3 Semantic upload failure presentation

The upload and tree mutation contracts remain unchanged. Queue presentation
adds a localized mapping for the preserved semantic reason:

```text
COLLISION → “An item with this name already exists here.”
```

Thai and Chinese use their corresponding localized text. The generic failed
stage remains as the status heading; the semantic reason is rendered beneath
it. No implicit rename or overwrite occurs. The encrypted uploaded blob remains
an explicit recoverable orphan under the existing policy.

Coverage pins:

- `IMG_3107.JPG` against an existing exact sibling → `COLLISION` visible;
- `EXAMPLE.JPG` against existing `example.jpg` → case-fold collision visible;
- a genuinely different sibling name → semantic attach succeeds.

### 3.4 Two-lane image decode admission

The outer thumbnail scheduler retains its existing maximum of four jobs and its
existing object-URL lifecycle. A client-only image decode admission gate is
added inside the image thumbnail path, after header parsing and before bitmap
decode.

#### Normal lane

- decoded pixels `<= 16,000,000`;
- existing maximum scheduler concurrency remains available;
- every admission still respects the global working-set budget.

#### High-resolution lane

- decoded pixels `> 16,000,000` and `<= measuredHighResPixelCap`;
- at most one high-resolution bitmap decode runs at a time;
- normal work may run concurrently only when the combined reservation remains
  within the unchanged memory ceiling;
- output is only the existing bounded poster (`posterMaxEdge=512`).

#### Above the measured cap

- no automatic bitmap decode;
- result reason is `HIGH_RES_TOO_LARGE` (or the established general
  `IMAGE_TOO_LARGE` at the boundary where compressed input itself is too large);
- the tile renders a localized visible explanation rather than a raw error code.

The 32 MP candidate is provisional. It is not selected by arithmetic alone.
Implementation first adds measurement and admission instrumentation, then tests
representative 25.96 MP and proposed upper-bound inputs in a real browser
runtime. The final committed cap is the highest tested cap that stays safely
bounded. If 32 MP fails, the cap is lowered while retaining 25.96 MP support if
that input passes. If the representative input itself cannot remain bounded,
implementation stops and reports the blocker.

### 3.5 Working-set accounting

Admission uses a conservative reservation:

```text
compressed/decrypted input bytes
+ width × height × 4 decoded bitmap bytes
+ bounded poster canvas bytes
+ bounded encoded poster bytes allowance
```

Reservations are combined with live scheduler memory before work begins. A job
waits rather than exceeding `memoryCeilingBytes=256 MiB`. The policy value is
not increased.

For reference only, not acceptance evidence, 6240×4160 requires approximately
103,833,600 RGBA bytes before input and poster allocations. Runtime measurement,
not this estimate, decides the cap.

### 3.6 Single-decode lifecycle

The production image path becomes:

```text
decrypt/read bounded input
→ parse header
→ classify lane and reserve working set
→ one createImageBitmap decode
→ draw that bitmap into bounded poster canvas
→ encode bounded poster
→ close bitmap in finally
→ best-effort overwrite/drop owned plaintext references
→ release admission reservation
→ retain only bounded poster bytes/Object URL
```

`defaultPoster` accepts the already-decoded bitmap. It does not decode bytes a
second time.

Input references are held through an explicit holder registered with the
unlocked-state lifecycle. Completion and failure clear the holder; lock,
logout, unmount, navigation, session invalidation, and page hide abort queued
or running work and invalidate late results. Best-effort `Uint8Array.fill(0)` is
described only as overwriting the still-referenced JavaScript buffer. It is not
physical or cryptographic memory zeroization.

Some browser decode internals are not synchronously cancellable. After abort,
their result is rejected from product state, the bitmap is closed immediately
if it arrives, and no URL is minted. The UI never claims physical memory was
instantly erased.

## 4. Runtime measurement gate

Measurement runs before adopting the high-resolution cap:

1. Use an isolated local browser process/session and synthetic or disposable
   local JPEG fixtures containing no private user data.
2. Measure a 736×981 control, the exact 6240×4160 representative geometry, and
   a fixture at the proposed upper bound.
3. Run one decode, repeated sequential decodes, and attempted concurrent
   high-resolution requests.
4. Record browser/process working-set baseline, observed peak, post-release
   settling value, admission reservations, decode count, bitmap close count,
   retained poster bytes, and URL count.
5. Lock during queued and running jobs; verify pending high-resolution count,
   URLs, and late state writes return to zero.
6. Treat JavaScript heap metrics alone as insufficient because `ImageBitmap`
   may allocate native/GPU memory outside that heap.
7. Keep raw local measurement artifacts outside the repository unless a small,
   non-secret summarized fixture/result is intentionally reviewed for commit.

The cap passes only when the measured incremental preview working-set delta,
combined with the admission reservation and a documented safety margin, remains
below the unchanged 256 MiB preview policy. The browser's unrelated baseline is
recorded separately rather than charged to this feature. An ambiguous or
unavailable native-memory measurement is not a pass.

## 5. Security invariants

The implementation must preserve:

- `SERVER_PLAINTEXT_DERIVATIVE=NO`
- `SERVER_PLAINTEXT_THUMBNAIL=NO`
- `SERVER_VAULT_FFMPEG=NO`
- `SERVER_VAULT_SHARP=NO`
- `VAULT_ZERO_KNOWLEDGE=UNCHANGED`
- `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`
- client-side KEK/DEK/TRK and encrypted manifest semantics;
- existing TREE CAS/rebase, orphan recovery, and fail-secure behavior;
- no persistent plaintext cache in Cache API, IndexedDB, localStorage, or
  sessionStorage.

## 6. Performance-study boundary

PR #216 remains untouched. This task does not change Files upload/download,
Vault chunk size, Vault upload concurrency, Twingate, Cloudflare, Docker,
network routes, server media workers, or server media-cache policy.

Classification:

- `MAIN_TRANSFER_BASELINE_IMPACT=NO`
- `VAULT_MEDIA_PREVIEW_BEHAVIOR_CHANGED=YES`

Any media-preview benchmark collected before this implementation cannot be
reported as a post-change result.

## 7. Error and recovery behavior

- Setup succeeds but zero-item genesis fails: stay in convergence recovery;
  preserve configured metadata; offer retry/resume; never show legacy cards.
- Non-empty migration fails before commit: preserve FLAT data and migration
  lease semantics; show exact migration error/retry.
- Active migration lease on another client: show remote lease state; takeover
  only through the existing expiry contract.
- Required flags/schema unavailable: fail closed and report configuration;
  never fabricate `TREE_V1`.
- Collision after encrypted upload: show `COLLISION`; preserve orphan recovery.
- Decode over measured cap: retain generic file icon plus visible localized
  high-resolution-limit explanation.
- Lock/logout/unmount during image work: abort, remove queued admission, close
  late bitmap, mint no URL, and clear heavyweight references best-effort.

## 8. Verification contract

Implementation follows strict RED → GREEN → REFACTOR. Required focused proof:

1. new/unconfigured setup converges through zero-item genesis;
2. existing zero-blob FLAT convergence;
3. non-empty FLAT requires explicit action;
4. `MIGRATING_TREE_V1` recovery/resume/takeover;
5. existing `TREE_V1` path unchanged;
6. role-independent rendering and interaction;
7. Files and Vault full-pane gutters/bottom/inter-section marquee;
8. shared blank-click clear, additive selection, exclusions, and list-mode off;
9. exact and case-folded collision reasons plus different-name success;
10. 0.72 MP normal thumbnail lane and unchanged normal concurrency;
11. 25.96 MP high-resolution lane;
12. proposed-cap fixture and above-cap explicit reason;
13. one high-resolution decode at a time;
14. exactly one full bitmap decode per image;
15. completion/failure releases bitmap and full plaintext references;
16. lock/logout/unmount aborts running/queued work and blocks late URLs/state;
17. no server or persistent plaintext derivative path.

Then run all affected Vault TREE/media/Files suites, build, collaboration
policy tests, Vault validator, `git diff --check`, and added-line secret scan.

## 9. Stop conditions

Stop before implementation expansion if any requirement needs:

- destructive data migration or automatic migration of non-empty FLAT Vaults;
- server plaintext handling or server-generated Vault derivatives;
- shared transfer/chunk/concurrency/network/cache changes;
- an increase of the 256 MiB preview-memory ceiling;
- modification of PR #216/#218/#219;
- Production mutation.

Stop during measurement if representative 25.96 MP decoding cannot be shown to
remain bounded. Do not force a cap from arithmetic alone.
