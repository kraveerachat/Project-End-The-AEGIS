---
title: IDEA1 Storage & Persistence Architecture
aliases: ["idea1-storage-persistence-architecture", "Storage & Persistence Architecture"]
tags: [aegis, idea1, storage, persistence, architecture, datalake, backup, lvm, restic]
type: architecture-doc
created: 2026-09-28
updated: 2026-09-28
owner: kla
edit_policy: owner-writable
---

# 💾 IDEA1: Storage & Persistence Architecture

## 1. Executive Summary & Purpose

This canonical architecture document establishes the authoritative storage, persistence, containerization, and backup architecture for **AEGIS Drive LC (IDEA1)**. It provides a formal engineering reference for repository contributors and a rigorous technical baseline for academic and cybersecurity system reports.

### Non-Negotiable Boundaries
- **Documentation Only**: This document records established architecture, verified production preflight facts, and security boundaries.
- **No Infrastructure Mutation**: This document does not execute the planned LVM volume group resize or modify host storage.
- **No Application Modification**: This document does not alter application source code or implement fixes for pending issues.
- **No Production Mutation**: This document does not alter or reconfigure any running production container or service.

---

## 2. Authoritative Physical & Host Storage Topology

### 2.1 Internal Primary Storage
The host system (Beelink mini-PC) operates on an internal solid-state drive (SSD) managed under Ubuntu Logical Volume Manager (LVM):

| Storage Layer | Parameter / Specification | Operational Truth & Governance |
| :--- | :--- | :--- |
| **Physical Disk** | Internal SSD | Approximately 119.2 GiB usable capacity (marketed commercially as 128 GB). |
| **LVM Physical Volume (PV)** | `/dev/sda3` (or equivalent host NVMe/SATA partition) | Approximately 116.2 GiB initialized into LVM. |
| **LVM Volume Group (VG)** | `ubuntu-vg` | Total capacity: approximately 116.19 GiB. |
| **Root Logical Volume (LV)** | `ubuntu-lv` (mapped to `/dev/mapper/ubuntu--vg-ubuntu--lv`) | Current allocated capacity: approximately 58.09 GiB (~50% of available VG). |
| **Unallocated VG Capacity** | Free Extents in `ubuntu-vg` | Approximately 58.09 GiB remaining unallocated in the volume group. |
| **Host Root Filesystem** | `ext4` mounted at `/` | Usable capacity: approximately 57 GiB. |
| **Docker Engine Root** | `/var/lib/docker` | Resides directly on the host `ext4` root filesystem. |

### 2.2 Clarification on Docker Storage Capacity
> [!important] Architectural Invariant: Root LV Allocation vs. Docker Limits
> In production telemetry and reports, Docker storage must **never** be characterized as "limited by design to 57 GB". The container runtime is not artificially constrained by Docker daemon quotas. The root filesystem capacity is approximately 57 GiB solely because the default Ubuntu Server LVM installation allocated only half (~58.09 GiB) of the 116.19 GiB Volume Group (`ubuntu-vg`), preserving the remainder as unallocated extents.

### 2.3 Planned Controlled Expansion
Future host infrastructure maintenance includes an approved, controlled LVM expansion:
- **Target Root LV Allocation**: Approximately 90 GiB.
- **Safety Reserve**: Retains approximately 26 GiB of unallocated extents within `ubuntu-vg` for volume group snapshots, emergency allocations, or maintenance.
- **Execution Boundary**: This expansion is an infrastructure operation performed directly on the host OS; it is **NOT** performed by this documentation task or through the web application.

---

## 3. Containerized Data Lake Architecture

### 3.1 Docker Named Volume Topology
AEGIS Drive utilizes a containerized Data Lake architecture adhering to strict privilege and isolation boundaries:

