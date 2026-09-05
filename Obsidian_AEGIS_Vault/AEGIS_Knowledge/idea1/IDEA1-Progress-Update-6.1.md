---
title: IDEA1 Progress Update 6.1
aliases: ["IDEA1 6.1", "AEGIS Drive LC Progress 6.1"]
tags: [aegis, idea1, progress, production, acceptance, storage, backup, raid, settings, twingate]
type: status-snapshot
created: 2026-09-05
updated: 2026-09-06
owner: kla
edit_policy: owner-writable
application_source_baseline_sha: 2806373bb300728a0babb953a63f98bcd714ffef
production_drive_sha: 2806373bb300728a0babb953a63f98bcd714ffef
backup_classifier_merge_sha: 07ad78efdf1561f2a49a1ecc81440359b766b3bd
progress_update_merge_pr: 77
runtime_evidence_reconciled_through_pr: 81
---

# IDEA1 — Progress Update 6.1

> [!important] จุดประสงค์ของเอกสารนี้
> เอกสารนี้เป็น **handoff / recovery snapshot** ของ IDEA1 ณ วันที่ 2026-09-05
> เพื่อให้กลับมาทำงานต่อได้แม้แชตเดิมเต็มหรือขาดบริบท โดยรวมสถานะหน้าเว็บทั้ง 10 หน้า,
> Dual Interface Style, Settings, Storage/RAID/Backup, Twingate telemetry,
> production deployment, acceptance ที่ผ่านแล้ว, known limitations และลำดับงานที่เหลือ
> ไว้ในจุดเดียว
>
> Canonical status หลักยังเป็น [[idea1/idea1-status]] ส่วนเอกสารนี้เป็น snapshot รุ่น **6.1**
> ที่ละเอียดกว่าและตั้งใจใช้เป็น checkpoint สำหรับงานต่อจาก 2026-09-05

## 0A. 2026-09-06 LFT reconciliation — current override

> [!important]
> Update 6.1 began as a 2026-09-05 snapshot. For older LFT-V2 E3.1/E3.2/E3.3 sections that still read as pending, use this block together with [[idea1/idea1-status]] as current truth.

- Private Vault large encrypted video = **PASS / CLOSED for direct-VLAN tested scope**. `START_LIVE.mp4` (~1.1 GB / ~2 min) rendered first frame in ~8 s, played continuously for >60 s without observed buffering/stutter, and resumed after a mid-file seek on VLAN30.
- The accepted media path showed HTTP 206 for the virtual media response and HTTP 200 for ciphertext chunks.
- PR #56 E3.2 is no longer a project-level “deployment evidence missing” state: later E3.3 evidence explicitly starts from PR #56 deployed. PR #58 is the canonical merged E3.3 bounded read-ahead implementation; PR #57 was superseded/unmerged.
- Remote high-bitrate performance remains a **remote delivery/network-path limitation**. Current evidence does not prove Twingate alone is the root cause.
- Exact field subcases `close → reopen`, worker restart recovery, and `lock while playing → unlock → reopen` were not separately measured in the 2026-09-02 field acceptance and must not be claimed as field-accepted without new evidence.
- The earlier test session observed 1.1 GB V2 upload and speed/ETA UI PASS; the later field work focused on preview/throughput.
- Real 20–30 GB transfer acceptance and the Production 32 GiB deployment ceiling remain **NOT TESTED / NOT ACCEPTED**. Source boundedness is not equivalent to a real Production transfer at those sizes.

