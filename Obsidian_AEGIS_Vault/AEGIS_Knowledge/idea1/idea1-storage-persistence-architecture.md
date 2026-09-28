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

## 1. Architecture Authority & Executive Summary

This canonical architecture document is the **authoritative IDEA1 reference** for engineering contributors, future Autonomous Agents, and authors of the final academic / capstone cybersecurity project report.

### 1.1 Scope of Authority
This document establishes the canonical truth and system contracts for:
1. **Physical storage architecture**: Internal host SSD, disk capacity, and interface layers.
2. **LVM / filesystem relationship**: Ubuntu LVM volume groups, logical volume sizing, and ext4 formatting.
3. **Docker storage relationship**: Root filesystem backing of `/var/lib/docker` vs. absence of daemon storage quotas.
4. **Data Lake persistence**: Docker named volume (`aegis_drive_storage`), container mount point (`/datalake`), and object classes.
5. **Database metadata structure**: Decoupling of binary file bytes from relational metadata in PostgreSQL (`aegis_drive`).
6. **Backup architecture**: Host Backup Agent, snapshot automation, restic repository, and disaster recovery design.
7. **External backup target**: Physically isolated 1 TB storage device and the `/mnt/aegis-backup/AEGIS_BACKUP/` project preservation boundary.
8. **RAID limitation**: Unconfigured RAID status (`RAID_CURRENT_STATE=NOT_CONFIGURED`) and deferral of RAID1 to future hardware.
9. **Storage capacity planning**: Planned host root expansion to ~90 GiB and retention of the ~26 GiB administrative volume group reserve.
10. **Trash / reclamation boundaries**: Data lifecycle stages, distinction between metadata purging and physical block reclamation, and the open reclamation defect.

### 1.2 Non-Negotiable Operational Boundaries
- **Documentation Only**: Establishes architectural truth; does not alter running containers or infrastructure.
- **No Disk Resizing**: Does not execute LVM volume commands (`lvextend`, `resize2fs`).
- **No Production Mutation**: Does not alter running production containers, environment files, or live services.
- **No Trash Fix Implementation**: Documents the open reclamation symptom without inventing untested application workarounds.
- **No API Modification**: Does not create new web API routes or expose host-level operations to web clients.
- **External Disk Hygiene**: Does not inspect, enumerate, or alter unrelated files on the external backup device.
- **Security & Privacy Hygiene**: Contains zero credentials, tokens, passwords, private keys, database dumps, or user filenames.

---

## 2. System Structure Summary

The AEGIS Drive storage subsystem comprises two distinct runtime pipelines (Primary Data Persistence and Relational Metadata Governance) paired with an independent Resiliency Subsystem:

### 2.1 Complete End-to-End Persistence Pipeline
```
[ Primary Data Persistence Pipeline ]
Physical Internal SSD (~119.2 GiB Usable / 128 GB Marketed)
      │
      ▼
Ubuntu LVM (PV: ~116.2 GiB | VG: ubuntu-vg ~116.19 GiB)
      │
      ▼
ext4 Root Filesystem (Current Root LV: ~58.09 GiB | Usable: ~57 GiB)
      │
      ▼
Docker Runtime (/var/lib/docker on Host Root Filesystem)
      │
      ▼
aegis_drive_storage (Docker Named Volume)
      │
      ▼
Data Lake (/datalake Container Mount)
      ├─ uploads/          (Primary User File Blobs)
      ├─ versions/         (Historical Revisions)
      ├─ vault/            (Zero-Knowledge Ciphertext Blobs & Manifests)
      ├─ avatars/          (User Profile Media)
      └─ staging/          (Ephemeral In-Flight Upload Chunks)

[ Relational Metadata Governance Pipeline ]
PostgreSQL 15 (Containerized aegis_db / database: aegis_drive)
      │
      ▼
Relational Metadata Engine
      ├─ Users & Identity Relationships
      ├─ File Metadata & Ownership Hierarchies
      ├─ Version Trees & Retention Pointers
      ├─ Vault Tree Envelopes & Published CAS Heads
      ├─ Secure Share Tokens & CIDR Network Zones
      └─ Append-Only Tamper-Evident Audit Trail

[ Independent Resiliency Subsystem ]
Host Backup Agent (Host Systemd Service / Cron Daemon)
      │
      ├─ Data Lake Durable Content (/var/lib/docker/volumes/aegis_drive_storage/_data)
      ├─ PostgreSQL Custom-Format Logical Dump (pg_dump of aegis_drive)
      │
      ▼
External 1 TB Backup Target (Physically Separate USB Disk at /mnt/aegis-backup)
      │
      ▼
AEGIS_BACKUP/aegis-restic (Encrypted, Deduplicated Restic Repository)

[ Hardware Redundancy Status ]
RAID:
      → NOT CONFIGURED (RAID_CURRENT_STATE=NOT_CONFIGURED)
      → FUTURE HARDWARE (Deferred due to single-drive host constraints)
```

