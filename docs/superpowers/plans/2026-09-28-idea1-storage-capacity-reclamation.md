# Implementation Plan: IDEA1 Storage Capacity Expansion & Trash Reclamation Verification

- **Task Identity**: `TASK=IDEA1-STORAGE-CAPACITY-RECLAMATION-1`
- **Area**: `idea1` | **Owner**: `kla` | **Integration Review**: `yes`
- **Branch**: `fix/idea1-storage-capacity-reclamation` (stacked on PR #220 `fix/idea1-vault-convergence-highres-ux`)
- **Canonical Specification Authority**: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-storage-persistence-architecture.md` (PR #240)
- **Status**: `DRAFT / PENDING_HUMAN_OWNER_TRACK_A`

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

### 2.4 Phase A3: Post-Change Verification (Human Owner Execution)
Record the following outputs to verify Track A acceptance:

```bash
# 1. Verify LVM Volume & Free Space
sudo lvs /dev/ubuntu-vg/ubuntu-lv
sudo vgs ubuntu-vg

# 2. Verify Filesystem Size
df -h /
df -B1 /

# 3. Verify Container Health & Data Lake Accessibility
d ps --filter "label=com.docker.compose.project=aegis-prod"
d exec -it $(d ps -q -f name=drive) ls -la /datalake
d inspect $(d ps -q -f name=drive) --format 'RestartCount: {{.RestartCount}} | OOMKilled: {{.State.OOMKilled}}'
```

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

### 3.3 Root Cause Classification Taxonomy
Based on the empirical evidence gathered in Step B4, classify the system behavior into exactly one category:

| Category | Observed Evidence Pattern | Technical Classification | Required Action |
| :--- | :--- | :--- | :--- |
| **A** | Metadata removed from DB; blob unlinked from `/datalake`; host `df` shows reclaimed space; but UI/Dashboard metric does not reflect decrease. | **Accounting / Telemetry / Presentation Defect** | Investigate `storageReport.js`, `store.storageStatus()`, or frontend state caching. |
| **B** | Metadata removed from DB; but physical blob remains on disk in `/datalake/uploads/`. | **Physical Reclamation Defect** | Investigate `trashCleanup.js` -> `removeRecordBytes` / `removeKey` execution path. |
| **C** | Metadata record remains in DB with `deleted_at IS NOT NULL` after purge command. | **Trash Metadata / Purge Defect** | Investigate `api.js` `/trash/empty` route or SQL transaction in `hardDeleteTrashedFile`. |
| **D** | Physical blob unlinked (`rm`), but `df` free space does not increase; `lsof` shows deleted inode held open by running process. | **Open File Descriptor Retention** | Identify process holding inode (e.g. streaming, thumbnailing) and fix stream closure. |
| **E** | Metadata removed; blob unlinked; host `df` increases; UI telemetry reflects reclaimed space; test passes completely. | **No Defect Proven / Telemetry Semantics** | Earlier symptom caused by concurrent disk activity, OS logging, or snapshot timing. |

---

## 4. Execution Sequence & Status Gates

```
[ Gate 1: Preparation ] ── (THIS CHECKPOINT)
  ├─ Plan created in docs/superpowers/plans/
  ├─ Stacked Draft PR opened targeting fix/idea1-vault-convergence-highres-ux
  ├─ Status note updated: IDEA1-STORAGE-CAPACITY-RECLAMATION-1 = IN PROGRESS
  └─ STOP: Await Human Owner execution of Track A

[ Gate 2: Track A Execution ] ── (Human Owner Execution)
  ├─ Execute pre-change inspection
  ├─ Execute lvextend -L 90G -r /dev/ubuntu-vg/ubuntu-lv
  ├─ Execute post-change verification
  └─ Report Track A PASS evidence

[ Gate 3: Track B Verification ] ── (Human Owner + Agent)
  ├─ Execute controlled synthetic fixture lifecycle
  ├─ Record evidence across DB, filesystem, and telemetry
  ├─ Classify root cause (A, B, C, D, or E)
  └─ Formulate code fix ONLY if defect is proven

[ Gate 4: Closeout & Merging ]
  ├─ Final receipt creation
  ├─ Retarget base to main once PR #220 is merged
  └─ Mark PR Ready for Review
```