- **Docker Named Volume**: `aegis_drive_storage` (referenced as `drive_storage` in local testing stacks).
- **Container Mount Target**: Mounted exclusively to `/datalake` within the `drive` container.
- **Host Storage Path**: Resides at `/var/lib/docker/volumes/aegis_drive_storage/_data` on the host root filesystem.
- **Container Isolation**: Neither the Gateway (`nginx`) nor the CCTV Monitor (`monitor`) containers have filesystem mounts to `aegis_drive_storage`.

### 3.2 Observed Storage Snapshot
During read-only production preflight inspection, the Data Lake state was observed as:
- **Total Data Lake Footprint**: Approximately 28.7–29.0 GB.
- **Primary Uploads (`/datalake/uploads`)**: Approximately 25.1 GB.
- **File Versions (`/datalake/versions`)**: Approximately 1.0 MB.
- **Accounting Principle**: These figures represent a concrete observational snapshot and must not be treated as permanent constants.

### 3.3 Logical Storage Classes
The Data Lake segregates stored objects into distinct functional classes:

1. **`uploads/` (Primary User Files)**: Stores active files for normal Drive access. Stored as raw binary objects indexed by cryptographic SHA-256 hashes and UUID-based storage keys.
2. **`versions/` (File Version History)**: Stores prior revisions of modified files. Provides file-level historical rollback and point-in-time recovery.
3. **`vault/` (Private Vault Ciphertext)**: Stores client-side encrypted blobs and encrypted Tree manifests. Raw files are encrypted browser-side using AES-256-GCM with keys derived via Argon2id from user passphrases. The server holds zero keys, zero plaintext, and zero knowledge of vault filenames or contents.
4. **`avatars/` (User Identity Assets)**: Stores user profile images with strict size limits and server-side MIME/header validation.
5. **`staging/` (In-Flight Upload State)**: Dedicated buffer directory for chunked upload assembly, pre-allocation verification, and atomic commit operations. Unfinished staging data is ephemeral and purged upon failure or expiration.

---

## 4. Metadata vs. Data Bytes: Architectural Separation

AEGIS Drive enforces a strict architectural decoupling between **data bytes** and **metadata**:

```
┌────────────────────────────────────────────────────────┐
│                      AEGIS Drive                       │
└───────────┬────────────────────────────────┬───────────┘
            │ Data Streams                   │ Relational Queries
            ▼                                ▼
┌───────────────────────┐        ┌───────────────────────┐
│       Data Lake       │        │  PostgreSQL Database  │
│  aegis_drive_storage  │        │     (aegis_drive)     │
├───────────────────────┤        ├───────────────────────┤
│ • Uploaded Blobs      │        │ • Users & Identity    │
│ • File Versions       │        │ • File Metadata & ACL │
│ • Vault Ciphertext    │        │ • Version References  │
│ • User Avatars        │        │ • Vault Tree Envelopes│
│ • Ephemeral Staging   │        │ • Secure Share Tokens │
│                       │        │ • Tamper-Evident Audit│
└───────────────────────┘        └───────────────────────┘
```

### 4.1 Storage Distribution Principle
- **Raw File Bytes**: Stored **exclusively** within the Data Lake filesystem (`/datalake`). The database never stores raw binary streams or large BLOBs.
- **System Metadata**: Stored **exclusively** within the relational database (`PostgreSQL 15`, database `aegis_drive`).

### 4.2 Logical Metadata Categories (Cybersecurity Report Model)
Without exposing database credentials, schemas, or personal identifying data, the metadata layer governs:
1. **User Identity & Access Control**: User identifiers, role classifications (`admin`, `user`, `datalake`), authentication state, Argon2id password hashes, and rate-limiting lockout state.
2. **File Hierarchy & Attributes**: Logical UUIDs, user-assigned file and folder names, parent folder IDs, logical path structures, MIME types, file sizes in bytes, SHA-256 cryptographic hashes, and ownership bindings.
3. **Version & History Trees**: Parent-child revision linkages, commit timestamps, author IDs, and references to previous storage keys.
4. **Private Vault Envelopes & Tree Revisions**: Opaque blob UUIDs, ciphertext byte sizes, initialization vectors (IVs), salt values, tree manifest storage references, and CAS (Compare-And-Swap) revision state. Plaintext names and encryption keys are strictly absent.
5. **Share Governance**: Ephemeral share tokens, cryptographic token hashes, access policies, CIDR network zone restrictions, expiration timestamps, and download counters.
6. **Audit & Compliance Trail**: Tamper-evident, append-only logs recording event types, actor user IDs, target resources, client IP addresses (via trusted proxy normalization), and operation outcomes.

