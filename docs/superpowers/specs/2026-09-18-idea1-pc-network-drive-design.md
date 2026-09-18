# AEGIS IDEA1 — PC Network Drive Design

## 1. Status

**PLANNED / DRAFT / NOT IMPLEMENTED — PLANNING ONLY — DO NOT MERGE.**

Task: `PC-NETWORK-DRIVE-1`; area: IDEA1; owner: Kla (`kla`).
Branch: `feat/idea1-pc-network-drive`; base: `main`.
Repository research basis: `a68e18927ec4288c6a1cc1761cc167546b7d31b9`, fetched 2026-09-18.
PR #150 was observed OPEN / Draft at `7a579d94771cef82b305ddfd3db65cf638b6dff5`.
Its branch is not this document's source basis; its future hierarchy/media-preview
changes require a new source review after merge. This task does not change PR #150.

```text
IMPLEMENTATION_STATUS=PLANNED
IMPLEMENTATION_BLOCKED_BY_PR150_MERGE=TRUE
PRODUCTION_MUTATION_ALLOWED=NO
PRIVATE_VAULT_OVER_SMB=OUT_OF_SCOPE / FORBIDDEN
GOOGLE_DRIVE_EXPORT=SEPARATE_FUTURE_TOPIC
FINAL_RECEIPT_CREATED=NO
READY_FOR_REVIEW=NO
DO_NOT_MERGE=TRUE
```

`READY_FOR_REVIEW=NO` means not ready for final integration/merge; the initial
proposal can be discussed now. Architecture acceptance and implementation
authorization remain pending. No future acceptance contract below has passed.

## 2. Problem Statement

One authenticated AEGIS account should own two independent storage spaces:
existing web-managed **My Files**, and a future per-user **On Your PC** network
drive. My Files and On Your PC are **two separate storage namespaces**. Within
On Your PC, the web location and Windows mapped drive are **two access paths to
the same authoritative per-user filesystem tree**: SAME AUTHORITATIVE STORAGE,
NOT TWO COPIES, NOT LOCAL SYNC. Private Vault remains a third, protected location.

“On Your PC” means AEGIS NAS storage accessible from the user's PC through a
mapped network drive. It does not browse C:/D:, discover local PC disks, copy
arbitrary local folders automatically, or represent an ordinary My Files folder.
No duplicate Windows/web file set or Google-Drive-style bidirectional sync engine
is needed: both access paths operate on the same authoritative storage.
Sharing a filesystem does not synchronize PostgreSQL metadata or authorization.

## 3. User Experience

Users provision Network Drive access and map the generated private SMB path
through Windows Explorer. They choose a free local drive letter such as E: or Z:.
The server never stores or relies on a universal drive letter.
PC A may choose E: and PC B Z: for their mappings; these are client-local choices,
never server-side identity.

The eventual Windows contract includes create, copy, rename, move, delete,
open and direct application save. The web contract includes truthful browsing
of that namespace and, after consistency qualification, compatible mutations.
No UI or mapping action is performed in this task.

## 4. Current AEGIS Storage Architecture

Evidence is repository source at the research basis, not a fresh Production audit.
Line references below are research anchors and must be reverified after PR #150.

