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
SERVER_RECEIVES_EXPLICIT_PARENT_CHILD=NO
SERVER_RECEIVES_EXPLICIT_FOLDER_TREE=NO
SERVER_KNOWS_PLAINTEXT_NAMES=NO
SERVER_KNOWS_PLAINTEXT_CONTENT=NO
SERVER_PLAINTEXT_MEDIA_CACHE=NO
TREE_ROOT_KEY_MODEL=STABLE_RANDOM_TRK
PROTOCOL_STATES=FLAT|MIGRATING_TREE_V1|TREE_V1
TREE_AWARE_UPLOAD_MODEL=VERSIONED_NEW_ENDPOINTS
TRAFFIC_ANALYSIS_INFERENCE_ACKNOWLEDGED=YES
TREE_REVISION_CONCURRENCY=GENERATION_CAS
EXISTING_V1_V2_CIPHERTEXT_COMPATIBILITY=PRESERVED
PRIVATE_VAULT_TRANSFER_PERF=DEFERRED_TO_SEPARATE_PR
```

## 2. Goals

1. Add real encrypted folders and arbitrary nested hierarchy without explicitly
   disclosing parent-child relationships or folder structure to the server.
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
  reader, or stolen server-side data set receiving plaintext names, file/folder
  types, explicit parent-child fields, explicit tree shape, content, thumbnails,
  or preview-session keys through the designed protocol or stored data.
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
  Correlation of those observations can support probabilistic relationship or
  activity inference even though the protocol sends no explicit hierarchy.
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
SERVER_RECEIVES_EXPLICIT_PARENT_CHILD=NO
SERVER_RECEIVES_EXPLICIT_FOLDER_TREE=NO
SERVER_KNOWS_PLAINTEXT_NAMES=NO
SERVER_KNOWS_PLAINTEXT_CONTENT=NO
SERVER_PLAINTEXT_MEDIA_CACHE=NO
```

The `SERVER_KNOWS_*` values are product invariants implemented as a precise
**protocol-disclosure boundary**: no protocol field or stored plaintext carries
parent IDs, child lists, paths, node names, or folder structure. They are not a
claim that traffic analysis is impossible. Timing, access, object-count, and
ciphertext-size correlations may permit probabilistic inference; that inference
is outside the protected threat model and must be acknowledged in product copy.
“Zero metadata” is not an allowed claim.

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

Lifecycle has both a stored state and a derived effective state. A node is
`EFFECTIVELY_TRASHED` when its own lifecycle is `trashed`/`purge-pending` **or**
any ancestor has either state. Descendants do not need O(subtree) lifecycle
rewrites when a folder is trashed; their physical parent links remain intact.

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
- Genesis generates one stable random 256-bit **Tree Root Key / Tree Wrapping
  Key (TRK)**. Plaintext TRK bytes exist only transiently in the unlocked client,
  are imported as a non-extractable AES-GCM key, and are zeroed best-effort after
  import/wrapping. The TRK is never sent to or stored by the server in plaintext.
- The Vault KEK wraps the stable TRK. The server stores two independently
  authenticated wrapped-TRK slots (`primary` and `recovery`) with different
  random IVs; both decrypt to the same TRK and use slot-specific AAD. The second
  slot is corruption redundancy, not an escrow key or a second trust principal.
- Every immutable manifest revision still gets a fresh random 256-bit Manifest
  DEK and fresh random 96-bit AES-GCM IV. Its Manifest DEK is wrapped by the
  stable TRK with a fresh wrap IV—**never directly by the password-derived KEK**.
- Passphrase rotation first unwraps and validates the TRK in the unlocked client,
  derives the new Vault KEK, creates new primary/recovery wrapped-TRK slots, and
  atomically CAS-replaces only the wrapped-TRK envelope. Historical manifest
  ciphertext and wrapped Manifest DEKs remain byte-for-byte immutable and remain
  decryptable through the same TRK.