---

## 5. Trash, Lifecycle, and Physical Byte Reclamation

### 5.1 Conceptual Data Lifecycle
Data objects transition through an explicit, auditable lifecycle:

```
[ Active File ]
       │
       ▼ (User Deletion / Soft Delete)
[ Protected Trash ] ── (30-day retention; metadata marked; bytes preserved)
       │
       ▼ (Empty Trash / Auto-Purge / Hard Delete)
[ Step 1: Byte Reclamation ] ── (Idempotent unlinking of files & version blobs)
       │
       ▼ (Step 2: Database Deletion)
[ Step 2: Metadata Removal ] ── (Transactional hard-delete of database records)
       │
       ▼ (OS / Filesystem Update)
[ Underlying Ext4 Inode Release ]
       │
       ▼ (Telemetry / Monitoring)
[ Statfs & Accounting Refresh ]
```

### 5.2 Strict Operational Boundaries
To preserve system stability and security, three operational boundaries must remain strictly separated:
- **Trash Purge**: An **application-level domain operation** executed within the Node.js/Express backend and PostgreSQL transactions.
- **Storage Capacity Reporting**: A **read-only telemetry concern** querying OS filesystem statistics (`statfs`) and summing categorized metadata rows.
- **Host LVM Expansion**: An **infrastructure/operating system operation** requiring host root administrative access.
- **Security Rule**: These three operations must **never** be conflated into a single privileged API or triggered via web UI endpoints.

### 5.3 Truthful Documentation of Observed Reclamation Issue
During preflight testing, the Human Owner deleted files and emptied the Trash for both Administrator and User accounts. The Storage Dashboard did not show a visible reduction in used storage.

> [!warning] Root Cause Status: NOT YET PROVEN
> The root cause of this observation is **NOT YET PROVEN**. In accordance with AEGIS truthfulness principles, the system does not prematurely claim cache leakage or a broken purge mechanism until controlled, instrumented testing is conducted.

#### Candidate Hypotheses for Future Investigation:
1. **Metadata Deletion Defect**: Database records or retention flags might not have been fully purged, leaving files indexed or partially referenced.
2. **Physical Blob Reclamation Defect**: The physical unlinking mechanism (`removeKey`) may have failed, been bypassed, or skipped orphaned version keys.
3. **Open File Descriptor Retention**: A running process (e.g., thumbnail generator, streaming handle, or media scanner) may be holding open file handles to deleted inodes, preventing `ext4` from releasing the disk blocks until process termination.
4. **Storage Telemetry Semantics**: The dashboard displays filesystem-wide used space from `statfs(/datalake)`. Because `/datalake` resides on the root filesystem `/`, changes in Docker logs, container layers, database WAL files, or system packages can offset file deletion space gains.
5. **UI Presentation & Caching**: The frontend presentation or server report assembly may have cached earlier capacity snapshots or failed to trigger a state update.

---

## 6. External Backup Storage & Failure-Domain Separation

### 6.1 Physical External Backup Target
The AEGIS backup subsystem is anchored on a dedicated physical external storage device:
- **Marketed Capacity**: Approximately 1 TB.
- **Usable Filesystem Capacity**: Approximately 931.5 GiB formatted as `ext4`.
- **Host Mount Location**: Separately mounted on the host OS at `/mnt/aegis-backup`.
- **Device Independence**: Connected via a dedicated external interface, establishing physical hardware isolation from the internal system SSD.