### 2.2 Authoritative Root LV vs. Docker Capacity Truth
> [!important] Crucial Truth: Host LVM Allocation vs. Docker Quota
> The approximately 57 GiB of storage capacity visible to the AEGIS Drive application and Docker environment is **NOT** a Docker storage quota, container layer ceiling, or container engine limit.
>
> It resulted strictly from the initial Ubuntu Server OS installation allocating approximately half (~58.09 GiB) of the 116.19 GiB Volume Group (`ubuntu-vg`) to the root Logical Volume (`ubuntu-lv`), while leaving the remaining ~58.09 GiB unallocated as free extents within the volume group. Because `/var/lib/docker` resides on the `ext4` root filesystem, container volume capacity is directly bounded by the root LV's current allocation.

### 2.3 Observed Physical Topology Snapshot
The observed physical storage layout from production preflight inspection is:
- **Internal System Disk**: Approximately 119.2 GiB usable physical storage (commercially marketed as 128 GB).
- **LVM Physical Volume (PV)**: Approximately 116.2 GiB.
- **LVM Volume Group (VG)**: `ubuntu-vg` initialized at approximately 116.19 GiB.
- **Current Root Logical Volume (LV)**: Approximately 58.09 GiB allocated to `/dev/ubuntu-vg/ubuntu-lv`.
- **Unallocated VG Capacity**: Approximately 58.09 GiB remaining free in `ubuntu-vg`.
- **Host Root Filesystem**: `ext4` mounted at `/`, providing approximately 57 GiB usable space.
- **Planned Controlled Root LV Target**: Approximately 90 GiB (expanding the root LV into available VG capacity while preserving a ~26 GiB safety reserve). Planned expansion is an infrastructure task, **NOT** performed by this documentation task.
- **Data Lake Snapshot**: Total footprint approximately 28.7–29.0 GB (uploads ~25.1 GB, versions ~1.0 MB). These figures represent a point-in-time snapshot, not static constants.

---

## 3. Database Metadata Structure

A fundamental principle of the AEGIS architecture is the strict operational and security decoupling between binary payload bytes and relational metadata:

$$\text{FILE BYTES} \neq \text{DATABASE METADATA}$$

```
┌────────────────────────────────────────────────────────┐
│                      AEGIS Drive                       │
└───────────┬────────────────────────────────┬───────────┘
            │ Binary Data Streams            │ Relational Transactions
            ▼                                ▼
┌───────────────────────┐        ┌───────────────────────┐
│       Data Lake       │        │  PostgreSQL Database  │
│ (aegis_drive_storage) │        │     (aegis_drive)     │
├───────────────────────┤        ├───────────────────────┤
│ • Raw File Blobs      │        │ • Users & Credentials │
│ • Historical Revisions│        │ • File Tree Attributes│
│ • Vault Ciphertext    │        │ • Version References  │
│ • User Avatar Images  │        │ • Vault Envelopes     │
│ • Staging Buffers     │        │ • Share Grants & ACL  │
│                       │        │ • Audit Event Trail   │
└───────────────────────┘        └───────────────────────┘
```