- Existing V1/V2 per-file DEK wrapping/rotation remains a separate current-file
  concern. This tree design does not silently move those DEKs under the TRK or
  redefine their rotation protocol.

### AAD domain separation

All AAD is a versioned, canonical, length-prefixed binary encoding—not string
concatenation. The three layers use different fixed protocol labels:

| Layer | Protocol label and authenticated clear context |
|---|---|
| Wrapped TRK | `AEGIS-Vault-Tree-TRK-Wrap-v1`; owner-scoped opaque Vault ID, `treeId`, tree protocol version, key-envelope version, and slot (`primary` or `recovery`) |
| Wrapped Manifest DEK | `AEGIS-Vault-Tree-Manifest-DEK-Wrap-v1`; `treeId`, `revisionId`, `baseRevisionId`, generation, and manifest schema version |
| Manifest ciphertext | `AEGIS-Vault-Tree-Manifest-Ciphertext-v1`; `treeId`, `revisionId`, `baseRevisionId`, generation, manifest schema version, and padded plaintext length |

The layer label is mandatory even when fields overlap. An IV is fresh per
encryption under a given key, and an envelope from one layer/slot/tree/revision
must fail authentication in every other context. Parent IDs, names, node types,
counts, and content metadata are never AAD.

### Wrapped-TRK corruption and recovery

On unlock, the client authenticates both wrapped-TRK slots and verifies that any
successfully decrypted values are identical before activating the tree. If one
slot fails and the other succeeds, the Vault may open in a prominent degraded
recovery state; mutation is blocked until the bad slot is rewrapped from the
validated TRK under the current KEK and the key-envelope CAS succeeds. If both
slots fail authentication, or valid slots decrypt to different TRKs, unlock
fails closed. Recovery is limited to restoring an authenticated prior copy of
the wrapped-TRK envelope from owner-approved server backup and retrying with the
corresponding passphrase. The server cannot reconstruct the TRK. Without one
valid wrapped TRK or an explicitly designed future owner recovery mechanism,
historical manifests and their hierarchy are cryptographically unrecoverable.

- Manifest substitution into a different tree, generation, or revision must
  fail authentication.
- New helper contracts must support contextual AAD; do not reuse an existing
  helper in a way that silently omits that context.
- Decryption authenticates the complete ciphertext before the tree becomes
  active. Any tag, schema, graph, or bounds failure is fail-closed and does not
  partially render nodes.
- Exact atomic key-envelope rotation and backup mechanics are later
  implementation-plan gates, not permission to change credentials now.

No manifest plaintext, Tree/Manifest DEK bytes, KEK, decrypted thumbnail, or
preview key may enter localStorage, sessionStorage, IndexedDB, Cache API,
filesystem, server cache, logs, error reporting, or analytics.

## 11. Server-Side Opaque Coordination Model

The future server adds only opaque revision storage, protocol-state gates, and
CAS coordination:

- An owner-scoped **tree head**: opaque `treeId`, current `revisionId`, and
  monotonic generation.
- An owner-scoped **tree key envelope**: key-envelope version plus the two
  opaque wrapped-TRK slots and their IVs. It contains no plaintext key material.
- Immutable **encrypted manifest revisions**: revision/base IDs, generation,
  ciphertext size/storage key, IV, wrapped Manifest DEK, wrap IV, and ciphertext.
- An explicit owner-scoped protocol state: `FLAT`, `MIGRATING_TREE_V1`, or
  `TREE_V1`, with a minimum-client/protocol marker, migration lease epoch/expiry,
  and whether a tree head has ever committed.
- Tree-aware blob lifecycle state (`UNREFERENCED`, `TREE_MANAGED`, and
  `PURGE_PENDING`) over opaque blob IDs only. It contains no name, parent, path,
  or node ID.
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

### Owner-scoped protocol state machine