### 6.2 AEGIS Security Boundary
> [!important] External Disk Security & Preservation Invariant
> The external backup disk is a shared hardware device containing pre-existing user data. AEGIS software, scripts, and containers are strictly restricted to the project root:
> `/mnt/aegis-backup/AEGIS_BACKUP/`
> All existing files and partitions outside `/mnt/aegis-backup/AEGIS_BACKUP/` are strictly outside the project boundary. They must **never** be enumerated, read, modified, moved, resized, formatted, or deleted.

### 6.3 Backup Architecture & Restic Repository
The backup system is powered by an automated host-level Backup Agent utilizing `restic`:
- **Repository Location**: `/mnt/aegis-backup/AEGIS_BACKUP/aegis-restic/`.
- **Deduplication & Encryption**: Content-addressed, chunked, client-encrypted snapshots.
- **Protected Datasets**:
  - Full Data Lake file streams (`uploads/`).
  - Historical file revisions (`versions/`).
  - Private Vault encrypted ciphertext blobs and manifests (`vault/`).
  - User avatar images (`avatars/`).
  - PostgreSQL custom-format relational database dumps (`pg_dump` of `aegis_drive`).
- **Excluded Ephemeral Data**: Temporary upload chunks and staging files (`staging/`) are intentionally excluded from backup snapshots to prevent repository bloat from transient transfers.
- **Container Isolation**: Drive containers do not hold restic credentials or mount host backup keys.

---

## 7. RAID Truthfulness & Hardware Reality

```
┌────────────────────────────────────────────────────────┐
│                     CURRENT STATE                      │
│                                                        │
│   ┌─────────────────────┐       ┌──────────────────┐   │
│   │    Internal SSD     │       │ External 1 TB HD │   │
│   │   Primary Storage   │       │  Backup Target   │   │
│   └──────────┬──────────┘       └────────▲─────────┘   │
│              │                           │             │
│              └──── Periodic Backup ──────┘             │
│                     (Restic Agent)                     │
│                                                        │
│            RAID_CURRENT_STATE = NOT_CONFIGURED         │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│               FUTURE PLANNED ARCHITECTURE              │
│                                                        │
│       ┌───────────────────┬───────────────────┐        │
│       │   Primary Disk 1  │   Primary Disk 2  │        │
│       └─────────┬─────────┴─────────┬─────────┘        │
│                 │      RAID 1       │                  │
│                 └─────────┬─────────┘                  │
│                           │                            │
│                 ┌─────────▼─────────┐                  │
│                 │   Mirrored Array  │                  │
│                 └─────────┬─────────┘                  │
│                           │ External Backup            │
│                 ┌─────────▼─────────┐                  │
│                 │ External Backup   │                  │
│                 └───────────────────┘                  │
└────────────────────────────────────────────────────────┘
```

### 7.1 Authoritative RAID Status
- **Current State**: `RAID_CURRENT_STATE=NOT_CONFIGURED`.
- **Physical Reality**: The external 1 TB backup drive is **NOT** a member of a RAID array.
- **System Architecture**: The system implements **Primary Storage + Separate External Backup Target**. It does **NOT** implement RAID1.
- **Constraint Rationale**: Real hardware RAID1 is deferred due to mini-PC form-factor and single internal drive hardware limitations.
- **Roadmap Classification**: RAID is documented exclusively as **FUTURE HARDWARE / FUTURE ARCHITECTURE**.

### 7.2 Academic Distinction: Backup vs. RAID
In cybersecurity and resilience analysis, backup and RAID serve fundamentally different protective roles:
1. **RAID (Redundant Array of Independent Disks)** provides *high availability* against instantaneous hardware drive loss. It does not protect against accidental deletion, ransomware, file corruption, or database corruption, as errors are instantly mirrored across drives.
2. **External Backup** provides *survivability and recovery* across time. It protects against hardware failure, operator error, malware, and container corruption through versioned, isolated, historical snapshots.