### 3.1 Persistence Responsibility Distribution
- **The Data Lake (`/datalake`)**: Contains the durable binary objects themselves. File streams are ingested, chunked, verified via SHA-256 hashes, and stored on disk indexed by internal storage keys.
- **The PostgreSQL Database (`aegis_drive`)**: Tells the system what stored objects mean, who owns them, how they relate hierarchically, and what operations occurred. PostgreSQL **never** stores raw file binary streams or large BLOBs.

### 3.2 High-Level Metadata Classifications
Without publishing raw database schemas, credentials, or example personal records, the relational metadata layer governs:
1. **Users & Identity Relationships**: Unique user identifiers (UUIDs), role classifications (`admin`, `user`, `datalake`), authentication credentials (Argon2id password hashes), active session tokens, and security lockout counters.
2. **File Hierarchy & Attributes**: Logical UUIDs, user-defined file and directory names, parent folder relationships (`parent_id`), MIME types, file sizes in bytes, cryptographic SHA-256 checksums, and ownership bindings.
3. **Version & History Tracking**: Version UUIDs, foreign keys to parent file records, references to historical storage keys, creation timestamps, author IDs, and version comment logs.
4. **Private Vault Envelopes & Tree Revisions**: Opaque blob identifiers, ciphertext byte counts, key derivation salt values, initialization vectors (IVs), tree manifest storage pointers, and Compare-And-Swap (CAS) revision counters. Plaintext names and cryptographic keys are strictly absent.
5. **Share Governance & Access Policies**: Ephemeral share tokens, cryptographic token hashes, target file references, access permission flags, CIDR network zone restrictions, download thresholds, and expiration timestamps.
6. **Tamper-Evident Audit Trail**: Append-only security event logs recording event types, actor IDs, target resources, client IP addresses (normalized across reverse proxies), and operation outcomes.

---

## 4. Report-Ready Explanation

*(The subsections below are written in formal academic/technical style, designed for direct reuse in the final project thesis or academic report).*

### 4.1 Physical Storage Architecture
The AEGIS host server operates on a solid-state drive with 119.2 GiB of usable capacity managed via the Linux Logical Volume Manager (LVM). To guard against unconstrained disk exhaustion and enable administrative flexibility, the Volume Group (`ubuntu-vg`, 116.19 GiB) allocates 58.09 GiB to the root logical volume (`ubuntu-lv`), retaining 58.09 GiB as unallocated extents. Container runtimes and persistent storage volumes reside on a standard `ext4` filesystem mounted at `/`.

### 4.2 Containerized Data Lake
Persistent user storage is implemented as a containerized Data Lake utilizing Docker named volumes (`aegis_drive_storage`). The volume is mounted exclusively to `/datalake` within the AEGIS Drive container. Objects are categorized into functional subdirectories: active user objects (`uploads`), prior file revisions (`versions`), client-encrypted zero-knowledge payloads (`vault`), profile media (`avatars`), and transient upload buffers (`staging`). Adjacent microservices (Gateway, Monitor) possess no mount privileges to this volume.

### 4.3 Metadata Database
System architecture enforces a strict boundary between raw binary payloads and system state. Binary data is stored within the filesystem Data Lake, while relational structure, identity bindings, cryptographic checksums, version trees, and access policies are maintained in an isolated PostgreSQL instance (`aegis_drive`). This decoupling prevents database bloat, maintains query efficiency, and ensures database backups remain compact.

### 4.4 Backup Architecture
System resilience is achieved via a dedicated Host Backup Agent operating outside the Docker environment. The agent executes scheduled `restic` snapshots targeting a physically separate 1 TB external drive mounted at `/mnt/aegis-backup`. Snapshots capture the Data Lake volume contents and custom-format PostgreSQL database dumps, encrypting and deduplicating chunks client-side before transmission. Transient staging buffers are explicitly excluded to maintain snapshot determinism.

### 4.5 Failure-Domain Separation
Storing backups on a physically distinct external disk establishes strict failure-domain separation. A catastrophic failure of the internal primary SSD, controller failure, filesystem corruption, or container escape cannot compromise the physical backup media. This architecture ensures complete disaster recovery capability that is unattainable when storing backups on secondary partitions of the primary disk.