| Evidence | Observed contract | Consequence for SMB |
|---|---|---|
| `IDEA1-AEGIS_Drive_LC/server/db/schema.sql:76` | `files` stores name, path, size, SHA-256, vault/verified flags, `uploaded_by`, and trash timestamps; owner FK uses `ON DELETE SET NULL` | Filesystem writes alone create no authoritative application row |
| `IDEA1-AEGIS_Drive_LC/server/db/store.js:72` and `:92` | Row mapping derives `ownerId` from `uploaded_by`; PostgreSQL listing scopes by owner and excludes Vault/trashed rows | A filename, display name or SMB username cannot substitute for web ownership |
| `IDEA1-AEGIS_Drive_LC/server/routes/api.js:357` | Authenticated `/api/files` calls `store.listFiles(req.user.id)` | Existing browser listing is metadata-backed, not a directory scan |
| `IDEA1-AEGIS_Drive_LC/src/screens/Files.jsx:334` | Files screen consumes `/api/files`, with no client fixtures as listing truth | A new storage location needs a distinct, authorized data contract |
| `IDEA1-AEGIS_Drive_LC/server/storage/fileStore.js:26`, `:94`, `:106` | `STORAGE_ROOT` defaults to `/datalake`; normal uploads stream to `uploads/<UUID>.bin`; relative storage keys resolve under that root | Existing filenames/hierarchy are not a browsable per-user SMB tree; lexical containment is not sufficient for a new externally mutable tree |
| `IDEA1-AEGIS_Drive_LC/server/db/store.js:381`, `:460` | Folder creation is an application metadata operation; upload metadata is recorded after bytes exist | Do not equate current folders with physical directories; do not promise PR #150 behavior before merge |
| `IDEA1-AEGIS_Drive_LC/server/routes/api.js:506`, `:556` | Owner checks protect download/delete; Admin has no implicit cross-owner file bypass | Preserve this boundary in PC storage, including errors and metadata |
| `IDEA1-AEGIS_Drive_LC/server/db/store.js:195` | Normal Trash is a soft-delete transaction, retaining bytes/versions and revoking shares | Ordinary SMB unlink does not invoke Protected Trash |
| `IDEA1-AEGIS_Drive_LC/server/storage/vaultStore.js:18`, `:22`; `vaultStaging.js:29` | Vault ciphertext and Vault staging also live under the existing storage root | Never export `/datalake`, its parent, or the existing volume wholesale |
| `IDEA1-AEGIS_Drive_LC/server/db/schema.sql:7`; `server/auth/login.js` | AEGIS user IDs and bcrypt web authentication exist | A bcrypt verifier is not an SMB credential; no web-password reuse/storage |
| `docker-compose.yml:100` | Dev/test Drive has `drive_storage:/datalake`, port 8001 exposed internally, private DB/proxy networks; this is explicitly not the Production Compose definition | It does not establish a Production PC mount, SMB host, share name or public/private 445 policy |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/remote-access/Twingate-Setup.md:23` | Accepted documented resources separately restrict SSH to TCP 22 and Web to TCP 80/443 | Existing Twingate onboarding does not prove an SMB resource exists or permits TCP 445 |

Targeted searches of the Drive server, root Compose and infrastructure knowledge
found no Samba/SMB service contract. This limited negative result is not a claim
that no service exists anywhere in Production. No host access was attempted.

## 5. Target Storage Model

```text
AEGIS account (stable server-side user ID)
├── My Files      existing PostgreSQL-managed namespace
├── On Your PC   separate per-user filesystem-authoritative namespace (proposed)
└── Private Vault existing protected encrypted namespace
```

The On Your PC web provider and the user's Windows SMB mapping address the
**same authoritative per-user tree**, not separately synchronized copies.
My Files remains a separate namespace with its existing metadata contract.

Use a location identifier independently of folder identity. PC paths must never
be interpreted as My Files IDs or storage keys. No automatic import, move,
cross-location sharing or migration is implied. An explicit future copy/import
would need its own authorization, ownership, integrity and failure semantics.
No drag/move may silently cross a storage boundary. Future explicit “Copy to
On Your PC” / “Import to My Files” actions require a separately reviewed new
object/storage-ownership lifecycle.

```text
MY_FILES_TO_PC_MOVE=OUT_OF_SCOPE
PC_TO_MY_FILES_MOVE=OUT_OF_SCOPE
VAULT_TO_PC=FORBIDDEN
```

## 6. Per-User Isolation

**PROPOSED, not deployed:** a dedicated PC storage allocation, separate from the
existing Drive/Vault volume; an isolated root mapped to each immutable AEGIS user
ID. A per-user SMB principal and OS ownership identity are candidate mechanisms,
not a decision to create one Linux user per AEGIS account. Usernames are labels,
not keys.
Allocation records must prevent ID/root/principal reuse after deletion.

Exact Linux paths, Linux-account model, UID/GID strategy, host/container placement
and mount topology are **OPEN DESIGN QUESTION** until post-PR150 implementation
planning and owner-reviewed deployment evidence. No
existing `/opt/...` or `/datalake/...` location is claimed as a PC root.

Proposed root permissions are owner-only directories (0700) and private files
(0600), subject to Samba ACL/Windows application compatibility proof. Parent
directories cannot be enumerated by users. Do not use one forced Unix identity
for all SMB users without an independently qualified per-user OS isolation
boundary; broad shared-group cross-user read/write access is forbidden. The
hard requirement is per-user isolation, not a preselected account mechanism.

SMB share authorization and OS permissions independently restrict each principal
to its own root. Share discovery, guessed share paths and filename errors must
not disclose other users. Guest access is forbidden.

The web location resolves the root exclusively from the authenticated AEGIS ID,
checks provisioning/revocation state, and authorizes every listing/read/mutation.
Client-supplied usernames, absolute roots, UID values or share names cannot choose
another user's storage. Reject symlinks, special files and escaping paths; use
race-resistant root-relative filesystem operations, not just string-prefix checks.

Owner-only OS permissions do not automatically make the current `node` process
able to browse every user's root. A future narrowly scoped broker/impersonation
mechanism must demonstrate per-request isolation without running the whole Drive
application as root. The exact broker/impersonation design remains OPEN DESIGN
QUESTION, not an approved implementation. Its privileged trust boundary is a blocker
until reviewed; a broad mount plus UI filtering is not an acceptable substitute.

Admin may govern provisioning/status but has no implicit data-browsing override.
Any exceptional recovery access needs a separate policy, explicit audit and owner
approval. On disable/delete, deny web PC access, revoke SMB access and active
sessions, quarantine the allocation, and retain data pending an explicit retention
decision. Never automatically assign the old root to a recreated username.
Current general account-disable integration is **NOT PROVEN** by the inspected
schema/routes and must not be claimed as already implemented.

## 7. SMB / Windows Mapping Model

Primary initial client scope: Windows 10/11 using SMB network-drive mapping.
Final host, private DNS name, dialect/configuration, share syntax and Samba
version are **OPEN DESIGN QUESTION**. `\\<approved-private-host>\<generated-user-share>`
is a conceptual placeholder, not a deployed UNC address or an executable command.

Future flow: approved private connectivity → This PC → Map network drive →
choose E:/Z:/another free letter → generated UNC path → distinct Network Drive
credentials. Setup must explain reconnect behavior, disconnect/revoke, Windows
cached sessions and optional—not required—credential persistence. Never include
a password in a command line, script, URL or setup screenshot.

PowerShell/manual mapping instructions are future work against the verified
endpoint and supported Windows build. No mapping commands or mounts are executed.

## 8. Web vs SMB Metadata Consistency Problem

With the current contract, an SMB create has no `files` row, ownership assignment,
checksum, audit transaction or upload commit. External rename/delete can invalidate
an existing row's path, size and checksum. Directly exposing `uploads` would also
show opaque byte keys rather than the application names.

Under option A, PC listings come from the user's actual PC filesystem, not from
`/api/files`. Refresh discovers a completed Windows create/rename/delete without
pretending that an application metadata transaction happened. Any future cache
is derived and rebuildable, with an explicit freshness marker; it is never a
second authoritative files database. Listing is not an atomic filesystem snapshot.

Initial visibility is completed Windows/SMB mutation → web refresh/re-fetch →
read current filesystem state. No background watcher or zero-latency realtime
synchronization is required for initial acceptance.

```text
INITIAL_VISIBILITY_MODEL=REFRESH_BASED
BACKGROUND_SYNC_ENGINE=NOT_REQUIRED
REALTIME_WATCHER=FUTURE_OPTIONAL
```

PC ownership comes from the root/principal mapping, not guessed file attributes.
Web features requiring existing DB IDs must be disabled or separately designed.
This resolves visibility at the architecture level; safe two-writer operations,
stable snapshots and reliable SMB audit attribution still require qualification.

## 9. Architecture Options

| Approach | Fit against actual source | Benefit | Risk / scope cost |
|---|---|---|---|
| A — separate filesystem-authoritative PC storage | Add a separate provider; leave My Files SQL/UUID-key semantics intact | SMB directories are real; refresh reads the same tree; no fragile bidirectional SQL mirror | Different Trash/history/integrity capabilities; a secure web broker and SMB/Web concurrency remain necessary |
| B — filesystem plus metadata reconciler/indexer | Add a separate PC index and lifecycle, not blind insertion into existing `files` | Derived search/metadata may support richer UX | Lost watcher events, partial writes, rename identity, delete tombstones, stale checksums, restart scans and crash recovery; eventual consistency must be visible |
| C — managed SMB/VFS gateway coordinating application metadata | New mutation gateway, locking and recovery protocol around both interfaces | Potentially stronger coordinated invariants | Samba/VFS integration and filesystem/DB failure recovery are substantial; a gateway alone does not create atomic cross-system transactions |

B needs rescan recovery even if watchers are used. Inodes alone are not durable
cross-restart object IDs. C cannot promise strong consistency without testing
crash points and lock behavior. Neither exists in the inspected repository.

## 10. Recommended Architecture

Recommend **A** for Final Project scope: isolated filesystem-authoritative PC
storage, explicit location-specific capabilities, and no automatic incorporation
of SMB files into My Files or Vault. It addresses the current source mismatch
with less lifecycle complexity than B/C. This is a recommendation, not approval.
The web On Your PC location and Windows mapped drive are two access paths to
the **same authoritative storage**, not two copies or local sync; My Files stays
separate. Windows create → web refresh must reveal the same folder/file;
future web create/upload → Windows must reveal that same object in that tree,
without duplicate-copy synchronization.

A staged qualification could first establish SMB read/write plus web listing/read,
then qualify web writes. **A read-only web milestone does not satisfy PCND-5,
PCND-8 or PCND-9 and is not full acceptance.** The requested eventual two-way
contract is retained. Owner approval is required for any reduced delivered scope.
If reliable concurrent mutation cannot be qualified within Final Project scope,
mark those gates BLOCKED rather than weakening them or claiming feature parity.

```text
READ_ONLY_WEB_MILESTONE=LIMITED
FULL_FEATURE_ACCEPTANCE=NOT_SATISFIED
```

These values describe a read-only milestone only. Full feature acceptance still
requires PCND-5 and the qualified PCND-8/9 two-writer consistency gates.

This task creates no implementation plan: architecture acceptance and the
post-PR150 source review must precede an approved executable plan.

## 11. Authentication / Credential Model

**PROPOSED:** a separate Network Drive credential mapped to the same stable AEGIS
user ID. Preserve web bcrypt/session/CSRF behavior. Never derive SMB credentials
from a web verifier or request/store the user's web plaintext password for SMB.

Provisioning should require authenticated, step-up owner authorization; use an
auditable disabled → provisioning → enabled state machine. The UI reports enabled
only after the share/principal/permissions checks succeed. Failed provisioning
stays disabled/error, with compensating cleanup and no other-user reassignment.

SMB authentication material belongs in a protected service credential backend,
not application source, PostgreSQL web-password fields, Git, environment dumps,
Obsidian, logs or receipts. A password may be accepted transiently over the
approved encrypted web path and handed to a narrowly scoped provisioning broker,
but never persisted or passed in process arguments. Protocol verifiers can be
credential-equivalent secrets and require equally strong protection; a generic
bcrypt-only promise is not an SMB implementation design.

Reset/rotation must not reveal the old credential or alter the web credential.
Revoke denies new SMB sessions; account disable/delete additionally terminates
existing connections/open handles according to a tested policy. Reset, revoke
and account operations must reconcile partial backend failures fail-closed.
Exact passdb/identity backend, broker transport, rotation/revoke latency and
integration with AEGIS account lifecycle are **OPEN DESIGN QUESTION**.
See [Samba credential file semantics](https://www.samba.org/samba/docs/current/man-html/smbpasswd.5.html).

## 12. Network Security Boundary

**Hard invariant: SMB is private only; TCP 445 must never be publicly exposed.**
No WAN forwarding, public DNS endpoint, Public Share integration or public tunnel
for SMB. Permit only an approved LAN or separately authorized private overlay
resource. Private connectivity is necessary but does not replace SMB authentication
and per-user authorization. Existing Twingate Web/SSH grants must not be widened
implicitly; any new SMB resource needs owner approval and measured routing evidence.

Propose supported SMB3, mandatory signing/encryption and no guest/SMB1 fallback;
exact interoperability must be verified for the chosen Windows/Samba versions.
Do not solve Windows compatibility by disabling security controls. DNS resolution,
interface binding, host/container forwarding, firewall and reboot behavior remain
NOT TESTED. No configuration or port changes are authorized by this document.
See [Samba share/security parameters](https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html)
and [Microsoft SMB security hardening](https://learn.microsoft.com/en-us/windows-server/storage/file-server/smb-security-hardening).

## 13. Data Lifecycle

| Operation | Proposed PC contract | Qualification / limitation |
|---|---|---|
| Create folder/file | Authenticated SMB changes the user's real tree; refreshed web listing reflects it | Permissions, name collisions, Office save patterns and visibility latency must be tested |
| Web upload/create | Separate PC provider, streamed transfer and staged publish inside the PC allocation | PCND-5 remains BLOCKED until broker, locking, crash recovery and concurrent SMB behavior are reviewed |
| Rename/move within PC | Reflect the actual filesystem operation after refresh; no My Files row to orphan | Qualified case/collision/locking policy required; paths are not permanent object identity |
| Move between locations/users | No implicit operation or ownership conversion | OUT OF SCOPE; a future explicit import/copy design is separate |
| SMB delete from Windows | Actual SMB/filesystem delete behavior must be measured | Do not assume Windows Recycle Bin, server recycle or My Files Protected Trash |
| Web Delete within On Your PC | OPEN DESIGN QUESTION: permanent delete with strong warning, separate PC recycle/trash, or limited/no web delete initially | Owner must approve the chosen semantics before destructive web delete is enabled; no automatic Protected Trash reuse |
| Recovery | Preserve PC data independently; rebuild optional derived metadata from filesystem | Backup/restore and account mapping recovery must be designed and tested; no inherited backup coverage claim |

SMB deletion is not guaranteed to reach Windows Recycle Bin. A server recycle
feature, if wanted, is a separately reviewed addition, not an assumed My Files
Trash integration. Delete confirmation/retention differences must be visible.
The owner has not approved final deletion semantics. This decision is an
acceptance gate, not a preselected permanent-delete policy.

```text
PC_STORAGE_DELETE_SEMANTICS=OPEN_DESIGN_QUESTION
```

## 14. Concurrency and Consistency

The filesystem is authoritative; there is no SQL mirror to reconcile in A.
Concurrent directory listings may observe change between entries. Document refresh
semantics and report unavailable/stale states honestly rather than inventing rows.

Independent application filesystem writes do not automatically participate in Samba
share-mode locks, leases or desktop save patterns. An application mutex coordinates
only web requests, not SMB. Do not approve naive simultaneous `fs` overwrite/rename.

**OPEN DESIGN QUESTION / implementation blocker:** qualify a shared locking or
SMB-aware mutation mechanism, conflict response, atomic publish, incomplete-transfer
cleanup and recovery. Pick deterministic conflict semantics before web writes are
enabled; do not promise last-writer-wins or transactional consistency by assumption.
Office replace-on-save, open handles, delete-while-open and concurrent refresh/read
need actual Windows/Samba tests. A safe read-only web milestone still requires
truthful behavior during SMB partial writes and interrupted reads.

## 15. Audit / Integrity / Checksum Considerations

Existing web audit records do not capture external SMB mutations. Separate web
operation events from SMB service events and from scanner observations; a rescan
can observe a change but cannot prove its actor. Map service principals to stable
AEGIS IDs without claiming that an IP address proves the user.

Event coverage, durable collection, secret/path minimization, retention and recovery
are **OPEN DESIGN QUESTION**. Record provisioning/reset/revoke and denied access;
do not log credentials, full sensitive filenames or other users' share paths.

An observed file has NOT VERIFIED integrity by default. Hash only a demonstrably
stable snapshot/version; changing size/mtime is not sufficient proof that no writes
occurred. Hash results describe measured bytes at a time, not future mutable content.
Do not reuse My Files `verified=true` or promise version history, Public Share,
Protected Trash or backup coverage for PC files. Streaming and bounded-memory
verification are required; large-file size limits are a future measured contract.

## 16. Windows Compatibility Concerns

| Concern | Draft rule / open gate |
|---|---|
| Filenames/collisions | Reject escaping paths, NUL/control characters and Windows-incompatible/reserved names; define length, trailing dot/space, Unicode normalization and casefold collision rules across both interfaces before write approval |
| Case-sensitive Linux vs Windows | Never permit ambiguous case-only duplicates; Samba and web validation must be qualified together, not assumed identical |
| Symlinks/hardlinks/special files | Symlinks and special files forbidden; prevent escaping/reparse traversal and cross-root hardlink aliasing; OS/mount/broker enforcement must be tested |
| ADS / NTFS metadata / ACL editing | Not promised; choose explicit reject/ignore behavior and test safe desktop interoperability; never pretend unsupported metadata was preserved |
| Hidden files / Office temporary files | Remain real files; owner-approved filtering must not affect authorization or silently lose data; Office temp/save behavior must work |
| Partial/interrupted writes | May be visible while SMB writes occur; no complete/verified label until a qualified completion/snapshot contract exists |
| Quota | Separate per-user PC allocation; real enforcement must cover SMB and web, not DB upload totals alone; enforcement mechanism remains OPEN DESIGN QUESTION |
| Large files | Stream rather than buffer whole files; qualify bounded memory, free-space failures, interruption and recovery; no size claim from existing upload limits |

Any name normalization must reject collisions rather than silently rename or merge
two users' entries. Existing lexical `resolveKey` is not a ready-made PC path defense.

## 17. Web UX Concept

Within AEGIS Drive/Files, the semantic information architecture is:

```text
Files
├── My Files
├── On Your PC — AEGIS Network Drive
└── Private Vault (protected)
```

On Your PC is a storage location, not an ordinary My Files folder or a separate
application/module. Its web view and Windows mapped drive access the same
authoritative per-user filesystem tree: NOT TWO COPIES / NOT LOCAL SYNC.
The PC location can reuse folder/file visual components
only after it supplies its own truthful authorization/data/capability contracts.

Show “On Your PC — Network Drive,” never label server storage “E:”. Setup may
recommend an available E: while saying the drive letter is configured on this PC.
Disabled, unavailable, stale and read-only states must be distinct. Hide/disable
unsupported features with explanatory limitations, not synthetic success telemetry.
Exact visual placement (sidebar locations, cards or selector), styling,
localization and interaction design remain OPEN and are not implemented. The
semantic owner intent is CLOSED, not evidence of implemented UI:

```text
ON_YOUR_PC_IS_STORAGE_LOCATION=TRUE
ON_YOUR_PC_IS_MY_FILES_FOLDER=FALSE
```

## 18. Settings / Provisioning Concept

Settings → Network Drive: actual provisioning status, generated private UNC path,
mapped network identity, Enable, Set/Reset Password, Revoke and Windows instructions.
Never show the password after setup or another user's mapping.

Network connectivity, service health, provisioned status and mounted-on-this-client
are different facts. The server cannot infer a mapped drive letter or Windows
mount merely because an SMB principal exists. Reauthentication, failure handling,
cached Windows sessions and revocation warnings are future design gates.

## 19. Explicit Non-Goals

- Application/UI/authentication implementation in this Draft commit.
- Samba installation, Linux users/passwords, shares, storage provisioning or mounts.
- Database migrations, changes to `files`, tests, Docker/runtime/network changes.
- Internet-exposed SMB or TCP 445; Public Share changes.
- Vault plaintext **or ciphertext** over the PC SMB share.
- Google Drive/OAuth/API integration (`GOOGLE_DRIVE_EXPORT=SEPARATE_FUTURE_TOPIC`).
- macOS/Linux initial acceptance; these are FUTURE / NOT IN INITIAL ACCEPTANCE.
- Automatic local-PC sync, arbitrary local-drive discovery, My Files migration.
- PR #150 modifications, final receipt, Ready transition or merge.

## 20. Dependency / Rollout Plan

Planning exists now from current `main`. Implementation is blocked until all of:

1. PR #150 merges; verify its merge and reconcile this branch with resulting current `origin/main` through the normal repository workflow, not an unmerged implementation stack.
2. Re-review changed hierarchy/media-preview/storage/authentication contracts against the resulting source.
3. Human architecture/security review accepts the namespace, capabilities, data loss/Trash, credential, isolation and concurrency decisions.
4. An implementation plan and mandatory qualification gates are approved.
5. Human Owner explicitly authorizes implementation; any later Production action needs its own scoped authorization.

Future rollout should qualify disposable local storage and two-user Windows behavior
before owner-run private-network/Production evidence. Public reachability checks
require a separately approved targeted procedure; none are run now. Future rollback
must disable new PC access/terminate sessions without deleting PC data or disturbing
My Files, Vault, Public Share, DB, HUB or existing Twingate resources. Exact rollout,
backup and rollback commands remain OPEN DESIGN QUESTION, not invented here.

### 20.1 Future Execution Phase Map

This is a planning sequence, **not an executable implementation plan or
authorization**. All phases remain future; the dependency and owner gates above
apply before implementation, and Production rollout requires separate approval.

| Phase | Future scope / gate |
|---|---|
| 0 — Post-PR150 reconciliation | PR #150 merged; fetch/reconcile current main; re-read actual Files hierarchy/storage/auth source; human architecture review and approved implementation plan |
| 1 — Disposable SMB foundation | Isolated non-Production environment; dedicated PC root model; two disposable users; per-user SMB isolation and Windows 10/11 mapping; no Web PC provider or Production action |
| 2 — Web read provider | On Your PC storage location; authorized filesystem listing, folder navigation and download/read; refresh-based Windows → web visibility; read-only milestone LIMITED, not full acceptance |
| 3 — Qualified two-way mutation | Web upload/create, within-PC rename/move and owner-approved chosen delete behavior; SMB/Web locking/conflicts, atomic publish and interrupted-write recovery; web → Windows same-object visibility; PCND-5/8/9 qualification mandatory |
| 4 — Private network / Production rollout | Separately authorized LAN/Twingate SMB resource and Production storage provisioning; no public TCP 445; Windows acceptance, isolation/security and backup/recovery evidence |
| 5 — Closeout | Documentation reconciliation, exactly one final task receipt, verified Ready transition, human review and human merge; none authorized by this planning pass |

## 21. Acceptance Criteria for Future Implementation

All contracts are **PLANNED**, not implemented tests or runtime evidence.

| ID | Future acceptance contract |
|---|---|
| PCND-1 | User can enable only their own Network Drive; failed provisioning stays fail-closed |
| PCND-2 | Windows 10/11 maps its per-user share over the approved private path with a locally chosen drive letter |
| PCND-3 | User A cannot access User B's root through SMB, including guessed paths, discovery and filesystem aliases |
| PCND-4 | Completed Windows folder/file creation is visible as the same object in the same authoritative tree after web refresh/re-fetch; no duplicate-copy synchronization |
| PCND-5 | PC web upload/create is visible as the same object in that authoritative tree through Windows; read-only web qualification alone does not pass this gate |
| PCND-6 | My Files stays isolated and its existing authorization/storage behavior regresses neither logically nor physically |
| PCND-7 | Vault plaintext, ciphertext and staging cannot be reached over SMB |
| PCND-8 | Rename/move produces consistent web/SMB visibility without stale authoritative metadata/orphans; collision and delete behavior are qualified; owner approval of chosen semantics precedes destructive web delete |
| PCND-9 | Concurrent web/SMB mutation follows a qualified deterministic locking/conflict policy, including desktop replace-on-save |
| PCND-10 | Credential revocation prevents new SMB access; disable/delete and active-session termination are separately proven |
| PCND-11 | SMB is unreachable over public IPv4/IPv6 paths; only explicitly approved private paths work |
| PCND-12 | Restart/crash/recovery preserves data, root/principal mapping, isolation and any derived metadata consistency |
| PCND-13 | Large transfers use bounded memory and stream; interruption, quota and no-space behavior are truthful |
| PCND-14 | Web/SMB/scan audit coverage and checksum limitations match actual evidence, without secret disclosure |
| PCND-15 | No cross-user disclosure in web responses, errors, search, preview/download, setup, status, audit or SMB discovery |

Future tests must use disposable data and dedicated credentials, not real Vault,
share tokens or other users' files. No test implementation is included now.

## 22. Security Review Checklist

- [ ] Separate PC allocation and per-user OS/SMB/Web mapping reviewed; no broad shared identity.
- [ ] Web broker privilege and race-resistant traversal/alias defenses qualified.
- [ ] My Files/Vault/staging physically excluded; Admin governance does not imply data override.
- [ ] Distinct credential backend, transient secret handling, revoke/disable/delete and active sessions qualified.
- [ ] Private-only TCP 445, DNS, bindings, overlay resource authorization and IPv4/IPv6 controls verified.
- [ ] Chosen Samba/Windows versions, signing/encryption and no guest/SMB1 fallback verified.
- [ ] Filename/case/Unicode/ADS/ACL behavior and Office saves qualified.
- [ ] Partial writes, concurrent reads/mutations, crash recovery and quota qualified; owner approves chosen delete semantics before destructive web delete is enabled.
- [ ] Audit attribution, stable-snapshot hashing, backup and limitations truthfully evidenced.
- [ ] Post-PR150 regression, functional owner and integration review complete before implementation/rollout.

## 23. Open Design Questions

Each item is an **OPEN DESIGN QUESTION**, not an implicit implementation choice:

1. Exact PC allocation/root paths, Linux-account model, host/container placement, UID/GID strategy and per-request web broker; none precommitted before post-PR150 planning.
2. Samba version, private host/DNS/share syntax, dialect/encryption/signing compatibility and approved LAN/overlay resource.
3. SMB credential backend and secure provisioning transport, failure compensation, account-disable integration and active-session revocation latency.
4. SMB-aware web locking/publish/conflict mechanism, Office save patterns, stable reads and crash cleanup.
5. Web delete: permanent with strong warning, separate PC recycle/trash, or limited/no web delete initially; owner decision required. Measured SMB delete behavior, retention/restore, quarantine and deleted-account data lifecycle remain open.
6. Cross-interface case/Unicode/collision/length rules, ADS/NTFS metadata/ACL behavior and hidden/temp files.
7. Real SMB+web quota enforcement, accepted large-file limits, backup coverage and recovery objectives.
8. Audit coverage/attribution/retention and stable-snapshot checksum semantics.
9. Post-PR150 component reuse and whether the owner accepts any staged read-only web milestone; all two-way criteria remain required unless explicitly revised.

## 24. Current Status Matrix

| Surface | State | Evidence / limitation |
|---|---|---|
| Repository storage/ownership research | LIMITED | Targeted source only at the recorded main; no Production discovery |
| Architecture proposal | PLANNED | A/B/C compared; A recommended; owner acceptance pending |
| Initial Draft documentation session | PLANNED | Diff/secret/vault/policy results are recorded in PR publication evidence, not fabricated here |
| PR #150 dependency | BLOCKED | OPEN / Draft when inspected; must merge before implementation |
| SMB service / credentials / PC storage | NOT TESTED | Not created or provisioned |
| Web PC provider / UI / two-way writes | NOT TESTED | No application code or tests changed |
| Per-user isolation / concurrency / recovery | NOT PROVEN | Future qualification gates |
| Private network / public exclusion | NOT PROVEN | Existing Web/SSH documentation is not fresh SMB evidence |
| Windows mapping acceptance | NOT TESTED | No client mounts or mapping operations |
| Production readiness / final review | BLOCKED | Architecture, source reconciliation, plan, implementation and owner gates pending |
| Final receipt / Ready / merge | BLOCKED | Task remains Draft/in progress; no final receipt or merge authorized |
| SAME_AUTHORITATIVE_PC_STORAGE | PLANNED | One per-user authoritative PC filesystem tree, not two copies |
| WEB_AND_SMB_TWO_ACCESS_PATHS | PLANNED | Web On Your PC and Windows mapping address that same tree |
| MY_FILES_PC_STORAGE_SEPARATION | PLANNED | Separate namespaces; no implicit cross-location moves |
| WINDOWS_TO_WEB_VISIBILITY | PLANNED | Completed SMB mutation → refresh/re-fetch → current tree |
| WEB_TO_WINDOWS_VISIBILITY | PLANNED | Qualified web create/upload → same object through Windows |
| INITIAL_REFRESH_BASED_VISIBILITY | PLANNED | Watcher/background sync not required for initial scope |
| REALTIME_SYNC | CLOSED | OUT_OF_SCOPE_INITIAL; realtime watcher FUTURE_OPTIONAL, not runtime PASS |
| PC_STORAGE_DELETE_SEMANTICS | PLANNED | OPEN / OPEN_DESIGN_QUESTION; owner decision before destructive web delete |
| PRIVATE_VAULT_OVER_SMB | CLOSED | FORBIDDEN hard requirement; exclusion not yet proven at runtime |
| PUBLIC_SMB | CLOSED | FORBIDDEN hard requirement; public exclusion not yet proven at runtime |
| IMPLEMENTATION | BLOCKED | BLOCKED_BY_PR150; human review, approved plan and authorization also required |

Canonical session tracking is limited to the future-task entry in
`Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`, as required by the
development-session workflow. No current implemented/deployed architecture facts
are promoted. Broader canonical architecture/MOC reconciliation is **DOCS_DEBT**
after owner acceptance; final receipt remains pending final task closeout.