---

## 8. Dual Architecture Models

### 8.1 Engineering Architecture View
Detailed topology including logical volumes, Docker mounts, and daemon interfaces:

```
[ Beelink Mini-PC Hardware ]
  │
  ├─ Internal SSD (119.2 GiB Usable)
  │    │
  │    └─ LVM Physical Volume (116.2 GiB)
  │         │
  │         └─ Volume Group: ubuntu-vg (116.19 GiB)
  │              │
  │              ├─ Root Logical Volume: ubuntu-lv (58.09 GiB) ── Target: 90 GiB
  │              │    │
  │              │    └─ Ext4 Filesystem (Mounted at /)
  │              │         │
  │              │         ├─ /var/lib/docker
  │              │         │    │
  │              │         │    └─ Docker Named Volume: aegis_drive_storage
  │              │         │         │
  │              │         │         └─ Container Mount: /datalake
  │              │         │              ├─ /datalake/uploads
  │              │         │              ├─ /datalake/versions
  │              │         │              ├─ /datalake/vault (Ciphertext)
  │              │         │              ├─ /datalake/avatars
  │              │         │              └─ /datalake/staging (Ephemeral)
  │              │         │
  │              │         └─ PostgreSQL 15 Container Volume (aegis_db / aegis_drive)
  │              │
  │              └─ Unallocated Space Reserve (58.09 GiB) ── Target Reserve: ~26 GiB
  │
  └─ External USB Interface
       │
       └─ External HGST 1 TB Drive (931.5 GiB Usable Ext4)
            │
            └─ Host Mount: /mnt/aegis-backup
                 │
                 ├─ [Pre-existing Unrelated Files] (OUT OF SCOPE / PRESERVED)
                 │
                 └─ /mnt/aegis-backup/AEGIS_BACKUP/
                      │
                      └─ aegis-restic/ (Encrypted Snapshot Repository)
                           ▲
                           │ Host Backup Agent (Cron / Systemd)
                           ┴
```

### 8.2 Academic & Cybersecurity Systems View
Abstract system model suitable for technical reports:

```
┌────────────────────────────────────────────────────────┐
│                   AEGIS Architecture                   │
├──────────────────────────┬─────────────────────────────┤
│ Primary Storage Subsystem│ Dedicated Container Volume  │
│ Data Lake Engine         │ Filesystem Object Storage   │
│ Metadata Engine          │ Relational Database (RDBMS) │
│ Resiliency Subsystem     │ Host-Level Backup Agent     │
│ Secondary Storage        │ Isolated External Disk Target│
│ Hardware Redundancy      │ NOT CONFIGURED (Future Goal)│
└──────────────────────────┴─────────────────────────────┘
```

---

## 9. Security Principles & Threat Considerations

The storage and persistence architecture adheres to core cybersecurity principles:

1. **Separation of Data and Metadata**: Direct file manipulation cannot bypass database access control lists, and database compromises do not directly expose encrypted Vault file streams.
2. **Principle of Least Privilege**: The application container (`drive`) runs with unprivileged user permissions, mounts only its designated volume (`/datalake`), and has no access to the host root filesystem or external backup drive.
3. **Failure-Domain Separation**: Primary storage and backup storage reside on separate physical hardware devices. A complete hardware failure or catastrophic destruction of the internal SSD does not impact the external backup repository.
4. **Zero-Knowledge Ciphertext Preservation**: Private Vault files are encrypted browser-side. The host storage layer, container filesystems, and backup repositories store exclusively ciphertext. Zero-knowledge is maintained throughout the backup and restore lifecycle.
5. **Credential Isolation**: Backup encryption keys and restic repository passwords reside strictly on the host OS. Drive containers contain zero backup credentials and have no network routes to backup administrative interfaces.
6. **Hardware Preservation Boundary**: Automated scripts and container operations strictly enforce the `/mnt/aegis-backup/AEGIS_BACKUP/` root boundary, preventing unauthorized data modification on shared devices.
7. **No Administrative Host Mutation from Web UI**: Operations such as LVM resizing, partition creation, physical formatting, and direct disk unlinking cannot be invoked through the web application.
8. **Truthful Redundancy Reporting**: The system explicitly declares `RAID: NOT CONFIGURED` to prevent false assumptions of high availability.
9. **Logical Deletion vs. Physical Reclamation Auditing**: The system explicitly differentiates between metadata soft-deletion (Protected Trash) and verified physical byte reclamation.

