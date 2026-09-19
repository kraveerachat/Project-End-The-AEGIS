# AEGIS IDEA1 — Private Vault Encrypted Hierarchy Design

## 1. Status and Decision

**PLANNED / DRAFT / ARCHITECTURE DESIGN ONLY — NOT IMPLEMENTED.**

Task: `PRIVATE-VAULT-ENCRYPTED-HIERARCHY-1`; area: IDEA1; owner: Kla
(`kla`). Branch: `feat/idea1-private-vault-encrypted-hierarchy`.
Repository source basis: `c5468c520f24d29fb37fefcf7c4411b91d4087f4`
(`origin/main` fetched 2026-09-19; PR #150 merge commit).

The Human Owner has selected **Approach B: one encrypted, versioned tree
manifest referencing opaque immutable Vault blobs**. This document compares the
viable alternatives, fixes the architecture contract, and stops before any
product implementation, schema migration, rollout, or Production mutation.

```text
MODE=ARCHITECTURE_DESIGN_ONLY
APPROACH=B
IMPLEMENTATION_STARTED=NO
SERVER_KNOWS_PARENT_CHILD=NO
SERVER_KNOWS_FOLDER_TREE=NO
SERVER_KNOWS_PLAINTEXT_NAMES=NO
SERVER_KNOWS_PLAINTEXT_CONTENT=NO
SERVER_PLAINTEXT_MEDIA_CACHE=NO
TREE_REVISION_CONCURRENCY=GENERATION_CAS
EXISTING_V1_V2_CIPHERTEXT_COMPATIBILITY=PRESERVED
PRIVATE_VAULT_TRANSFER_PERF=DEFERRED_TO_SEPARATE_PR
```

## 2. Goals

1. Add real encrypted folders and arbitrary nested hierarchy without revealing
   parent-child relationships to the server.
2. Give Private Vault distinct Folder/File presentation while reusing the
   interaction language of Files: navigation, breadcrumbs, selection, menus,
   Rename, Move, internal drag/drop, Trash, Restore, and preview where valid.
3. Make one encrypted manifest revision the atomic client-visible unit for a
   hierarchy mutation.
4. Prevent stale clients from silently overwriting newer tree state.
5. Preserve all current V1 and V2 ciphertext blobs without server-side
   decryption or bulk re-encryption.
6. Keep decrypted names, hierarchy, thumbnails, posters, media bytes, and
   preview keys ephemeral and client-only.
7. Define honest failure, migration, rollback, test, and Production acceptance
   gates before implementation begins.

## 3. Non-Goals

- Upload/download throughput optimization, new chunk sizes, transport
  concurrency tuning, or transfer benchmarking. These belong to the separate
  `PRIVATE-VAULT-TRANSFER-PERF` task.
- Public sharing, server-generated media derivatives, plaintext search/indexes,
  collaborative/shared Vault trees, or cross-account moves.
- Private Vault plaintext or ciphertext exposure over SMB.
- Offline-first mutation queues or persistent plaintext client caches.
- Replacing the current Argon2id Vault unlock model or V1/V2 file encryption.
- Implementing product source, SQL, tests, Docker, network, or Production state
  in this Draft.

## 4. Evidence from the Current Repository

This design is grounded in current source, not an assumed future implementation:

- `vaultCrypto.js` derives a non-extractable KEK with Argon2id and encrypts V1
  file metadata/content using a random per-file DEK wrapped by that KEK.
- `vaultChunkCrypto.js` preserves the random-per-file DEK model for V2, uses
  random IVs, and authenticates content identity/chunk position with AES-GCM
  AAD. Metadata currently contains `{name, type, plainSize}` encrypted under the
  file DEK.
- `vaultChunkedUpload.js` / `vaultChunkedDownload.js` stream one V2 chunk at a
  time. V2 content blobs are immutable after commit.
- `vaultInventory.js` reconciles a flat owner-scoped list of opaque V1 numeric
  IDs and V2 random IDs. It has no folders, parent references, tree generation,
  or compare-and-swap head.
- `Vault.jsx` decrypts names only after unlock and currently offers Preview,
  Details, Download, and immediate Delete. It has no Rename, Move, selection,
  breadcrumbs, or internal drag/drop.
- `vaultPreviewSession.js` and the Vault preview Service Worker hold preview
  tokens and non-extractable DEKs in memory, serve same-origin virtual preview
  URLs, decrypt authenticated ranges client-side, use `Cache-Control: no-store`,
  and revoke sessions on close/lock/unmount.
- `vault_v2_blobs` stores owner, opaque object ID, storage key, ciphertext sizes,
  chunk layout, wrapped DEK, and encrypted metadata. It stores no plaintext
  name/MIME or parent ID.
- `GET /api/vault` returns owner-scoped opaque V1/V2 envelopes. Current Delete
  removes the metadata row and ciphertext immediately.
- PR #150 added the normal Files hierarchy, atomic server-visible Rename/Move,
  cycle detection, breadcrumbs, multi-selection, internal drag/drop, and a
  server plaintext media-derivative pipeline. The interaction language is
  reusable; its server-visible hierarchy and media cache are not valid for
  Private Vault.

Existing source and tests remain unchanged by this design.

## 5. Threat Model

### Protected against

- An honest-but-curious server, database reader, storage operator, backup
  reader, or stolen server-side data set learning plaintext names, file/folder
  types, parent-child relationships, tree shape, content, thumbnails, or
  preview-session keys.
- Ciphertext or manifest tampering, cross-tree substitution, and corrupted
  chunks, through authenticated encryption and context-bound AAD.
- Lost updates between cooperative clients, through an atomic server-side
  generation compare-and-swap (CAS).
- Cross-account object access, through existing owner-scoped authorization plus
  opaque non-enumerable identifiers.

### Not protected against

- Malicious JavaScript delivered by the trusted application origin, a successful
  XSS while the Vault is unlocked, a malicious browser extension, compromised
  browser/OS, screen capture, or physical access to an unlocked session. The
  application that decrypts the tree can observe it.
- Traffic analysis. The server still observes account identity, authentication,
  IP/session data, ciphertext sizes, object/chunk counts, request timing, access
  patterns, tree revision cadence, and approximate padded manifest size.
- A fully malicious server replaying an old but authentic head to a brand-new
  client with no independent monotonic anchor. CAS prevents cooperative lost
  updates; it is not a transparency log.
- Guaranteed physical erasure from JavaScript-managed memory. Cleanup is
  best-effort lifecycle containment, not a hardware memory-erasure claim.

The design follows the current AES-GCM authenticated-encryption model. GCM AAD
is authenticated but not encrypted, so only opaque coordination values belong
in manifest AAD. IV uniqueness remains mandatory. References:
[NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final),
[Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/), and
[RFC 9106 Argon2](https://www.rfc-editor.org/info/rfc9106/).

## 6. Hard Privacy Invariants

```text
SERVER_KNOWS_PARENT_CHILD=NO
SERVER_KNOWS_FOLDER_TREE=NO
SERVER_KNOWS_PLAINTEXT_NAMES=NO
SERVER_KNOWS_PLAINTEXT_CONTENT=NO
SERVER_PLAINTEXT_MEDIA_CACHE=NO
```

Consequences:

- No plaintext or deterministic hash of a node name, parent ID, breadcrumb,
  path, MIME type, thumbnail, poster, or hierarchy operation enters SQL, object
  metadata, routes, logs, analytics, audit targets, caches, receipts, or Git.
- The server never evaluates cycle rules, sibling-name collisions, folder
  membership, breadcrumbs, Move destinations, or subtree deletion.
- Server-visible IDs are random opaque coordination/object IDs, never a
  plaintext-derived name/path and never an encoded parent reference.
- Audit events may say that an owner performed an opaque tree revision or blob
  operation. They must not include decrypted node names or paths.
- No normal Files media service, Sharp/FFmpeg derivative cache, search index, or
  plaintext PostgreSQL hierarchy may process Vault content.

## 7. Viable Encrypted-Tree Designs

| Criterion | A — encrypted per-node metadata | B — encrypted versioned manifest/tree object |
|---|---|---|
| Shape | One encrypted metadata envelope per node; stable opaque node ID; encrypted parent ID/name/type | One authenticated encrypted snapshot contains root and all nodes; nodes reference opaque immutable blob IDs |
| Server leakage | Server sees per-node object count, individual mutation timing/sizes, and which encrypted node record changed; not the decrypted parent | Server sees manifest revision timing and padded snapshot size; not node count exactly, parent references, or which node changed |
| Rename/Move | Cheap one-node write, but a consistent parent index, sibling uniqueness, subtree validation, and multi-record transaction are difficult without leaking structure | One new encrypted snapshot plus one CAS; Rename/Move and all affected indexes become one atomic client-visible revision |
| Concurrency | Per-node CAS permits disjoint edits but makes ancestor moves, delete-vs-child-create, and cycle validation distributed | Coarse tree-level CAS creates more conflicts but makes conflict detection and stale-client prevention explicit and deterministic |
| Multi-device merge | Requires encrypted directory indexes or downloading/decrypting all nodes; partial updates can create unreachable/orphaned nodes | Fetch/decrypt latest snapshot, rebase one semantic intent, revalidate the complete graph, then retry CAS |
| Recovery | Must reconstruct a consistent graph from many independently versioned records | Prior immutable encrypted manifests are self-contained recovery points |
| Mutation cost | O(changed nodes), plus index/consistency machinery | O(tree size) encrypt/upload per mutation; requires bounded tree/manifest size and padding policy |
| Complexity | Higher protocol and repair complexity despite smaller writes | Simpler correctness model; higher bandwidth/CPU for large trees |

### Decision

Use **B**. Private Vault hierarchy sizes must be bounded and measured during
implementation planning, but correctness and privacy take priority over
premature incremental-tree optimization. Per-node/sharded manifests require a
new reviewed design if real measurements later prove a single manifest
unacceptable. That future optimization is not transfer-performance work and may
not weaken the invariants above.

## 8. Identity and Root Representation

There are three distinct identities:

1. **Server blob ID** — existing owner-scoped opaque V1/V2 content identifier.
   It locates immutable ciphertext and is not a logical node ID.
2. **Node ID** — client-generated 128-bit-or-stronger random identifier stored
   only inside the encrypted manifest. It remains stable across Rename, Move,
   Trash, and Restore. It is never derived from name, path, content, or parent.
3. **Revision ID** — client-generated random opaque coordination identifier in
   clear server metadata and AAD. It identifies one encrypted manifest revision
   but reveals no tree semantics.

The manifest contains a random `treeId`, a random `rootNodeId`, and one synthetic
root folder node whose `parentNodeId` is null. The root is not a server row or
filesystem path, cannot be renamed/moved/trashed, and is never displayed as a
normal child. Breadcrumbs are constructed by walking encrypted node relations
from the current node to that root in client memory.

Stable random node IDs do not need a second inner encryption layer: the entire
manifest containing them is already authenticated ciphertext. They must not
appear in server URLs, telemetry, or logs.

## 9. Encrypted Manifest Data Model

The conceptual plaintext, present only in unlocked client memory, is:

```text
VaultTreeManifestV1
  schemaVersion
  treeId
  generation
  revisionId
  baseRevisionId
  rootNodeId
  createdAtClient
  nodes: Map<NodeId, Node>
  recentOperationIds: bounded set

Node
  nodeId
  kind: folder | file
  parentNodeId
  name
  createdAtClient
  modifiedAtClient
  lifecycle:
    state: active | trashed | purge-pending
    trashedAtClient?
    trashedFromParentNodeId?
  file fields only:
    blobId
    blobFormatVersion: 1 | 2
    mediaType
    plainSize
```

All fields after decryption are untrusted input and must pass full schema and
graph validation before rendering or mutation. The implementation must use one
versioned deterministic serialization contract; canonical JSON UTF-8 with an
explicit canonicalizer is the initial choice. Object key ordering, integer
bounds, Unicode handling, maximum depth, node count, name bytes, total decoded
bytes, and duplicate keys must be fixed and tested. Native `JSON.stringify`
ordering alone is not the protocol definition.

The plaintext manifest is padded before encryption into versioned size buckets
to reduce exact node-count leakage. Padding is authenticated and stripped only
after successful decryption. Maximum ciphertext and decoded-tree limits are
mandatory denial gates; exact measured values belong in the implementation plan
and may not be silently raised in Production.

## 10. Crypto Boundaries and Key Wrapping

- Existing Argon2id setup/unlock continues to produce the in-memory,
  non-extractable Vault KEK. Argon2 parameters are not changed by this task.
- Existing V1/V2 file blobs retain their current random per-file DEKs and
  authenticated ciphertext. Rename/Move never re-encrypts file bytes.
- Every manifest revision gets a fresh random 256-bit Manifest DEK and random
  96-bit AES-GCM IV. The Manifest DEK is wrapped under the current Vault KEK
  using a fresh wrap IV.
- Manifest AAD contains only clear opaque protocol context: protocol label,
  schema version, `treeId`, `revisionId`, `baseRevisionId`, and generation.
  Substitution into a different tree, generation, or revision must fail
  authentication. Parent IDs, names, node types, counts, and content metadata
  are never AAD.
- New helper contracts must support contextual AAD; do not reuse an existing
  helper in a way that silently omits that context.
- Decryption authenticates the complete ciphertext before the tree becomes
  active. Any tag, schema, graph, or bounds failure is fail-closed and does not
  partially render nodes.
- Passphrase rotation re-wraps the current manifest DEK and file DEKs without
  rewriting file ciphertext. Exact safe rotation is a later implementation-plan
  gate, not permission to change credentials now.

No manifest plaintext, Tree/Manifest DEK bytes, KEK, decrypted thumbnail, or
preview key may enter localStorage, sessionStorage, IndexedDB, Cache API,
filesystem, server cache, logs, error reporting, or analytics.

## 11. Server-Side Opaque Coordination Model

The future server adds only opaque revision storage and CAS coordination:

- An owner-scoped **tree head**: opaque `treeId`, current `revisionId`, and
  monotonic generation.
- Immutable **encrypted manifest revisions**: revision/base IDs, generation,
  ciphertext size/storage key, IV, wrapped Manifest DEK, wrap IV, and ciphertext.
- A protocol-mode/minimum-client marker so a hierarchy-enabled Vault rejects
  legacy destructive mutation instead of letting an old client flatten or delete
  tree-managed data.
- Idempotency keys and bounded orphan-revision cleanup. Idempotency values are
  random and convey no node semantics.

The manifest ciphertext is published to an immutable storage key before the DB
transaction. One DB transaction inserts its opaque revision row and updates the
head only when `current_generation == expected_generation` and
`current_revision_id == expected_revision_id`. A failed CAS never changes the
head; its unreferenced encrypted revision is later garbage-collected. A
successful CAS is the single authoritative commit point.

The server validates authentication, ownership, protocol/version, size bounds,
opaque identifier syntax, idempotency, and CAS preconditions only. It cannot and
must not validate names, parents, node kinds, cycles, subtree contents, or blob
references inside ciphertext.

## 12. Synchronization and Multi-Device Concurrency

Every mutation follows this protocol:

1. Fetch the current head and encrypted manifest revision.
2. Decrypt, parse, bounds-check, and validate the whole graph in memory.
3. Express the requested user action as a semantic in-memory intent referencing
   stable node IDs, not paths.
4. Apply the intent to a copy, revalidate the graph and operation-specific rules,
   serialize canonically, pad, encrypt under a fresh Manifest DEK, and upload.
5. CAS from the exact observed head/generation to the new revision.
6. On CAS conflict, discard the candidate plaintext/ciphertext, fetch/decrypt the
   latest head, and attempt a bounded semantic rebase.

There is no last-writer-wins tree overwrite. Automatic rebase is allowed only
when the exact intent remains unambiguous—for example, Rename of a node that
still exists when neither it nor its sibling collision set changed incompatibly.
Delete-vs-edit, destination deletion, same-node Rename, restore-name collision,
or any graph change that makes intent ambiguous produces a visible conflict and
requires user choice. Retries are bounded to prevent livelock.

No plaintext offline queue is persisted. An unlocked tab may retain one pending
intent in memory; lock, logout, or tab close discards it. A reconnected stale
client must fetch and rebase onto the server head before committing.

## 13. Graph Validation and Cycle Prevention

The client validates at unlock, after every local mutation, and again after each
conflict rebase:

- exactly one root, and its parent is null;
- every non-root node has one existing folder parent;
- every node is reachable from root in active/trash semantics;
- no node is its own ancestor and every ancestor walk has a visited set and
  strict depth bound;
- file nodes have valid owner-inventory blob references and folders do not;
- no duplicate node IDs;
- no active sibling collision under the versioned name-collision algorithm;
- lifecycle state and trash metadata are internally consistent;
- all strings, numbers, timestamps, maps, and total decoded bytes meet limits.

Move preflight rejects the root, moving a folder into itself/any descendant,
missing or non-folder destinations, cross-Vault targets, and a selected set that
would create ambiguity. Bulk selection is normalized to top-level selected
roots: if both an ancestor and descendant are selected, the descendant is not
applied twice.

The sibling collision key is versioned as Unicode NFC followed by Unicode
Default Case Folding using a pinned table. Display names retain original Unicode.
Collisions are rejected, never silently renamed or merged.

## 14. Operation Semantics

### Create folder

Generate a random node ID, validate the name/collision rules, add one folder
node under the active current folder, and CAS one new manifest revision. No
server folder object is created.

### Add/upload file

Use the existing V1/V2-compatible encrypted blob pipeline without throughput
changes. After immutable ciphertext commit, create a file node referencing the
opaque blob ID and CAS the tree. If CAS/rebase cannot attach it, retain it as an
unreferenced recoverable encrypted object; do not silently delete user data.
The unlocked client can compare inventory IDs with manifest references and offer
recovery/import. The server cannot infer why an object is unreferenced.

### Rename

Change only the manifest node name/modified time. Node ID and blob ID remain
stable; file bytes and per-file DEK are untouched. The file envelope's original
encrypted upload name becomes non-authoritative historical envelope metadata.
Tree-aware download/preview uses the current manifest node name/type, while still
authenticating legacy envelope metadata for integrity.

### Move and internal drag/drop

Change only `parentNodeId` for each normalized selected root and CAS one
revision. The client runs destination, collision, and cycle checks before
encryption and repeats them after any rebase. Internal drag/drop invokes the same
Move command path as the Move dialog. External OS drop remains Upload, never
internal Move.

### Delete to Trash

Delete is initially a logical encrypted-tree operation. Set the selected root's
lifecycle to `trashed`, record its encrypted former parent/time, and preserve
its descendants and blob references. Deleting a folder moves the intact subtree
to encrypted Trash in one revision. The server sees only a new opaque revision.

### Restore

Restore to the original active parent when it still exists and has no name
collision. Otherwise require the user to choose an active destination or root.
Restore never guesses across an ambiguous conflict and re-runs cycle validation.

### Permanent deletion

Permanent deletion is a separate explicit, strongly confirmed operation. First
commit a manifest revision marking/removing the subtree and recording encrypted
purge-pending state. Physical deletion of opaque blob IDs occurs only after the
configured retention/grace contract and a fresh unlocked-client confirmation
against the latest head. Older encrypted revisions and rollback guarantees must
not be advertised after their required content is purged. The server learns
which opaque blob IDs are deleted, but not names, paths, parents, or folder tree.

## 15. UI and Interaction Contract

Private Vault remains a separate protected surface. When locked, it shows only
the current opaque locked-state information; no decrypted hierarchy or
stale thumbnails remain.

When unlocked:

- Folder and File are visually distinct, using the Files-page interaction
  language without reusing its server-visible hierarchy API.
- Opening a folder navigates by stable node ID in memory. Breadcrumbs are built
  from the decrypted manifest only.
- Checkbox, Ctrl/Cmd-click, and existing accessible controls toggle selection.
  Selection is cleared or reconciled when navigation/head refresh removes nodes.
- Bulk actions are capability-derived. Initial valid actions are Move and Trash
  for active nodes, Restore/Permanent Delete in Trash, and bounded/sequential
  Download for selected files where the browser supports it. Rename is single
  selection only. Folder archive download is not implied.
- Dragging one selected node drags the normalized selected set; dropping on a
  folder calls the same Move path as the dialog. Invalid/self/descendant targets
  are announced and make no revision.
- Three-dot File actions: Preview when supported, Download, Rename, Move,
  Details, and Move to Trash. Folder actions: Open, Rename, Move, Details, and
  Move to Trash. Trash actions become Restore and Permanent Delete.
- Secure Share, server File History, server Verify, Public Share, and normal
  Files Protected Trash are hidden unless a later cryptographically valid design
  explicitly adds them.
- Conflict, stale head, integrity failure, locked state, unsupported preview,
  and unavailable recovery are distinct truthful states—never synthetic success.

Exact styling may reuse approved components/tokens, but source implementation
requires a later reviewed plan and the repository UI skill workflow.

## 16. Preview and Client-Only Media Derivatives

The normal Files server media pipeline is forbidden for Vault. All derivatives
are ephemeral client products:

- **Small supported images:** decrypt with strict byte and decoded-pixel bounds,
  decode client-side, create a bounded thumbnail/poster in memory, and revoke
  source/derivative Object URLs when the tile leaves its lifecycle or Vault locks.
- **GIF:** a bounded static first-frame poster is the idle tile. Hover or touch
  press may play an ephemeral decrypted animated Object URL only below the
  measured ciphertext/plaintext/memory threshold. Larger GIFs degrade truthfully
  to poster/download; no hidden whole-file buffering.
- **Video:** use the existing same-origin preview Service Worker and V2 chunk
  range decryption. Browser Range requests fetch/decrypt only required chunks,
  with authenticated AAD and one-chunk-bounded plaintext streaming. The client
  may derive a bounded first-frame poster and muted hover/press motion through
  the same ephemeral preview session. V1/unsupported streaming formats receive
  a bounded fallback or a truthful download-only state.

Object URLs are random ephemeral handles, not persistent capability URLs.
Preview tokens and non-extractable DEKs remain in page/worker memory. Responses
remain `no-store`; the implementation must not call Cache API for plaintext.
The Service Worker specification makes Cache Storage explicitly persistent and
script-managed, so absence/cleanup must be tested rather than assumed:
[W3C Service Workers — Caches](https://www.w3.org/TR/service-workers/#caches).

Thumbnail scheduling must cap simultaneous decrypt/decode work, input bytes,
decoded pixels, retained Object URLs, and total estimated memory. Scrolling,
visibility loss, cancellation, integrity failure, navigation, and selection
changes release work promptly. Exact measured limits are implementation-plan
inputs; unbounded `arrayBuffer()`, canvas, ImageBitmap, or video instances fail
the acceptance gate.

## 17. Lock, Logout, and Tab Lifecycle

One idempotent `purgeUnlockedVaultState(reason)` boundary must be used by manual
Lock, idle auto-lock, logout, account/session invalidation, component unmount,
and page lifecycle termination where the browser permits notification. It:

1. aborts manifest/blob/thumbnail/preview fetches and decrypt work;
2. invalidates pending mutation/rebase tokens;
3. removes decrypted manifest, node maps, names, breadcrumbs, selections,
   details, clipboard-like UI state, and pending intents from React/module state;
4. revokes every image/GIF/video/thumbnail Object URL;
5. closes every Service Worker preview token and clears page-held session maps;
6. drops KEK/Manifest DEK/file DEK references and decrypted buffers;
7. renders the locked opaque inventory only after cleanup begins.

`pagehide`/`beforeunload` cleanup is best effort; correctness cannot depend on a
final network request. Tokens are short-lived and server responses are no-store.
After crash/tab death, no application-created plaintext persistence exists, and
worker recovery requires a currently unlocked controlled page to re-supply the
exact active token/key.

## 18. Backward Compatibility and Flat-Vault Migration

Migration is client-side and non-destructive:

1. With no tree head, unlock the current flat Vault and decrypt every V1/V2
   envelope exactly as today.
2. Abort without changes if any required envelope cannot authenticate/decrypt or
   if bounds are exceeded. Never create a partial tree.
3. Generate tree/root/node IDs in memory and create one root-level file node per
   existing blob ID. Existing ciphertext, DEKs, object IDs, and chunks are not
   rewritten.
4. Validate names. Duplicate/casefold-colliding names require explicit client
   resolution before genesis; do not silently rename.
5. Encrypt the genesis manifest and CAS from “head absent” to generation 1. If
   another client wins, discard the candidate and load the winning head.

When a tree head exists, it is authoritative. V1 and V2 content read/decrypt
paths remain supported through their format discriminator, but the server's
protocol-mode gate rejects legacy blob add/delete mutations that bypass the
manifest. Older clients receive an upgrade-required response; they may not
silently flatten, delete, or overwrite tree-managed data.

Inventory objects absent from the manifest are recoverable opaque orphans, not
automatic deletions. The unlocked client may decrypt their legacy envelope and
offer “Recover to Vault”; automatic cleanup is forbidden until a reviewed
retention and ownership-safe recovery contract is proven.

## 19. Crash and Failure Recovery

| Failure point | Required recovery |
|---|---|
| Blob upload fails before commit | Existing resumable/cancel behavior; no node is created |
| Blob commits, tree CAS not attempted/completes unsuccessfully | Blob remains encrypted and recoverable as an unreferenced inventory object |
| Manifest upload fails | Current head unchanged; discard candidate and retry from current head |
| Manifest object publishes, CAS loses | Head unchanged; encrypted orphan revision is GC-eligible after retention |
| CAS succeeds, response is lost | Refetch head by idempotency/revision ID; never repeat the semantic action blindly |
| Client crashes with plaintext in memory | No app plaintext persistence; next unlock starts from server head |
| Current manifest corrupt/authentication fails | Fail closed; retain ciphertext; offer prior encrypted revision recovery only after authentication and owner confirmation |
| Stale client returns | Fetch/decrypt current head and semantic rebase; no direct overwrite |
| Delete/purge interrupted | Latest committed manifest controls visibility; physical purge is delayed/idempotent and never inferred from a failed UI request |

Server recovery tools may inspect opaque revision/object state and restore an
older encrypted head pointer only with explicit owner procedure. They cannot
name nodes or certify that a decrypted tree is semantically correct.

## 20. Metadata Leakage Statement

The server may know:

- authenticated account/owner and request/audit timing;
- total opaque blob/revision counts and ciphertext/chunk sizes;
- V1/V2/protocol/schema format versions;
- tree/revision/base opaque IDs, generation, CAS conflicts, and padded manifest
  length;
- which opaque blob/revision IDs are read, created, or physically deleted;
- network/session/IP and storage-capacity information already required to serve
  ciphertext.

The server must not know or receive:

- plaintext or deterministically hashed names, paths, MIME/media type, extension,
  thumbnails, posters, content, search terms, or clipboard data;
- root/node IDs, parent IDs, child lists, folder counts, depth, breadcrumbs,
  selection sets, Move destinations, cycle results, Trash origin, or restored
  destination;
- preview DEKs/session keys or decrypted byte ranges;
- exact unpadded manifest size or client memory state.

Padding reduces but does not eliminate approximate tree-size leakage. Revision
timing can reveal that “some tree operation” occurred. These limitations must be
stated in product/security documentation; “zero metadata” is not an allowed
claim.

## 21. Test Strategy

Implementation must begin with tests and include:

### Crypto and manifest unit tests

- round-trip/tamper/wrong-key/context-substitution tests for manifest ciphertext,
  wrapped Manifest DEK, AAD, IV freshness, canonical serialization and padding;
- schema/bounds/duplicate-key/Unicode/malformed graph rejection;
- proof that names, parent IDs, MIME, tree nodes, and plaintext never appear in
  serialized server requests, logs, storage rows, or error payloads;
- migration round-trip for V1 and V2 blobs without ciphertext change.

### Property/model tests

- generated Create/Rename/Move/Trash/Restore sequences preserve one root,
  reachability, parent existence, collision policy, and acyclicity;
- arbitrary bulk selections normalize ancestor/descendant overlap;
- moving into self/descendant always rejects before encryption and after rebase;
- manifest decrypt → validate → serialize is deterministic for the protocol
  version.

### API/PostgreSQL/object-store tests

- exact-generation CAS winner/loser races across processes;
- idempotent response-loss retry, immutable revisions, owner isolation, invalid
  identifier/size rejection, orphan revision cleanup, and no legacy mutation in
  tree mode;
- crash points before/after immutable publish and DB transaction;
- audit/log assertions contain only opaque identifiers.

### Multi-device tests

- disjoint rebase, same-node Rename conflict, delete-vs-edit, destination deleted,
  sibling collision, concurrent genesis, restore collision, repeated conflict
  retry bound, stale-after-lock, and offline reconnect;
- no last-writer-wins replacement of a newer tree.

### UI interaction tests

- Folder/File distinction, navigation, client breadcrumbs, Ctrl/Cmd selection,
  bulk capability derivation, menu parity, dialog and drag/drop using one Move
  path, focus/keyboard/accessibility, locked-state redaction, and truthful errors;
- folder subtree Trash/Restore and permanent-delete confirmation;
- selected/decrypted state reconciliation when a new head arrives.

### Preview and lifecycle tests

- bounded image pixels/GIF bytes/workers/Object URLs; poster and hover/press
  transitions; V2 video Range-to-chunk mapping and integrity failure;
- no Cache API/IndexedDB/localStorage/sessionStorage plaintext;
- Object URL, preview token, worker key, buffer, and manifest cleanup on modal
  close, navigation, Lock, auto-lock, logout, unmount, session invalidation,
  cancellation, integrity failure, and page lifecycle events;
- large-file tests prove one-chunk-bounded video plaintext memory and truthful
  unsupported fallbacks without benchmarking upload speed.

Existing Vault and normal Files regression suites must remain green. PostgreSQL
tests must run against a disposable real database; mocked memory-store success
does not prove CAS concurrency.

## 22. Production Acceptance Gates

No Production rollout is authorized by this design. A future approved rollout
must prove, with disposable test data before owner data:

1. Exact deployed source/image/migration identity and additive schema preflight.
2. Two users cannot access each other's heads, manifests, blobs, chunks, or
   revisions, including guessed opaque IDs and error behavior.
3. Database/object/log inspection finds no plaintext name, parent, path, MIME,
   thumbnail, poster, content, or preview key.
4. Two real browser profiles/devices exercise concurrent Rename/Move/Create/
   Trash/Restore with CAS conflicts and no lost update.
5. Deep hierarchy, duplicate/casefold names, bulk selection, drag/drop, cycle
   attempts, stale clients, crash recovery, migration, and rollback-safe read
   behavior match the contract.
6. Existing V1/V2 items preview/download unchanged after migration; no existing
   ciphertext blob is rewritten.
7. Lock/auto-lock/logout/tab lifecycle removes decrypted UI state and revokes
   preview sessions/Object URLs; no plaintext browser storage or server cache is
   created.
8. Supported image/GIF/video preview is bounded and truthful; large V2 video
   Range playback/seek uses client-only authenticated decryption.
9. Retention, Trash/Restore, permanent purge, backup, and recovery have owner-
   approved evidence before destructive purge is enabled.
10. Full affected Vault, Drive, governance, build, security, and Production
    health/regression gates pass at the exact candidate SHA.

Any failure blocks Production mutation. Repository tests alone are not
Production acceptance.

## 23. Rollout and Rollback Strategy

Future rollout is staged and separately authorized:

1. additive opaque revision/head storage and protocol endpoints disabled;
2. disposable local two-client CAS/migration qualification;
3. owner-approved feature flag for selected non-Production Vaults;
4. explicit genesis migration with user confirmation;
5. controlled Production enablement and acceptance evidence;
6. later enablement of destructive permanent purge only after retention/recovery
   acceptance.

Rollback is fail-safe, not a return to the old flat mutating client:

- disable hierarchy mutations and previews while preserving encrypted head,
  revisions, blobs, setup metadata, and keys;
- keep owner-scoped read/export/recovery through a compatible tree-aware client;
- never delete tree tables, manifest ciphertext, blob ciphertext, or migration
  state during rollback;
- do not re-enable legacy flat Delete/Add after tree activation;
- revert application traffic/source through the reviewed deployment mechanism,
  leaving additive data intact for forward recovery.

Once a user creates folders or renames/moves nodes in the encrypted manifest,
the flat UI cannot represent authoritative state. “Rollback to flat mode” is
therefore forbidden as a data-consistency strategy.

## 24. Upload-Performance Deferral

```text
PRIVATE_VAULT_TRANSFER_PERF=SEPARATE_FUTURE_PR
UPLOAD_THROUGHPUT_OPTIMIZATION_INCLUDED=NO
CHUNK_SIZE_TUNING_INCLUDED=NO
TRANSFER_CONCURRENCY_TUNING_INCLUDED=NO
```

This architecture may call the existing encrypted upload/download primitives to
define object-to-node lifecycle, but it does not change or claim improvement to
their throughput, chunk planning, concurrency, memory performance, limits, or
network behavior. The future transfer-performance PR must preserve the hierarchy
privacy/CAS contracts and obtain its own plan, tests, acceptance, and rollout.

## 25. Implementation Planning Gate

Before any source implementation:

1. Human/ChatGPT architecture review accepts this document and its leakage
   statement.
2. A separate implementation plan maps the protocol to exact schema/routes,
   modules, UI components, feature flags, migration order, and TDD tasks.
3. Measured manifest/node/padding/thumbnail/GIF limits and browser compatibility
   are selected from disposable evidence.
4. Security review covers active-XSS limitations, CAS, lifecycle cleanup,
   migration, purge, recovery, and legacy-client fencing.
5. Human Owner explicitly authorizes implementation.

Until then:

```text
IMPLEMENTATION_STATUS=NOT_STARTED
PRODUCTION_MUTATION=NO
DATABASE_MUTATION=NO
SOURCE_CODE_CHANGED=NO
TEST_CODE_CHANGED=NO
FINAL_RECEIPT_CREATED=NO
READY_FOR_REVIEW=NO
DO_NOT_MERGE=TRUE
NEXT_GATE=CHATGPT_REVIEW_PRIVATE_VAULT_ENCRYPTED_HIERARCHY_DESIGN
```