```text
FLAT
  -- atomic state CAS + migration lease --> MIGRATING_TREE_V1
MIGRATING_TREE_V1
  -- genesis head/key-envelope CAS ------> TREE_V1
MIGRATING_TREE_V1
  -- proven safe abandonment ------------> FLAT
TREE_V1
  -- no reverse transition --------------> (forbidden)
```

The `FLAT → MIGRATING_TREE_V1` transaction acquires a random owner-scoped
migration lease and freezes a stable opaque inventory snapshot/epoch. From that
commit onward, legacy Add/Delete and all tree-aware upload/tree mutation are
rejected. Old clients receive a machine-readable `UPGRADE_REQUIRED` /
`TREE_MIGRATION_IN_PROGRESS` response. Owner-scoped read/download remains
available where the existing cryptographic format is safe; no read may mutate
inventory.

The migration fence survives browser disappearance and lease expiry. Expiry
permits a new tree-aware client to acquire a new lease epoch and resume from the
same mutation-fenced inventory; it does not silently unfreeze legacy mutation.
Takeover requires lease expiry or explicit owner-authorized retry, and stale
lease holders cannot commit genesis. Reversion to `FLAT` is allowed only when
the server proves that no tree head has ever committed, no tree-aware blob/tree
mutation occurred, and the abandoned lease is expired/revoked. Genesis head,
wrapped-TRK envelope, migrated blob-state promotion, and transition to `TREE_V1`
commit atomically. Once `TREE_V1` exists, flat Add/Delete can never be re-enabled.

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

Choose **architectural model A: a new versioned tree-aware endpoint family**.
It reuses the V2-compatible content crypto, chunk planning, staging, commit, and
download internals without throughput changes, but its route/protocol shape is
distinct and the server accepts it only in `TREE_V1`. This creates a hard legacy
client fence; possession of an old flat endpoint shape is not a tree-mutation
capability. `MIGRATING_TREE_V1` blocks both legacy and tree-aware upload.

```text
TREE-AWARE BLOB STAGING
→ encrypted opaque chunk upload (no name/parent/path/node fields)
→ immutable blob commit
→ random opaque blobId returned as UNREFERENCED
→ manifest candidate adds file node/blobId in client memory
→ head CAS includes exact attachBlobIds
→ successful CAS atomically promotes them to TREE_MANAGED
```

The CAS request exposes only newly attached opaque blob IDs, expected head/
generation, revision ID, and random idempotency key. It does not expose a node
ID, name, parent, path, MIME, or position. On CAS conflict, the blob stays
`UNREFERENCED`; a successful semantic rebase may attach that same blob in a later
CAS. If rebase cannot attach it, retain it as a recoverable encrypted orphan—do
not silently delete user data. The unlocked client compares inventory IDs with
manifest references and offers recovery/import. The server cannot infer the
orphan's name or intended hierarchy location.

Legacy raw blob Add and Delete are forbidden in `TREE_V1`. Logical Trash changes
only the encrypted manifest. Physical deletion is available only through the
tree-aware purge-barrier protocol below.

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

A node is **effectively trashed** when its own stored lifecycle is `trashed` or
`purge-pending`, or when any ancestor has either state. Descendants below an
effectively trashed ancestor are excluded from active views and cannot be
independently renamed, moved, selected as Move destinations, or used as Create
targets. Restore operates on the selected trashed subtree root. Purge enumerates
the complete effective subtree in client memory. Graph validation distinguishes
stored node lifecycle from derived effective lifecycle, so Trash remains an
O(1)-node manifest edit rather than rewriting every descendant.

### Restore

Restore to the original active parent when it still exists and has no name
collision. Otherwise require the user to choose an active destination or root.
Restore never guesses across an ambiguous conflict and re-runs cycle validation.
Restoring a subtree root makes descendants active again except descendants that
carry their own stored `trashed`/`purge-pending` lifecycle.

### Permanent deletion

Permanent deletion is a separate explicit, strongly confirmed tree-aware
protocol with a monotonic recovery barrier:

1. A freshly unlocked client fetches and authenticates the exact latest head.
2. It computes the complete effective subtree and commits a manifest revision
   that removes its blob references/records encrypted purge intent.
3. The successful CAS at generation `G` atomically records
   `purgeBarrierGeneration = max(existingBarrier, G)` plus the opaque purge
   candidate IDs. A barrier never decreases.
4. The recovery API/UI immediately retires every revision with generation `< G`;
   those revisions are `NON_RECOVERABLE` even before bytes are deleted.
5. The server waits the configured retention/grace interval. Pre-barrier
   encrypted manifest ciphertext may remain during that interval as forensic
   ciphertext only; it is never selectable for recovery and is deleted when the
   configured forensic retention expires.
6. A fresh unlocked client re-fetches/authenticates the current head and confirms
   the still-pending purge intent. It sends a tree-aware purge request containing
   the exact expected current head/generation, barrier generation, random
   idempotency key, and exact opaque blob IDs.
7. Any stale head/generation, changed purge set, missing ownership, or barrier
   mismatch fails closed. Successful physical deletion is idempotent and marks
   the opaque candidates purged.

After purge, no documentation, UI, API, or rollback tool may advertise or select
pre-barrier revisions as recoverable. Current and newer revisions remain
authoritative. Revision metadata may remain for audit, but pre-barrier manifest
ciphertext itself is retained only until the configured forensic-retention
expiry and is then deleted. The server learns which opaque blob IDs are deleted,
not their names, paths, parents, or folder tree.

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

Migration is client-side, non-destructive, and governed by the owner protocol
state machine in Section 11:

1. While still `FLAT`, a tree-aware client requests the atomic transition to
   `MIGRATING_TREE_V1` and acquires the migration lease. That single CAS freezes
   the exact opaque flat inventory used by this migration attempt.
2. After the transition, all legacy Add/Delete mutations are rejected with
   `TREE_MIGRATION_IN_PROGRESS` or `UPGRADE_REQUIRED`. Tree-aware upload and
   manifest mutation endpoints are also rejected until genesis commits. Safe
   legacy reads/downloads remain available.
3. The lease holder unlocks the frozen flat Vault and decrypts every V1/V2
   envelope exactly as today. It aborts the attempt without publishing a head if
   any required envelope cannot authenticate/decrypt or bounds are exceeded.
   Never create a partial tree.
4. Generate the stable TRK, tree/root/node IDs, and one root-level file node per
   frozen blob ID in client memory. Existing ciphertext, file DEKs, object IDs,
   and chunks are not rewritten.
5. Validate names. Duplicate/casefold-colliding names require explicit client
   resolution before genesis; do not silently rename.
6. Encrypt the genesis manifest and submit the lease ID, frozen inventory
   identity, both wrapped-TRK slots, genesis revision, and generation 1 in one
   atomic CAS. Success publishes the head, promotes the frozen blobs to
   tree-managed objects, and transitions to `TREE_V1` together. Failure leaves
   no authoritative partial tree.

If the lease holder disappears, expiry permits a new tree-aware client to take
over and resume from the same fenced inventory. Lease expiry alone does not
unfreeze flat mutation. Reversion to `FLAT` is permitted only under the narrow
proof in Section 11: no head has ever existed, no tree-aware mutation has
occurred, and the abandoned lease is provably expired or revoked.