### 4.6 RAID Limitation
Hardware redundancy via RAID mirroring is currently not configured (`RAID_CURRENT_STATE=NOT_CONFIGURED`). The external 1 TB backup drive operates strictly as an independent backup destination and is not a member of a RAID array. Real RAID1 requires an identical, dedicated disk pair and remains deferred to future hardware iterations due to single-drive host constraints.

### 4.7 Planned Capacity Expansion
To accommodate data growth prior to physical hardware upgrades, an infrastructure plan exists to expand the root logical volume from ~58.09 GiB to approximately 90 GiB. This expansion utilizes unallocated capacity already present within `ubuntu-vg`, while preserving an administrative reserve of approximately 26 GiB for snapshotting and emergency maintenance.

### 4.8 Data Deletion and Reclamation Boundary
Data deletion traverses an explicit multi-stage pipeline:
$$\text{Active File} \longrightarrow \text{Protected Trash} \longrightarrow \text{Empty Trash / Purge} \longrightarrow \text{Metadata Deletion} \longrightarrow \text{Physical Blob Reclamation} \longrightarrow \text{Ext4 Inode/Block Release} \longrightarrow \text{Telemetry Refresh}$$

Successful UI deletion proves only logical state transition; it does not guarantee immediate physical byte reclamation. Potential latency between metadata removal and filesystem free-space recovery may arise from open file handles, delayed OS block allocation routines, or background filesystem accounting.

### 4.9 Security Considerations
1. **Principle of Least Privilege**: Drive containers run with non-root UID/GID bindings and possess no access to host disks or backup tools.
2. **Privilege Separation**: Host LVM maintenance, telemetry polling, and application file operations belong to strictly segregated execution contexts.
3. **Data / Metadata Decoupling**: Database compromises do not directly expose encrypted Vault file streams.
4. **Zero-Knowledge Ciphertext Preservation**: Private Vault files are encrypted client-side using Argon2id/AES-256-GCM; backups store only ciphertext without requiring or possessing user keys.
5. **Separate Failure Domains**: Physical disk isolation prevents single-point hardware destruction.
6. **External Media Boundary**: AEGIS processes strictly restrict file writes to `/mnt/aegis-backup/AEGIS_BACKUP/`, preserving existing drive content.
7. **No Web-Triggered Disk Mutation**: Host-level disk formatting, volume resizing, and partitioning cannot be initiated through web APIs.
8. **Backup vs. RAID Independence**: Backup provides point-in-time recovery against corruption; RAID provides instantaneous uptime against drive failure.

---

## 5. Agent Handoff Notes

Future autonomous agents and engineering contributors must treat the following **twenty assertions** as authoritative system truth:

### STORAGE_ARCHITECTURE_TRUTH:
1. **Separation of Layers**: Actual file bytes and PostgreSQL metadata are strictly separated persistence layers.
2. **Data Lake Volume**: The Docker named volume `aegis_drive_storage` provides the primary IDEA1 Data Lake.
3. **No Docker Quota**: The observed ~57 GiB capacity was caused by host root LVM allocation, not a Docker storage quota or daemon limit.
4. **Internal Disk Capacity**: The internal host SSD provides approximately 119.2 GiB usable space (marketed commercially as 128 GB).
5. **Unallocated LVM Capacity**: The LVM Volume Group (`ubuntu-vg`) contains substantial unallocated capacity (~58.09 GiB) beyond the root LV.
6. **Planned Expansion Target**: The planned root LV target is approximately 90 GiB, preserving a ~26 GiB administrative reserve in `ubuntu-vg`.
7. **Dedicated Backup Target**: The external ~1 TB physical disk is a separate, dedicated Backup Target mounted at `/mnt/aegis-backup`.
8. **No Docker Expansion**: The external disk is **NOT** Docker storage expansion, LVM storage pool extension, or a data lake mount.
9. **Not a RAID Member**: The external disk is **NOT** a member of a RAID array.
10. **RAID Status**: `RAID_CURRENT_STATE=NOT_CONFIGURED`.
11. **RAID Roadmap**: RAID1 remains **FUTURE HARDWARE / FUTURE ARCHITECTURE** requiring dedicated multi-drive hardware.
12. **External Media Scope**: AEGIS-owned backup content is strictly restricted to `/mnt/aegis-backup/AEGIS_BACKUP/`. Unrelated external files must never be inspected, altered, or deleted.
13. **Ciphertext Backup**: Private Vault backup content remains ciphertext; backup and restore workflows must never require or store plaintext keys.
14. **Backup $\neq$ RAID**: Backup provides versioned recovery across time; RAID provides high availability across hardware drive loss. They are not equivalent.
15. **Deletion $\neq$ Reclamation**: Logical deletion in software is not automatically proof of physical block reclamation on disk.
16. **Observed Purge Symptom**: The Human Owner observed that Dashboard-reported used storage did not visibly decrease after files were deleted and Trash was emptied.
17. **Root Cause Status**: The root cause of that symptom remains **NOT YET PROVEN** at this architectural stage.
18. **No Unproven Claims**: Do not characterize the reclamation symptom as a cache leak unless future controlled empirical evidence proves it.
19. **Investigation Hypotheses**: Possible causes include metadata deletion defects, physical blob unlinking failures, open file descriptor retention, storage telemetry semantics (`statfs` host scope), or UI caching.
20. **Privilege Segregation**: Trash operations, storage telemetry reporting, and host LVM resizing belong to different privilege domains and must never be combined into a single privileged API.

---

## 6. API and Privilege Boundaries

