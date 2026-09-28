# Implementation Plan: IDEA1 Storage Capacity Expansion & Trash Reclamation Verification

- **Task Identity**: `TASK=IDEA1-STORAGE-CAPACITY-RECLAMATION-1`
- **Area**: `idea1` | **Owner**: `kla` | **Integration Review**: `yes`
- **Branch**: `fix/idea1-storage-capacity-reclamation` (stacked on PR #220 `fix/idea1-vault-convergence-highres-ux`)
- **Canonical Specification Authority**: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-storage-persistence-architecture.md` (PR #240)
- **Status**: `COMPLETED & EMPIRICALLY VERIFIED (2026-09-28)`

---

## 1. Executive Summary & Core Invariants

This plan establishes a two-track, independently gated procedure to expand host root storage capacity and forensically verify the Trash-to-physical-reclamation lifecycle:

1. **TRACK A (Host Storage Capacity Expansion)**: Expand host root LVM logical volume from ~58.09 GiB to ~90 GiB within existing `ubuntu-vg` volume group extents, preserving ~26 GiB safety reserve.
2. **TRACK B (Trash & Physical Reclamation Verification)**: Empirically trace the complete lifecycle of stored objects from upload to purge using controlled synthetic fixtures, classifying the root cause of any storage accounting discrepancies from evidence.

### Strict Governance & Production Invariants
- **Production Mutation Authority**: All host OS operations (LVM resize, filesystem resize) and live container commands belong **strictly to the Human Owner**. The agent prepares exact commands and verification templates; the agent **MUST NOT** execute host storage mutations.
- **Docker Command Authority**:
  ```bash
  d() {
    sudo env -u DOCKER_HOST docker "$@"
  }
  ```
- **Production Compose Project**: `aegis-prod`.
- **System Stability Boundaries**:
  - No disk repartitioning or physical formatting.
  - No `docker system prune` or volume removal.
  - No `docker compose down`.
  - No host reboot unless an independently proven requirement appears.
  - External backup device (`/mnt/aegis-backup`) must remain completely untouched.
  - Production containers must remain healthy throughout.
- **RAID Invariant**: `RAID_CURRENT_STATE=NOT_CONFIGURED` remains unchanged.
- **Application Source Invariant**: No application source changes permitted during Track A. Application code may be altered in Track B **only if a specific defect is proven by empirical evidence**.

---

## 2. TRACK A: Host Storage Capacity Expansion

### 2.1 Track A Acceptance Criteria
- [ ] Internal disk (`/dev/sda` or NVMe) identity, partition table, PV, and VG (`ubuntu-vg`) remain unchanged.
- [ ] Root Logical Volume (`/dev/ubuntu-vg/ubuntu-lv`) expands from ~58.09 GiB to exactly ~90 GiB.
- [ ] Underlying `ext4` filesystem expands online to match the ~90 GiB LV size (~88–89 GiB usable).
- [ ] Remaining free capacity in `ubuntu-vg` is approximately ~26 GiB.
- [ ] Docker engine root directory remains `/var/lib/docker`.
- [ ] Named volume `aegis-prod_aegis_drive_storage` remains unchanged and mounted at `/datalake`.
- [ ] External backup disk at `/mnt/aegis-backup` and `/mnt/aegis-backup/AEGIS_BACKUP/` remain untouched.
- [ ] Production containers (`drive`, `hub`, `monitor`, `postgres`, `gateway`) remain healthy with `restart 0` and `OOM false`.

### 2.2 Phase A1: Pre-Change Inspection (Human Owner Execution)
Execute the following read-only commands on the production host to record baseline state:

```bash
# 1. Host LVM & Filesystem Baseline
sudo pvs
sudo vgs
sudo lvs
df -h /
df -B1 /

# 2. Docker & Container Volume Baseline
d() { sudo env -u DOCKER_HOST docker "$@"; }
d info --format 'DockerRootDir: {{.DockerRootDir}}'
d ps --filter "label=com.docker.compose.project=aegis-prod" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
d volume inspect aegis-prod_aegis_drive_storage || d volume inspect aegis_drive_storage

# 3. Mount & Backup Boundary Check
mount | grep -E '(/ |/mnt/aegis-backup)'
ls -ld /mnt/aegis-backup/AEGIS_BACKUP
```

### 2.3 Phase A2: Controlled Online LVM & Filesystem Expansion (Human Owner Execution)
Execute the online expansion using `lvextend` with `-r` (which automatically invokes `resize2fs` on `ext4`):

```bash
# Controlled expansion to 90G with automatic online filesystem resize
sudo lvextend -L 90G -r /dev/ubuntu-vg/ubuntu-lv
```

*(Alternative if run separately)*:
```bash
sudo lvextend -L 90G /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

### 2.4 Phase A3: Post-Change Verification & Observed Production Results
Human Owner executed online LVM and filesystem expansion on production:

- **LVM Expansion**:
  - BEFORE: `ubuntu-lv = 58.09 GiB`, `ubuntu-vg free = 58.09 GiB`, root filesystem ≈ `56.9 GiB`.
  - AFTER: `ubuntu-lv = 90.00 GiB`, `ubuntu-vg free = <26.19 GiB`, root filesystem ≈ `88.3 GiB`.
- **System & Volume Stability**:
  - `DockerRootDir = /var/lib/docker` (unchanged).
  - Named volume `aegis-prod_aegis_drive_storage` (unchanged).
  - External backup disk at `/mnt/aegis-backup` (untouched).
  - Production containers healthy (`restart 0`, `OOM false`).
  - Reboot not required.
- **Track A Result**: `TRACK_A_LVM_EXPANSION=PASS`.

---

## 3. TRACK B: Trash & Physical Reclamation Verification

### 3.1 Track B Acceptance Criteria
- [ ] Uses exclusively synthetic, non-sensitive fixtures (no user data or personal files).
- [ ] Baseline filesystem and database capacity measured before upload.
- [ ] Controlled fixture uploaded; durable bytes verified on disk and in database metadata.
- [ ] Fixture moved to Trash; soft-delete metadata state verified (`deleted_at IS NOT NULL`), durable bytes verified retained.
- [ ] Trash emptied; hard purge verified across database metadata and physical blob storage.
- [ ] Physical block reclamation measured via `df -B1 /` and `statfs`.
- [ ] Telemetry endpoint (`/api/storage`) and UI Dashboard state measured and reconciled.
- [ ] Root cause classified against the five formal defect categories.
- [ ] Application source modified only if a defect is proven.

### 3.2 Controlled Test Procedure

#### Step B1: Pre-Test Measurement
Record initial byte counts:
- Query `df -B1 /` on host.
- Query `SELECT count(*), coalesce(sum(size_bytes),0) FROM files WHERE deleted_at IS NULL;` in `aegis_drive`.
- Fetch `GET /api/storage` via authenticated session.

#### Step B2: Upload Controlled Synthetic Fixture
1. Generate synthetic non-sensitive file of known exact size (e.g., 500 MiB = 524,288,000 bytes):
   ```bash
   dd if=/dev/urandom of=/tmp/synthetic-test-500mb.bin bs=1M count=500
   sha256sum /tmp/synthetic-test-500mb.bin
   ```
2. Upload via AEGIS Drive web interface or authenticated API.
3. Verify:
   - File appears in UI and database `files` table with exact byte count.
   - Physical blob appears in `/datalake/uploads/` (or via `storageKey`).
   - Host `df -B1 /` available space decreases by approximately ~500 MiB.

#### Step B3: Move to Protected Trash (Soft Deletion)
1. Delete the synthetic fixture from the Drive UI.
2. Verify:
   - File transitions to Protected Trash.
   - Database record retains row but sets `deleted_at = NOW()` and `purge_at = NOW() + 30 days`.
   - File blob **still exists** on disk in `/datalake/uploads/` (bytes retained during 30-day recovery window).
   - Available space on `df -B1 /` does not increase (expected behavior for soft delete).

#### Step B4: Empty Trash (Hard Purge)
1. Authenticate with step-up password and trigger Empty Trash (or `POST /api/trash/empty`).
2. Verify:
   - Database record is purged from `files` table (`hardDeleteTrashedFile`).
   - Physical blob unlinking: verify the file is unlinked from `/datalake/uploads/` via `removeKey`.
   - Check open file descriptors:
     ```bash
     sudo lsof +L1 / | grep -i datalake
     ```
   - Check filesystem free space:
     ```bash
     df -B1 /
     df -h /
     ```
   - Fetch updated `/api/storage` telemetry payload.

### 3.3 Root Cause Classification Taxonomy & Observed Evidence

| Category | Observed Evidence Pattern | Technical Classification | Required Action |
| :--- | :--- | :--- | :--- |
| **A** | Metadata removed from DB; blob unlinked from `/datalake`; host `df` shows reclaimed space; but UI/Dashboard metric does not reflect decrease. | **Accounting / Telemetry / Presentation Defect** | Investigate `storageReport.js`, `store.storageStatus()`, or frontend state caching. |
| **B** | Metadata removed from DB; but physical blob remains on disk in `/datalake/uploads/`. | **Physical Reclamation Defect** | Investigate `trashCleanup.js` -> `removeRecordBytes` / `removeKey` execution path. |
| **C** | Metadata record remains in DB with `deleted_at IS NOT NULL` after purge command. | **Trash Metadata / Purge Defect** | Investigate `api.js` `/trash/empty` route or SQL transaction in `hardDeleteTrashedFile`. |
| **D** | Physical blob unlinked (`rm`), but `df` free space does not increase; `lsof` shows deleted inode held open by running process. | **Open File Descriptor Retention** | Identify process holding inode (e.g. streaming, thumbnailing) and fix stream closure. |
| **E** *(MATCH)* | Metadata removed; blob unlinked; host `df` increases; UI telemetry reflects reclaimed space; test passes completely. | **No Backend Defect Proven / Full Physical Reclamation** | Empirical evidence proves backend unlinking, zero leak, and space reclamation. |

### 3.4 Track B Empirical Production Evidence
Human Owner conducted controlled synthetic fixture tests on production:

1. **B0 (Baseline)**:
   - `/datalake = 30111636 KiB`, `/uploads = 26307676 KiB`, `/versions = 1032 KiB`.
2. **B1 (Upload 512 MiB + 1 GiB)**:
   - `/datalake = 31684508 KiB`, `/uploads = 27880548 KiB`, active staging sessions = 0.
   - `TRACK_B_UPLOAD_PERSISTENCE=PASS`.
3. **B2 (Move to Trash)**:
   - `/datalake = 31684508 KiB`, `/uploads = 27880548 KiB` (physical bytes retained during soft delete).
   - `TRACK_B_MOVE_TO_TRASH_LOGICAL_ONLY=PASS`.
4. **B3A (Permanent Delete 512 MiB item)**:
   - `/datalake = 31160216 KiB`, `/uploads = 27356256 KiB`.
   - `TRACK_B_PER_ITEM_PURGE=PASS`.
5. **B3B (Permanent Delete 1 GiB item)**:
   - `/datalake = 30111636 KiB`, `/uploads = 26307676 KiB` (returned exactly to B0 logical byte baseline).
6. **B4 (Empty Trash Production Acceptance)**:
   - `/datalake = 21302140 KiB`, `/uploads = 17498180 KiB`, `/versions = 1032 KiB`.
   - Host filesystem used = `40496644 KiB`, available = `47675816 KiB`.
   - Drive container healthy, `restartCount = 0`, IDEA2 untouched.
   - **Physical space reclaimed (B3B → B4)**: `8809496 KiB ≈ 8.40 GiB`.
   - `TRACK_B_EMPTY_TRASH=PASS`, `PHYSICAL_BLOB_RECLAMATION=PASS`, `FILESYSTEM_SPACE_RECLAMATION=PASS`.
7. **Storage Accounting (UI Dashboard)**:
   - BEFORE Empty Trash: total `88.3 GB`, used `51.2 GB`, free `37.1 GB`, AEGIS-accounted `6.0 GB`, other-on-volume `45.2 GB`, previous-versions `5.4 GB`, other-files `498 MB`, media `103 MB`.
   - AFTER refresh: total `88.3 GB`, used `42.8 GB`, free `45.5 GB`, AEGIS-accounted `1.3 GB`, other-on-volume `41.5 GB`, previous-versions `764 MB`, other-files `498 MB`, media `103 MB`.
   - `DASHBOARD_STORAGE_ACCOUNTING_AFTER_REFRESH=PASS`.
   - `OPEN_DESCRIPTOR_LEAK_FOR_CONTROLLED_FIXTURES=NOT_OBSERVED`.

### 3.5 Separate UI Findings (Deferred to PR #243)
1. **Trash Destructive Reauth Autofill**: Browser password manager heuristically filled `"admin"` into Trash search input during destructive confirmation, hiding remaining rows behind an unintended query filter. Tracked and isolated separately in PR #243.
2. **Sidebar Meter Refresh Latency**: Sidebar storage meter does not update immediately after physical purge; correct value displays following dashboard poll, navigation, or full refresh. Tracked in PR #243 UI reconciliation scope.
*Neither finding invalidates backend reclamation acceptance.*

---

## 4. Execution Sequence & Status Gates

```
[ Gate 1: Preparation ] ── PASS
  ├─ Plan created in docs/superpowers/plans/
  ├─ Stacked Draft PR opened targeting fix/idea1-vault-convergence-highres-ux
  └─ Status note updated: IDEA1-STORAGE-CAPACITY-RECLAMATION-1 = IN PROGRESS

[ Gate 2: Track A Execution ] ── PASS (Human Owner Execution)
  ├─ Executed pre-change inspection
  ├─ Executed lvextend -L 90G -r /dev/ubuntu-vg/ubuntu-lv
  ├─ Root LV expanded from ~58.09 GiB to ~90.00 GiB; filesystem now ~88.3 GiB
  └─ Host stability, container health, and safety reserve verified

[ Gate 3: Track B Verification ] ── PASS (Human Owner Execution)
  ├─ Executed controlled synthetic fixture lifecycle (512 MiB + 1 GiB)
  ├─ Reclaimed 8,809,496 KiB ≈ 8.40 GiB on Empty Trash
  ├─ Classified as Category E (No Backend Defect; Full Physical Reclamation)
  └─ APPLICATION_SOURCE_CHANGED=NO, TRASH_BACKEND_FIX_REQUIRED=NO

[ Gate 4: Closeout & Merging ] ── CURRENT
  ├─ Final immutable receipt created: 2026-09-28_225000_kla_idea1-storage-capacity-reclamation.md
  ├─ Canonical status updated: idea1-status.md
  ├─ PR #241 body updated with complete Track A & B evidence
  ├─ Maintain Draft state until dependency PR #220 merges
  └─ Retarget base to main once PR #220 is merged
```