All non-LFT current gates (SECURITY-2, local Twingate telemetry, Administrator truthfulness, Backup Target PR #81 state, Backup Job and RAID) are governed by the reconciled current sections already present in this note.

## 0. Status legend

| Symbol | Meaning |
| :---: | :--- |
| ✅ | PASS / CLOSED — ผ่าน acceptance ตาม scope ที่ระบุแล้ว |
| 🟢 | IMPLEMENTED / DEPLOYED — ทำและขึ้น production แล้ว แต่ยังอาจมี acceptance ย่อยที่ต้องตาม |
| 🟡 | PARTIAL / PENDING — มี implementation บางส่วน แต่ acceptance ยังไม่ครบ |
| ⏳ | WAITING / BLOCKED BY DEPENDENCY — ต้องรอ hardware/integration/ขั้นก่อนหน้า |
| ⚪ | TRUTHFUL LIMITATION / NOT IMPLEMENTED — ไม่ถือเป็น failure ถ้า UI ระบุข้อจำกัดตรงตามจริง |
| ❌ | FAIL / DEFECT — พบ defect ที่ต้องแก้ก่อนปิด scope |

---

# 1. Current production baseline

## 1.1 Git / Drive deployment

- Production Drive application source remains `2806373bb300728a0babb953a63f98bcd714ffef` (PR #80).
- PR #81 merged the Backup Target PrivateDevices classifier at merge milestone `07ad78efdf1561f2a49a1ecc81440359b766b3bd`. Later documentation-only commits may advance repository history; resolve the live `main` head from Git.
- PR #79 local Twingate connector runtime telemetry and PR #80 Vault auto-lock duration/1-minute support are deployed and production-accepted.
- Migration `008_vault_autolock_1_minute.sql` is applied in Production.
- Current accepted Drive image remains `sha256:f604cc985db1f69b79773e8973b3bb8e63f84d28730710c0ebf3174d4156f098`.
- PR #81 changes the host Backup Agent source in Git; it has **not yet been deployed** to the running `aegis-backup.service`.
- HUB, Monitor and PostgreSQL were not recreated for the PR #79/#80 Drive-only deployment.
- Production Git updates remain fetch + fast-forward-only; no force/rebase/shared-history rewrite.

## 1.2 Important merged PR chain

| PR | Purpose | Current state |
| :--- | :--- | :--- |
| #70 | truthful Audit / Trash / Capacity / RAID / Backup states | ✅ merged |
| #71 | Dual Interface Style: Classic / Neo | ✅ merged |
| #72 | Neo drawer/capacity follow-up | ✅ merged |
| #73 | functional Settings: Security, Storage, Administrator | ✅ merged |
| #74 | capacity + Settings acceptance follow-up | ✅ merged / deployed |
| #75 | RAID telemetry-ready hardware UI | ✅ merged / deployed |
| #76 | CapacityRing regression-test false-positive fix | ✅ merged / deployed |
| #77 / #78 | IDEA1 handoff / provenance documentation | ✅ merged; documentation-only |
| #79 | local Twingate connector runtime telemetry | ✅ merged / deployed / production accepted |
| #80 | truthful Vault auto-lock duration + 1-minute option | ✅ merged / deployed / production accepted |
| #81 | Backup Target classifier compatible with `PrivateDevices=true` | ✅ merged to repository main; Production host-agent deployment pending |

Latest Drive suite from PR #80: **1012 total / 945 pass / 0 fail / 67 PostgreSQL-gated skips**; focused auto-lock suites **9/9 + 9/9 PASS**.
PR #79 host telemetry: **139 total / 136 pass / 0 fail / 3 platform-gated skips**.
PR #81 Backup Target classifier: focused **9/9 PASS**, full host-backup-agent **52/52 PASS**.

---

# 2. Current primary navigation — 10 screens

The authenticated IDEA1 shell currently has 10 primary screens.

| Group | Screens |
| :--- | :--- |
| Workspace | Dashboard · Files · Private Vault |
| Protection | Secure Shares · File History · Trash · Storage & Backup |
| Administration | Audit Log · Access Control · Settings |

Upload remains a **Files workflow**, not a standalone sidebar screen.

---

# 3. Master page acceptance matrix — reconciled 2026-09-06

| Screen | Current status | Evidence / remaining boundary |
| :--- | :--- | :--- |
| Dashboard | ✅ **PASS / CLOSED** | Production dashboard and real telemetry accepted. |
| Files | ✅ **PASS / CLOSED** | Deterministic 1 MiB upload → download SHA-256 exact match passed. |
| Private Vault | ✅ **PASS / CLOSED (tested scope)** | 2 MiB zero-knowledge exact-hash round trip and direct-VLAN large preview/playback accepted; remote high-bitrate path remains a documented delivery limitation. |
| Secure Shares | ✅ **PASS / CLOSED (private/internal)** | Password/no-password/copy/network-scope enforcement accepted; public internet gateway remains NOT IMPLEMENTED. |
| File History | ✅ **PASS / CLOSED** | Real per-file versions and non-destructive restore accepted. |
| Trash | ✅ **PASS / CLOSED** | Soft delete, protected unlock, restore and permanent delete accepted; literal 30-day wall-clock wait not performed. |
| Storage & Backup | 🟡 **PARTIAL** | Capacity, Disk Health, RAID standby UI, Backup Agent connection and STORAGE-AUTO-1 are closed. Classifier source/PR gate is CLOSED by PR #81; Production deployment + `DIFFERENT_DEVICE`, Backup Job, integrity/restore and scheduled execution remain. Real RAID1 is deferred. |
| Audit Log | ✅ **PASS / CLOSED** | Production list/filter behavior and result filter accepted. |
| Access Control | ✅ **PASS / CLOSED** | Current RBAC/provisioning workflow accepted. |
| Settings | 🟡 **PARTIAL** | Appearance, Change Password and Security & Privacy are closed. Administrator Encryption-at-Rest + Network Zones are closed; Backup Targets and optional profile/avatar current-sweep acceptance remain. |

---

# 4. Dashboard

## Status: ✅ PASS / CLOSED

Current accepted boundaries:
- authenticated status presentation works
- Drive/PostgreSQL state is real rather than mocked
- host telemetry path exists through the bounded telemetry agent
- no need to repeat basic dashboard acceptance unless telemetry contracts or deployment are changed

Host telemetry production path:

```text
host collectors / proc/sys evidence
        ↓
aegis-telemetry.service
        ↓
/run/aegis-telemetry/telemetry.sock
        ↓ read-only bind
Drive container
        ↓
Dashboard / Storage surfaces
```

Drive still must not receive:
- Docker socket
- unrestricted host `/proc`
- unrestricted host `/sys`
- raw host device access

---

# 5. Files

## Status: ✅ PASS / CLOSED

Accepted evidence:
- normal upload completes and UI gives completion feedback
- completed item does not stay counted as active upload work
- downloaded deterministic 1 MiB file exactly matches source SHA-256
- current file authorization regression scope is closed

Formal deterministic round trip:
- `AEGIS_R2_NORMAL_1MiB.bin`
- 1,048,576 bytes
- source/download SHA-256 exact match
- final: `NORMAL_FILE_R2_ROUND_TRIP = PASS / CLOSED`

Large-file preview performance and storage integrity must remain separate concepts:
- storage acceptance = upload + download + integrity
- preview latency/playback is a separate capability

---

# 6. Private Vault

## Status: ✅ PASS / CLOSED for tested scope

Accepted:
- browser-only key derivation / zero-knowledge model
- deterministic 2 MiB encrypt → ciphertext storage → decrypt exact hash
- direct-LAN large video preview accepted
- ~1.1 GB high-bitrate file can play continuously on direct VLAN30
- audit event `VAULT_UNLOCK` is recorded and appears in Security Activity / Audit Log

### Remote-path limitation

Previous remote high-bitrate playback limitation is classified as:
**remote delivery environment / network path limitation**.

Do **not** claim that Twingate alone was conclusively proven as the root cause.

### SECURITY-2 — ✅ PASS / CLOSED

PR #80 fixed the mismatch between the real timer and its result copy and added the requested 1-minute option through every required layer:

- Settings choices: `1 / 5 / 10 / 15 / 30 / 60`
- server validation: same allowlist
- fresh schema CHECK: widened to the same allowlist
- existing databases: migration `008_vault_autolock_1_minute.sql`
- Vault timer: captures the duration when the timer is armed
- result copy: reports the duration that actually fired in EN/TH/ZH
- default remains 10 minutes; 1 minute is an option, not the default

Production acceptance applied migration 008 before the new Drive image, saved the 1-minute value, refreshed/unlocked, observed the measured idle auto-lock, verified the 1-minute result text, then restored the intended operating value.

Current result: `SECURITY-2 = PASS / CLOSED`

---

# 7. Secure Shares

## Status: ✅ PASS / CLOSED for private/internal share scope

Accepted:
- password-protected share
- wrong password denial
- no-password share
- share copy
- restricted share allow from VLAN30
- same restricted share deny outside configured zone
- trusted-proxy hardening / canonical source behavior

### Known limitation

⚪ **Public external share is NOT IMPLEMENTED.**

Current `aegis.internal` delivery remains private/Twingate-reachable. Do not claim a public internet share gateway exists.

---

# 8. File History

## Status: ✅ PASS / CLOSED

Accepted:
- real per-file multiple version retention
- prior versions remain available
- restore is non-destructive to the intended history model
- restore does not pretend to be a whole-filesystem point-in-time snapshot

Canonical terminology:
**Per-file version history**, not snapshot scheduling.

---

# 9. Protected Trash

## Status: ✅ PASS / CLOSED

Accepted:
- normal Data Lake delete → soft delete
- protected/password step-up access
- restore
- explicit permanent delete
- 30-day retention policy displayed truthfully
- share invalidation behavior incorporated into implementation
- backup write-freeze integration exists for destructive cleanup paths

Boundary:
- automatic purge after the full 30-day wall-clock period was **not literally time-waited**
- this does not reopen the already accepted manual Trash workflow

---

# 10. Storage & Backup

## Overall status: 🟡 PARTIAL

This page now contains four conceptually different layers:

```text
Internal SSD / Data Lake capacity
        ↓
Physical Disk Health
        ↓
RAID / external member telemetry
        ↓
Backup Jobs / restore verification
```

They must not be conflated.

## 10.1 Capacity

### Status: ✅ PASS

Production browser showed real filesystem values around:
- total ~56.9 GB
- used ~17.1–17.2 GB
- free ~39.7–39.8 GB
- used ~30%

The current capacity visualization separates denominators:
- outer ring = entire filesystem volume
- inner ring = AEGIS-managed data

Tiny positive values remain truthful and are not visually inflated.

## 10.2 Disk Health

### Status: ✅ PASS

Production evidence:
- model: NGFF 2280 128GB SSD
- device: `sda`
- SMART overall: Passed
- temperature observed ~40 °C in accepted browser evidence
- physical device capacity ~119 GB
- bounded disk-health collector + telemetry agent architecture is active

Current production collector pattern:
- `aegis-disk-health.timer` active
- oneshot service runs bounded SMART collection
- evidence file:
  `/var/lib/aegis-disk-health/disk-health.json`
- unprivileged telemetry agent reads the evidence file

## 10.3 RAID

### Status: ✅ UI READY / ⏳ REAL RAID1 DEFERRED

The telemetry-ready RAID UI is deployed and truthfully remains `Not configured` until a real array exists.

Current hardware discovery changed the field plan:
- internal `/dev/sda` = NGFF 2280 128 GB SSD; never use it to fake a second failure domain
- HGST 1 TB USB = existing/shared exFAT disk; now used only as a safe Backup Target under `AEGIS_BACKUP`
- Lexar 32 GB USB = existing/shared device with user data; remains disconnected and unused

**Neither HGST nor Lexar may be erased, formatted, repartitioned, resized, or used as RAID members.**

Therefore real RAID1 is `DEFERRED / FUTURE HARDWARE`.
A future RAID1 acceptance requires two dedicated physical disks whose owner explicitly authorizes erasing. RAID1 remains redundancy, **not backup**.

## 10.4 Backup Agent connection

### Status: ✅ PASS / CLOSED

Host Backup Agent was installed and connected after production deployment.

Verified production state:
- service: `aegis-backup.service` = active/running
- fixed identity: UID/GID `29102`
- socket:
  `/run/aegis-backup/backup.sock`
- socket mode: `0660`
- Drive supplementary group includes `29102`
- Drive mount:
  `/run/aegis-backup:/run/aegis-backup:ro`
- Drive → agent IPC:
  `GET /internal/backup/status` = HTTP 200
- schemaVersion = 1
- engine = restic
- state = `NOT_CONFIGURED`

No TCP backup listener exists.

### Important continuity note

The production runtime Compose file was manually amended to add:
- group `29102`
- read-only `/run/aegis-backup` bind

Runtime compose:
`/opt/aegis/runtime/docker-compose.production.yml`

Backup copy created before the delta:
`/opt/aegis/runtime/docker-compose.production.yml.pre-backup-agent-20260904-201845`

This runtime integration should be treated as a **production configuration fact that must not be accidentally overwritten** by a future compose regeneration.

## 10.5 Backup tools and target

### Status: 🟡 IN PROGRESS

Current session evidence:
- Host Backup Agent remains active with `PrivateDevices=true`.
- HGST target `hgst-usb-1` is mounted at `/mnt/aegis-backup` and registered.
- AEGIS repository path is `/mnt/aegis-backup/AEGIS_BACKUP/aegis-restic`.
- the deployed classifier reports `UNKNOWN / physical-device-unresolved`.
- `restic`, `pg_dump`, and `pg_restore` runtime availability still requires verification before a real job.
- last successful backup = never
- restore verification = not tested

Root cause is confirmed: the deployed classifier starts from host `/dev` paths,
but `PrivateDevices=true` hides those nodes inside the service namespace while
mountinfo `major:minor` and `/sys/dev/block/<major:minor>` remain available.
Commit `a68de6f145d7e0f6935f2a2a0609ca4be432cdff` implements the sysfs-first
resolution path and keeps unresolved evidence fail-closed. Focused target tests
pass 9/9 and the full host backup-agent suite passes 52/52. PR #81 is merged. Controlled Production deployment and real
`DIFFERENT_DEVICE` acceptance are still pending.

Therefore:
- `Back up now` is correctly disabled
- `Verify restore` is correctly disabled
- no real backup-job success may be claimed yet

## 10.6 Schedule / Retention / Automatic schedule

### STORAGE-AUTO-1: ✅ PASS / CLOSED

Browser persistence test passed:
- Schedule changed to `Every 6 hours`
- Retention changed to `Keep 14 daily + 8 weekly + 6 monthly`
- Automatic schedule changed to Enabled
- Refresh preserved the values
- `Next run = Not scheduled` remained truthful because no active target exists

### Safety note — current baseline confirmed

The earlier persistence acceptance temporarily observed `Every 6 hours` with
automatic scheduling enabled and no active target. The current Backup Target
session confirms the fail-safe policy is now:
- `activeTargetId = null`
- Schedule = Disabled
- Automatic schedule = OFF (`enabled=false`)

Keep this baseline until the classifier is merged, deployed, and Production
proves `hgst-usb-1 → DIFFERENT_DEVICE`. Selecting the target is a later,
deliberate gate.

### STORAGE-AUTO-2: ⏳ WAITING

Real automatic backup execution cannot be accepted until:
- target exists
- restic exists
- pg_dump / pg_restore exist
- DB backup role/credentials are configured safely
- first manual backup passes
- integrity passes
- isolated restore verification passes

---

# 11. Audit Log

## Status: ✅ PASS / CLOSED

Accepted:
- audit list works
- filters work
- Result filter defect was fixed
- expected Result choices:
  - All
  - Success
  - Denied
  - Blocked
- Security Activity summary reads caller-owned audit facts
- Vault unlock produced real `VAULT_UNLOCK / OK` evidence

Audit remains append-only from the UI perspective.

---

# 12. Access Control

## Status: ✅ PASS / CLOSED for current scope

Accepted:
- server-side RBAC/provisioning behavior
- current Admin/user management flows used by production
- no need to reopen unless new account-policy controls are added

Keep distinction between:
- application role/access control
- Linux host accounts
- Twingate identity/policy
- network firewall/VLAN policy

They are separate layers.

---

# 13. Settings — full 6.1 breakdown

Settings has five categories:
1. Appearance
2. Account
3. Security & Privacy
4. Storage & Data
5. Administrator

## 13.1 Appearance

### Status: ✅ PASS / CLOSED

Implemented and production-deployed:
- theme preferences
- Classic / Neo **Dual Interface Style**
- style persists per account
- switching style confirms and ends current session only after persistence succeeds
- fresh login resolves the saved style
- Login intentionally remains outside Classic/Neo styling
- Classic remains safe default for missing/invalid style
- Light/Dark remain independent from Classic/Neo

PR #71 introduced the system; later PRs #72/#74 refined and accepted it.

## 13.2 Account

### Status: 🟢 CORE PASS / SOME PROFILE ACCEPTANCE STILL OPTIONAL

Accepted:
- account page reachable
- Change Password functional flow passed previously

Not fully closed by the latest page-level evidence:
- profile/avatar upload/remove has not been re-accepted in the current 6.1 sweep
- if formal full Settings closure is required, perform one small profile/avatar acceptance pass

Do not confuse this with authentication/password reset flows already verified elsewhere.

## 13.3 Security & Privacy

### Overall: ✅ PASS / CLOSED

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| SECURITY-1 Protection Defaults | ✅ PASS / CLOSED | Persisted Vault auto-lock + share defaults accepted |
| SECURITY-2 Vault Auto-lock | ✅ PASS / CLOSED | PR #80 merged/deployed; migration 008 applied; 1-minute measured production acceptance passed |
| SECURITY-3 Sessions | ✅ PASS / CLOSED | Chrome + Edge sessions shown; THIS DEVICE and session controls accepted |
| SECURITY-4 Drive Reachability | ✅ PASS / CLOSED | Authenticated browser → Drive API HTTPS test passed |
| SECURITY-5 Security Activity / Audit | ✅ PASS / CLOSED | Real Vault unlock activity appeared in self-scoped activity and Audit Log |

Current configurable protection defaults remain server/database-owned: Vault auto-lock, default share expiry, default network scope, and require share password.
Session controls preserve the current caller and revoke only other sessions for the same account.
Vault protection remains zero-knowledge: browser/device Argon2id derivation, server-side Vault key = none, server-readable plaintext = no, and no fake recovery phrase generator.

## 13.4 Twingate telemetry inside Security & Privacy

### Local connector runtime: ✅ PASS / CLOSED

PR #79 implemented and Production accepted the bounded local runtime measurement path:

```text
Docker daemon
  → aegis-twingate-health.service (oneshot, fixed connector only)
  → /var/lib/aegis-twingate-health/twingate-health.json
  → aegis-telemetry agent (file read only)
  → /internal/twingate-connector
  → Drive fail-closed validator
  → /api/remote-access
  → Settings
```

Accepted local facts include:
- connector runtime state: Running
- Docker health: Healthy
- restart count: 0 in accepted evidence
- real `Last measured` timestamp
- dedicated host identity: UID/GID 29103
- Drive still receives no Docker socket and no Twingate token/environment

### Twingate control plane: ⚪ NOT MEASURED

Local Docker runtime health does **not** prove the Twingate control plane considers the connector connected. Settings must continue to separate **LOCAL CONNECTOR — measured** from **TWINGATE CONTROL PLANE — Not measured / Unavailable**.
Do not label local container health as `Twingate Online`.

## 13.5 Storage & Data

### Overall: 🟡 PARTIAL

Accepted / closed:
- real Storage overview
- capacity / used / free / reserve / usable bytes
- Disk Health
- truthful RAID `Not configured` standby UI
- Backup Agent connection
- Schedule / Retention persistence
- Automatic-schedule configuration persistence (STORAGE-AUTO-1)

Current safe Backup policy:
- `activeTargetId = null`
- `schedule = disabled`
- `retention = keep-7d-4w`
- `enabled = false`

Waiting:
- classifier source/PR gate CLOSED by PR #81
- controlled Production classifier deployment with `PrivateDevices=true` preserved
- Production `hgst-usb-1 → DIFFERENT_DEVICE` acceptance
- `restic`, `pg_dump`, `pg_restore` runtime verification/install
- dedicated DB backup role/credential verification
- first real manual backup
- repository integrity check
- isolated restore verification
- optional real scheduled execution (STORAGE-AUTO-2)

Real RAID1 is no longer an immediate blocker for the current project acceptance; it is **DEFERRED / FUTURE HARDWARE**. The borrowed/shared HGST can support a manual verified backup target without becoming a RAID member.

## 13.6 Administrator

### Overall: 🟡 PARTIAL — core truthfulness gates accepted, Backup Targets still open

#### Encryption at Rest — ✅ ADMIN-ENC-1 PASS / CLOSED

Accepted production truth:
- Browser-side Private Vault encryption: Active
- Server-side Vault key: None
- Data Lake application-layer encryption: Not configured
- Host filesystem/device encryption: **NOT CONFIGURED**

Read-only host proof found no `TYPE=crypt`, no `crypto_LUKS`, an empty `/etc/crypttab`, no active crypt mappings, an LVM-only dm tree, and the Data Lake on root LVM/ext4.
The UI may say `Not measured` where there is no live encryption telemetry; it must not fabricate LUKS/at-rest protection. This closes the measurement/truthfulness acceptance, not the implementation of disk encryption.

#### Network Zones — ✅ PASS / CLOSED

The application Network Zones workflow is accepted for its real scope: share-policy CIDR metadata and application enforcement. It is **not** MikroTik, UFW or switch configuration.

#### Backup Targets — 🟡 IN PROGRESS

HGST `hgst-usb-1` is mounted and registered through the host-owned allowlist. The PrivateDevices-compatible classifier is merged to repository `main` through PR #81, but the running Production agent has not yet been updated and remains `UNKNOWN / physical-device-unresolved`. This gate closes only when real Production reports `DIFFERENT_DEVICE`.

Therefore the Administrator page as a whole remains PARTIAL only because Backup Targets is not yet production-accepted.

---

# 14. Production host agents / runtime dependencies

## 14.1 Host telemetry

- `aegis-telemetry.service`: active
- user/group: `aegis-telemetry`
- runtime socket:
  `/run/aegis-telemetry/telemetry.sock`
- Drive mount: read-only
- host metrics include CPU, memory, network and uptime
- Disk Health is separately versioned

## 14.2 Disk Health

- `aegis-disk-health.timer`: active/waiting
- `aegis-disk-health.service`: oneshot/static, normally inactive between timer runs
- evidence:
  `/var/lib/aegis-disk-health/disk-health.json`

Inactive oneshot status between runs is normal and is not a failure.

## 14.3 Backup Agent

- `aegis-backup.service`: active
- UID/GID: `29102`
- socket:
  `/run/aegis-backup/backup.sock`
- no TCP listener
- connected to Drive through read-only socket bind
- state: `NOT_CONFIGURED`; HGST target is registered but not active, and the
  deployed classifier remains `UNKNOWN / physical-device-unresolved`

## 14.4 Twingate connector

- container: `twingate-aegis-connector-02`
- local collector: `aegis-twingate-health.service` + timer
- dedicated identity: UID/GID 29103
- accepted local state: Running / Docker health Healthy
- restart count accepted at 0
- Drive consumes sanitized local runtime evidence through the host telemetry agent
- no Docker socket or Twingate credential is exposed to Drive/browser
- Twingate control-plane status remains intentionally NOT MEASURED

## 14.5 Host restart notice

During the 2026-09-05 SSH acceptance session Ubuntu reported:
`System restart required`.

No reboot was performed as part of these acceptance gates.
Treat any future reboot as a separate controlled infrastructure action:
- verify remote access path first
- preserve production rollback/recovery path
- verify all AEGIS services after boot

---

# 15. Backup Target → Backup Job — canonical current sequence

## 15.1 Deploy and accept the merged Backup Target classifier

PR #81 is merged to repository `main@07ad78efdf1561f2a49a1ecc81440359b766b3bd`.
Classifier source commit: `a68de6f145d7e0f6935f2a2a0609ca4be432cdff`.
Verified source tests: **9/9 focused** and **52/52 full**.

Next Production gate:
1. verify Production repository clean/current state
2. fetch `origin` and fast-forward only to current `main`
3. inspect the documented host-backup-agent deployment procedure
4. deploy only the host Backup Agent implementation; preserve `/etc/aegis/backup-agent.json` and credential files
5. preserve `PrivateDevices=true`
6. restart only `aegis-backup.service`
7. require `hgst-usb-1 → DIFFERENT_DEVICE`
8. confirm policy remains `activeTargetId=null`, schedule disabled, retention `keep-7d-4w`, `enabled=false`

## 15.2 Backup Job prerequisites

After target acceptance, safely verify/install `restic`, `pg_dump`, and `pg_restore`; verify/create the dedicated least-privilege PostgreSQL backup identity and root-owned credential material without printing secrets.

## 15.3 Repository + first manual backup

Use only `/mnt/aegis-backup/AEGIS_BACKUP/aegis-restic`. Required lifecycle: `READY → RUNNING → SUCCESS`.

## 15.4 Integrity + isolated restore acceptance

Require repository integrity PASS and restore verification PASS in a safe scratch area without overwriting Production. A manual backup + integrity + isolated restore is sufficient for the borrowed/shared HGST project scope.

## 15.5 Scheduled execution

Permanent automatic scheduling may remain disabled because the HGST may be unplugged. Enable only if scheduler acceptance is deliberately required after manual backup/integrity/restore pass.

## 15.6 Real RAID1

`DEFERRED / FUTURE HARDWARE`. Current HGST/Lexar must not be used as RAID members.

---

# 16. Current known limitations / open work

| Item | Current classification |
| :--- | :--- |
| Public internet/external share gateway | ⚪ NOT IMPLEMENTED |
| Remote high-bitrate Vault preview | ⚪ remote delivery/network-path limitation; not isolated to Twingate alone |
| SECURITY-2 Vault auto-lock | ✅ PASS / CLOSED |
| Twingate local connector runtime telemetry | ✅ PASS / CLOSED |
| Twingate control-plane telemetry | ⚪ NOT MEASURED by current architecture |
| Administrator Encryption at Rest | ✅ ADMIN-ENC-1 PASS / CLOSED; host disk encryption itself is NOT CONFIGURED |
| Administrator Network Zones | ✅ PASS / CLOSED |
| Backup target | 🟡 HGST `hgst-usb-1` mounted/registered; source fix + PR #81 merge CLOSED, Production deployment / `DIFFERENT_DEVICE` pending |
| `restic` | ⏳ runtime verification/install pending |
| `pg_dump` / `pg_restore` | ⏳ runtime verification/install pending |
| Dedicated DB backup role/credential | ⏳ verification/configuration pending |
| Real Backup Job | ⏳ NOT TESTED |
| Integrity check | ⏳ NOT TESTED |
| Restore verification | ⏳ NOT TESTED |
| Real automatic scheduled backup | ⏳ STORAGE-AUTO-2 waiting / optional for borrowed-HGST acceptance |
| RAID hardware | ⏳ DEFERRED / FUTURE HARDWARE |
| RAID host telemetry | ⏳ waits for future real RAID hardware |
| Account profile/avatar latest exhaustive sweep | 🟡 NOT TESTED / optional remaining page-level acceptance |
| Protected Trash 30-day wall-clock auto-purge | ⚪ implementation exists; literal 30-day wait not time-waited |

---

# 17. Highest-priority continuation queue

1. **Production-deploy and accept PR #81 classifier**
   - fast-forward Production repository only
   - deploy host Backup Agent implementation without overwriting config/credentials
   - preserve `PrivateDevices=true`
   - restart only `aegis-backup.service`
   - require `hgst-usb-1 → DIFFERENT_DEVICE`
   - keep target inactive and scheduling disabled until accepted

2. **Complete Backup Job E2E**
   - verify/install `restic`, `pg_dump`, `pg_restore`
   - verify/create dedicated DB backup role and credential path
   - initialize repository only inside `AEGIS_BACKUP/aegis-restic`
   - manual backup → integrity PASS → isolated restore PASS

3. **Optional Settings exhaustive sweep**
   - profile/avatar upload/remove only if formal all-Settings page closure is required

4. **Scheduled backup acceptance, only if deliberately required**
   - do not enable permanently by default for a borrowed/shared removable disk

5. **Real RAID1**
   - DEFERRED until a future dedicated erasable disk pair exists

SECURITY-2, Twingate local runtime telemetry, Administrator Encryption-at-Rest truthfulness, Network Zones, and the Backup Target source/PR integration gate are already closed.

---

# 18. Safety / truthfulness invariants

These rules must survive future work:

- Never fabricate RAID with partitions/LVs/containers on the same physical SSD.
- Never format/wipe/create md array until exact external-device identity is known and erase approval is explicit.
- RAID is not backup.
- Never claim Backup Healthy from configuration alone; require successful jobs and restore evidence.
- Never expose Docker socket to Drive.
- Never expose Twingate tokens/environment to Drive/browser.
- Never call local Docker health `Twingate Online`.
- Never claim filesystem/LUKS encryption without measured evidence.
- Never add a fake Vault recovery phrase.
- Never weaken zero-knowledge boundaries to make Settings look more interactive.
- Never use arbitrary browser-provided host paths/commands for Backup or telemetry.
- Production deployment remains Drive-only for IDEA1 changes unless a gate explicitly requires another service.
- Do not use `docker compose down`, `down -v`, destructive prune or production-volume deletion for normal updates.
- Use real CA validation; do not use `curl -k`.

---

# 19. Important production paths

```text
Repository
/opt/aegis/Project-End-The-AEGIS

IDEA1
/opt/aegis/Project-End-The-AEGIS/IDEA1-AEGIS_Drive_LC

Protected env
/opt/aegis/Project-End-The-AEGIS/.env
root:root 600

Runtime compose
/opt/aegis/runtime/docker-compose.production.yml

AEGIS CA
/opt/aegis/Project-End-The-AEGIS/scripts/endpoint-onboarding/certificates/aegis-root-ca.crt

Data Lake Docker volume source
/var/lib/docker/volumes/aegis_drive_storage/_data

Host telemetry
/run/aegis-telemetry/telemetry.sock

Backup agent
/run/aegis-backup/backup.sock

Disk-health evidence
/var/lib/aegis-disk-health/disk-health.json

Planned external/RAID backup mount
/mnt/aegis-backup
```

Production addresses:
- gateway/HUB host: `192.168.10.10`
- Drive: `192.168.10.11`
- Monitor: `192.168.10.12`
- MQTT: `192.168.10.13`
- Drive URL: `https://aegis.internal/drive/`

---

# 20. What can currently be called "finished"

Safe to call completed for the recorded acceptance scope:

- Dashboard
- Files
- Private Vault tested scope
- Secure Shares private/internal scope
- File History
- Protected Trash functional/manual workflow
- Audit Log
- Access Control
- Dual Interface Style / Appearance
- Change Password
- Settings → Security & Privacy, including SECURITY-2
- Session management
- Current Drive reachability
- Security Activity / Audit
- Twingate local connector runtime telemetry
- Storage capacity
- Disk Health
- RAID telemetry-ready **UI only**
- Backup Agent **connection only**
- Backup schedule/retention configuration **persistence only** (STORAGE-AUTO-1)
- Administrator → Encryption at Rest truthfulness/measurement
- Administrator → Network Zones
- Backup hardware discovery / preservation audit / safe HGST mount / target registration
- Backup classifier root-cause investigation
- PrivateDevices-compatible classifier source fix + 9/9 focused + 52/52 full tests
- feature commit / remote branch / local tracking repair
- Backup Target PR #81 review/merge into repository main

Do **not** call these finished yet:
- complete Settings page as one whole (Backup Targets + optional profile/avatar boundary remain)
- Backup Target overall
- Backup protection / Backup Job end-to-end
- integrity / restore verification
- automatic scheduled backup end-to-end
- real RAID1
- Twingate control-plane monitoring
- public external sharing

---

# 21. Resume statement for a future chat

> IDEA1 current reconciliation is 2026-09-06. Production Drive source remains
> `2806373bb300728a0babb953a63f98bcd714ffef` (PR #80). PR #81 merged the
> PrivateDevices-compatible Backup Target classifier at milestone
> `07ad78efdf1561f2a49a1ecc81440359b766b3bd`; resolve the live repository head
> from Git because later documentation-only commits may advance `main`. PR #79 local Twingate
> runtime telemetry and PR #80 Vault auto-lock are deployed/accepted; SECURITY-2,
> local Twingate telemetry, Administrator Encryption-at-Rest truthfulness and
> Network Zones are PASS/CLOSED. Twingate control-plane telemetry remains NOT MEASURED.
>
> Storage & Backup is the active workstream. HGST target `hgst-usb-1` is safely
> mounted/registered and policy remains disabled/no active target. The source fix
> is merged, but the running Production Backup Agent still uses the old classifier
> and reports `UNKNOWN / physical-device-unresolved`. Next: fast-forward Production,
> deploy only the host Backup Agent code, preserve `PrivateDevices=true`, restart
> only `aegis-backup.service`, and require `DIFFERENT_DEVICE`.
>
> Then finish restic/PostgreSQL backup tooling, dedicated DB backup identity,
> first manual backup, integrity and isolated restore. Real RAID1 is DEFERRED;
> never erase/reformat/repartition current HGST or Lexar.

## Related

- [[idea1/idea1-status]]
- [[idea1/idea1-moc]]
- [[concepts/Large_File_Transfer_V2]]
- [[concepts/Honest_Telemetry_and_Unavailable_States]]
- [[90-Status/Open-Items-Backlog]]