---

## 10. Academic Report Section: Persistence & Resilience

*(This section provides concise, academic-grade text suitable for inclusion in the final project report or thesis).*

### 10.1 Physical Storage and Virtualization Architecture
The AEGIS storage architecture operates on an internal solid-state drive with 119.2 GiB of usable capacity managed via the Linux Logical Volume Manager (LVM). To provide operational flexibility and prevent unconstrained host disk exhaustion, the Volume Group (`ubuntu-vg`, 116.19 GiB) initially allocates approximately 58.09 GiB to the root logical volume (`ubuntu-lv`), reserving the remaining 58.09 GiB as unallocated extents. Container runtimes and persistent volumes are hosted on an `ext4` filesystem. Planned infrastructure growth targets an orderly expansion of the root volume to 90 GiB while preserving a 26 GiB administrative reserve.

### 10.2 Containerized Data Lake and Storage Segregation
AEGIS implements a containerized Data Lake model utilizing Docker named volumes (`aegis_drive_storage`). Persistent object storage is compartmentalized into functional directories: active objects (`uploads`), historical revisions (`versions`), client-side encrypted payloads (`vault`), user identity media (`avatars`), and transient upload buffers (`staging`). Access is strictly mediated through container boundary isolation; adjacent microservices possess no mount permissions to the Data Lake volume.

### 10.3 Decoupled Relational Metadata Management
System state is decoupled into a raw binary data layer and a relational metadata layer. All binary objects reside in the Data Lake, whereas relational attributes—including identity bindings, MIME classifications, SHA-256 integrity hashes, version chains, access control policies, and append-only audit events—are managed in an isolated PostgreSQL instance (`aegis_drive`).

### 10.4 Secondary Backup Storage and Failure Domains
Disaster recovery is achieved through physical and logical failure-domain separation. The primary host is paired with an external 1 TB storage target (931.5 GiB usable capacity) mounted at `/mnt/aegis-backup`. The backup subsystem operates via an encrypted, deduplicated `restic` repository isolated within `/mnt/aegis-backup/AEGIS_BACKUP/`. The backup payload captures Data Lake objects alongside custom-format relational database dumps, while excluding transient upload chunks.

### 10.5 Hardware Redundancy Constraints
Hardware-level RAID mirroring is currently not configured due to single-drive physical host constraints. High availability is recognized as a future hardware objective, while current resiliency guarantees are delivered through independent, versioned off-device backups.

### 10.6 Data Deletion and Storage Reclamation
Data deletion adheres to a two-phase protocol: initial logical deletion to an authenticated Protected Trash state with a 30-day retention horizon, followed by explicit or automated purging. Purging enforces strict ordering: physical file unlinking is executed prior to database row removal to guarantee crash tolerance. Anomalies observed during storage capacity recalculation are classified under investigation across filesystem inode retention, accounting telemetry, and presentation layer behaviors.

---

## 11. Traceability & Canonical Links

- Operational Status Fragment: [[idea1/idea1-status]]
- Area Master Index: [[idea1/idea1-moc]]
- Core Integration Points: [[core/integration-points]]
- Core Security Architecture: [[core/security-architecture]]
- Data Lake Architectural Concept: [[concepts/Three_Layer_Data_Lake]]
- Zero Knowledge Recovery Principles: [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]
- Honest Telemetry Conventions: [[concepts/Honest_Telemetry_and_Unavailable_States]]