The AEGIS architecture enforces strict segregation of privileges across application, telemetry, infrastructure, and backup boundaries:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        API & PRIVILEGE BOUNDARIES                      │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│ Domain                  │ Execution Context      │ Security Privilege  │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ Application Trash API   │ Node.js / Express      │ Application-level   │
│                         │ (/api/trash/*)         │ authenticated user  │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ Storage Telemetry       │ Express Read Handler   │ Read-only query of  │
│                         │ (/api/storage)         │ statfs & DB counts  │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ Host LVM Resize         │ Host OS Bash / Root    │ Host administrative │
│                         │ (lvextend, resize2fs)  │ (CAP_SYS_ADMIN)     │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ Relational Metadata     │ PostgreSQL Engine      │ Application DB user │
│                         │ (SQL queries via pool) │ (no OS privileges)  │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ External Backup Agent   │ Host Systemd / restic  │ Host-level service  │
│                         │ (Independent daemon)   │ (isolated keys)     │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

### Architectural Rationale for Boundary Separation
- **Trash Purge vs. Storage Telemetry**: Trash purging is a destructive, authenticated state change; telemetry reporting is a read-only projection. Combining them would expose destructive side effects during routine dashboard polling.
- **Host LVM vs. Web Application**: Host disk management requires root privileges (`lvextend`, `resize2fs`). Exposing host volume management through web endpoints would create a severe remote privilege escalation vector and drastically enlarge the attack surface.
- **Application Container vs. Backup Agent**: The Drive web application has no access to restic encryption keys or external disk mount commands. Drive acts solely as a client displaying backup health metrics queried from host telemetry files.

---

## 7. External 1 TB Backup Target: Canonical Report Statement

*(The text below represents the canonical, report-safe description of the external backup subsystem for inclusion in academic documents)*:

> "The backup subsystem uses an external storage device with approximately 1 TB marketed capacity as a physically separate backup target from the primary server storage. AEGIS operates only within its designated backup directory and does not enumerate, alter, repartition, format, resize, or delete unrelated content elsewhere on the device. The external device functions as a backup target and is not a member of a RAID array. RAID1 remains a future hardware enhancement because the current prototype does not provide the required dedicated disk pair."

---

## 8. Report Diagram Source Models

### 8.1 Engineering Architecture View
```
Internal SSD (~128 GB Marketed / ~119.2 GiB Usable)
        │
        ▼
Ubuntu LVM (ubuntu-vg: ~116.19 GiB)
        │
        ├─ Free Extents (~58.09 GiB Unallocated Reserve)
        │
        └─ Root Logical Volume (~58.09 GiB Allocation ── Target: 90 GiB)
                │
                ▼
        ext4 Root Filesystem (~57 GiB Usable)
                │
                ├─ Docker Runtime Environment (/var/lib/docker)
                │       │
                │       └─ aegis_drive_storage (Named Docker Volume)
                │                 │
                │                 ▼
                │              Data Lake (/datalake)
                │             /    │     \         \
                │       uploads versions vault   avatars
                │                          │
                │                   (Ciphertext)
                │
                └─ PostgreSQL 15 Volume (aegis_db / aegis_drive)
                        │
                        ▼
                Metadata Engine (Identity, File Trees, Versions, Shares, Audit)

Host Backup Agent (Host Systemd / restic)
        │
        ├─ Data Lake Durable Content (/var/lib/docker/volumes/aegis_drive_storage/_data)
        ├─ PostgreSQL Custom-Format Backup (pg_dump)
        │
        ▼
External Backup Storage (~1 TB Marketed / 931.5 GiB Usable ext4)
        │
        ▼
AEGIS_BACKUP/aegis-restic/ (Encrypted Snapshot Repository)

RAID Redundancy
        │
        ▼
NOT CONFIGURED / FUTURE HARDWARE (Single Primary SSD Constraint)
```

### 8.2 Academic Systems Model
```
┌────────────────────────────────────────────────────────┐
│                     Primary Storage                    │
│                      (Internal SSD)                    │
│                            │                           │
│        ┌───────────────────┴───────────────────┐       │
│        ▼                                       ▼       │
│    Data Lake                           Metadata Store  │
│ (Object Blobs)                           (PostgreSQL)  │
└────────┬───────────────────────────────────────┬───────┘
         │                                       │
         └───────────────────┬───────────────────┘
                             │ Periodic Snapshots
                             ▼
                    Host Backup Agent
                             │
                             ▼
                  External Backup Storage
                   (Physically Isolated)

                 RAID = Not Configured
```

---

## 9. Using This Document in the Final Report

When compiling final engineering deliverables, capstone project reports, or academic papers, future authors must observe four strict classifications:

### Mandatory Classification Taxonomy
1. **CURRENT VERIFIED STATE**:
   - Internal SSD partitioned with Ubuntu LVM (~116.19 GiB VG, ~58.09 GiB root LV, ~58.09 GiB free extents).
   - Docker container volume `aegis_drive_storage` providing the `/datalake` filesystem.
   - Separation of Data Lake file blobs and PostgreSQL metadata.
   - External 1 TB USB drive providing isolated restic backup target under `/mnt/aegis-backup/AEGIS_BACKUP/`.
   - `RAID_CURRENT_STATE=NOT_CONFIGURED`.
2. **PLANNED CHANGE**:
   - Host root logical volume expansion from ~58.09 GiB to ~90 GiB within existing `ubuntu-vg` extents.
3. **FUTURE ARCHITECTURE**:
   - Hardware RAID1 mirroring utilizing a dedicated, matched internal drive pair.
4. **OPEN / UNPROVEN DEFECT**:
   - Storage dashboard used space not visibly decreasing after emptying Protected Trash (`ROOT CAUSE: NOT YET PROVEN`).

> [!danger] Report Integrity Rule
> Never silently promote a **Planned Change** or **Future Architecture** item into an implemented or verified state. Never attribute the open reclamation defect to an unverified cause (such as cache leakage) without empirical evidence.

---

## 10. Traceability & Canonical Links

- Operational Status Fragment: [[idea1/idea1-status]]
- Area Master Index: [[idea1/idea1-moc]]
- Public Share Architecture: [[idea1/idea1-public-share-architecture]]
- Core Integration Points: [[core/integration-points]]
- Core Security Architecture: [[core/security-architecture]]
- Data Lake Architectural Concept: [[concepts/Three_Layer_Data_Lake]]
- Zero Knowledge Recovery Principles: [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]
- Honest Telemetry Conventions: [[concepts/Honest_Telemetry_and_Unavailable_States]]