Once `TREE_V1` exists, its head is authoritative forever. V1 and V2 content
read/decrypt paths remain supported through their content-format discriminator,
but legacy raw Add/Delete mutations remain forbidden. Older clients receive
`UPGRADE_REQUIRED`; they may not silently flatten, delete, or overwrite
tree-managed data.

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
| One wrapped-TRK slot is corrupt | Fail into degraded read/unlock after the other slot authenticates; block mutation until a CAS repair recreates two independently authenticated slots |
| Both wrapped-TRK slots fail or decrypt to different TRKs | Fail closed; restore a previously authenticated wrapped-TRK envelope with the corresponding owner passphrase, or use a separately approved future recovery method; the server cannot reconstruct the TRK |
| Migration client crashes or its lease expires | Keep the owner in `MIGRATING_TREE_V1`, keep the opaque inventory fenced, and allow a new tree-aware client to take over/resume the lease; do not reopen legacy mutation merely because time elapsed |
| Tree-aware upload publishes a blob but attach CAS loses | Keep the encrypted blob `UNREFERENCED`; expose only its opaque recovery identity so a rebased manifest CAS may attach it later |
| Client crashes with plaintext in memory | No app plaintext persistence; next unlock starts from server head |
| Current manifest corrupt/authentication fails | Fail closed; retain ciphertext; offer an authenticated prior encrypted revision only when its generation is at or above the current purge barrier and owner confirmation succeeds |
| Stale client returns | Fetch/decrypt current head and semantic rebase; no direct overwrite |
| Purge barrier CAS succeeds, response is lost | Refetch and match the exact current head, generation, barrier, idempotency key, and candidate blob IDs before continuing; never infer failure from a lost response |
| Physical purge is interrupted | Latest committed manifest and monotonic purge barrier control recoverability; retry exact candidate deletion idempotently only after retention and a fresh confirmation |

Server recovery tools may inspect opaque revision/object state and restore an
older encrypted head pointer only with explicit owner procedure and only at or
above the monotonic purge barrier. They cannot name nodes, reconstruct the TRK,
or certify that a decrypted tree is semantically correct. Revisions below the
barrier are never selectable recovery points, even while their ciphertext is
temporarily retained for the configured forensic-retention interval.

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

The protocol must not explicitly disclose to, or require the server to receive:

- plaintext or deterministically hashed names, paths, MIME/media type, extension,
  thumbnails, posters, content, search terms, or clipboard data;
- root/node IDs, parent IDs, child lists, folder counts, depth, breadcrumbs,
  selection sets, Move destinations, cycle results, Trash origin, or restored
  destination;
- preview DEKs/session keys or decrypted byte ranges;
- exact unpadded manifest size or client memory state.

Padding reduces but does not eliminate approximate tree-size leakage. Request
timing, revision cadence, ciphertext-size changes, blob access, upload-to-CAS
proximity, and purge-candidate correlation can support probabilistic inferences
about activity or relationships. Such traffic-analysis inference is outside the
protected threat model; the product invariant is that the protocol never sends
explicit names, parent references, child lists, or folder-tree structure.
These limitations must be stated in product/security documentation; “zero
metadata” is not an allowed claim.

## 21. Test Strategy

Implementation must begin with tests and include:

### Crypto and manifest unit tests

- round-trip/tamper/wrong-key/context-substitution tests for both wrapped-TRK
  slots, wrapped Manifest DEK, manifest ciphertext, all three exact
  domain-separated AAD encodings, IV freshness, canonical serialization and
  padding;
- passphrase-rotation tests prove only the wrapped-TRK slots change and every
  retained historical revision remains byte-for-byte immutable and decryptable;
- one-slot corruption, two-slot corruption, slot disagreement, degraded unlock,
  and authenticated repair/restore fail-closed tests;
- schema/bounds/duplicate-key/Unicode/malformed graph rejection;
- proof that names, parent IDs, MIME, tree nodes, and plaintext never appear in
  serialized server requests, logs, storage rows, or error payloads;
- migration round-trip for V1 and V2 blobs without ciphertext change.

### Property/model tests

- generated Create/Rename/Move/Trash/Restore sequences preserve one root,
  reachability, parent existence, collision policy, and acyclicity;
- arbitrary bulk selections normalize ancestor/descendant overlap;
- moving into self/descendant always rejects before encryption and after rebase;
- effective Trash/Purge state follows any trashed/purge-pending ancestor without
  rewriting descendants; subtree-root restore and complete effective-subtree
  purge preserve independently trashed descendants;
- manifest decrypt → validate → serialize is deterministic for the protocol
  version.

### API/PostgreSQL/object-store tests

- exact-generation CAS winner/loser races across processes;
- `FLAT` → `MIGRATING_TREE_V1` → `TREE_V1` state/lease races, frozen-inventory
  takeover, safe-read allowance, genesis atomicity, and the narrowly proven
  pre-genesis `FLAT` reversion path;
- idempotent response-loss retry, immutable revisions, owner isolation, invalid
  identifier/size rejection, orphan revision cleanup, and no legacy Add/Delete
  in either migrating or tree mode;
- versioned tree-aware upload route rejection outside `TREE_V1`, encrypted
  staging/immutable publish, `UNREFERENCED` recovery, atomic attach promotion,
  and proof that server requests contain no name/parent/tree fields;
- monotonic purge-barrier races, exact fresh-client confirmation, stale purge
  rejection, idempotent physical deletion, pre-barrier recovery rejection, and
  forensic-retention expiry deletion;
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
- descendants under an effectively trashed ancestor are hidden, cannot be
  selected or mutated independently, and are reactivated only through the
  subtree-root restore rule;
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
5. A real passphrase rotation rewrites only the wrapped-TRK envelope and proves
   retained historical manifest revisions remain immutable and decryptable;
   one-slot corruption degrades safely and two-slot failure fails closed.
6. Deep hierarchy, duplicate/casefold names, bulk selection, drag/drop, cycle
   attempts, stale clients, crash recovery, effective-subtree Trash/Restore,
   and rollback-safe read behavior match the contract.
7. Migration proves the atomic lease/frozen-inventory fence: legacy Add/Delete
   and tree-aware mutation are rejected throughout `MIGRATING_TREE_V1`, takeover
   resumes without reopening flat mutation, and genesis atomically enters
   `TREE_V1`.
8. Tree-aware uploads use only the versioned endpoint family, leave failed
   attaches recoverable as `UNREFERENCED`, and promote blob references only with
   a successful manifest CAS; raw legacy Add/Delete remain rejected.
9. Purge proves the monotonic generation barrier, immediate pre-barrier
   non-recoverability, retention wait, fresh exact-head confirmation, stale
   fail-closed behavior, idempotent physical deletion, and expiry deletion of
   forensic-only pre-barrier manifest ciphertext.
10. Existing V1/V2 items preview/download unchanged after migration; no existing
   ciphertext blob is rewritten.
11. Lock/auto-lock/logout/tab lifecycle removes decrypted UI state and revokes
   preview sessions/Object URLs; no plaintext browser storage or server cache is
   created.
12. Supported image/GIF/video preview is bounded and truthful; large V2 video
   Range playback/seek uses client-only authenticated decryption.
13. Retention, Trash/Restore, permanent purge, backup, and recovery have owner-
   approved evidence before destructive purge is enabled.
14. Full affected Vault, Drive, governance, build, security, and Production
    health/regression gates pass at the exact candidate SHA.

Any failure blocks Production mutation. Repository tests alone are not
Production acceptance.

## 23. Rollout and Rollback Strategy

Future rollout is staged and separately authorized:

1. additive opaque revision/head storage and protocol endpoints disabled;
2. disposable local two-client CAS/migration qualification, including protocol
   state/lease fencing, tree-aware upload/orphan recovery, TRK rotation, and
   purge-barrier recovery constraints;
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
  state during rollback, except already-authorized forensic-retention expiry or
  an idempotent purge that crossed the accepted barrier before rollback;
- do not re-enable legacy flat Delete/Add after tree activation;
- do not lower a purge barrier or advertise/select a pre-barrier revision;
- if rollback occurs during `MIGRATING_TREE_V1`, preserve the lease/frozen
  inventory fence and either resume genesis or perform only the narrowly proven
  no-head/no-tree-mutation abandoned-lease reversion;
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
