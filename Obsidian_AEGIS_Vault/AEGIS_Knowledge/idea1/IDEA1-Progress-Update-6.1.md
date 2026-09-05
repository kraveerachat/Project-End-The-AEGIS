---
title: IDEA1 Progress Update 6.1
aliases: ["IDEA1 6.1", "AEGIS Drive LC Progress 6.1"]
tags: [aegis, idea1, progress, production, acceptance, storage, backup, raid, settings, twingate]
type: status-snapshot
created: 2026-09-05
updated: 2026-09-06
owner: kla
edit_policy: owner-writable
application_source_baseline_sha: 46573ed8dd17631f9f746de3f9c7a5f71da1a03b
production_drive_sha: 46573ed8dd17631f9f746de3f9c7a5f71da1a03b
progress_update_merge_pr: 77
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

- Application/runtime source baseline merged by PR #76: `46573ed8dd17631f9f746de3f9c7a5f71da1a03b`
- Production source on `aegis-system`: `46573ed8dd17631f9f746de3f9c7a5f71da1a03b`
- PR #77 is documentation-only and advances repository `main` without changing IDEA1 runtime code; therefore repository `main` may be ahead of the deployed application SHA by documentation commits and this is not deployment drift.
- Drive production image after PR #75/#76 deploy:
  `sha256:78b84a53f3a1b74254601ebd6cae472c765092e4bf607f83f94fa911d197adff`
- Previous Drive image preserved as rollback tag:
  `aegis-prod-drive:rollback-pre-46573ed-20260904-191542`
- Drive, HUB, Monitor และ PostgreSQL health checks passed after Drive-only recreate.
- HTTPS production probe passed with real AEGIS CA:
  `HTTP 200`, `TLS_VERIFY=0`.
- Production repository was clean before deployment and was fast-forwarded only; no rebase/force/pull workflow was used.

## 1.2 Important merged PR chain

| PR | Purpose | Merge SHA | State |
| :--- | :--- | :--- | :--- |
| #70 | truthful Audit / Trash / Capacity / RAID / Backup states | `0030121...` | ✅ merged |
| #71 | Dual Interface Style: Classic / Neo | `b652e384...` | ✅ merged |
| #72 | Neo drawer/capacity follow-up | `9c37ac1e...` | ✅ merged |
| #73 | functional Settings: Security, Storage, Administrator | `d06b9436...` | ✅ merged |
| #74 | capacity + Settings acceptance follow-up | `4c1fe76e...` | ✅ merged / deployed |
| #75 | RAID telemetry-ready hardware UI | `d08a5a57...` | ✅ merged / deployed |
| #76 | CapacityRing regression-test false positive fix | `46573ed8...` | ✅ merged / deployed |

Latest complete test evidence associated with #76:
- **966 total**
- **899 pass**
- **0 fail**
- **67 PostgreSQL-gated skips**
- Vite production build PASS
- governance checks PASS
- no `npm audit fix` was applied automatically

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

# 3. Master page acceptance matrix — Update 6.1

| Screen | 6.1 status | Evidence / remaining boundary |
| :--- | :--- | :--- |
| Dashboard | ✅ **PASS / CLOSED** | Authenticated production dashboard and real telemetry already accepted. Re-test only if telemetry contracts/runtime change. |
| Files | ✅ **PASS / CLOSED** | Normal upload workflow passed; deterministic 1 MiB upload → download SHA-256 exact match passed. |
| Private Vault | ✅ **PASS / CLOSED (tested scope)** | 2 MiB zero-knowledge round trip exact hash passed; ~323 MB and ~1.1 GB direct-VLAN preview/playback accepted. Remote high-bitrate path limitation remains documented. |
| Secure Shares | ✅ **PASS / CLOSED (private/internal)** | Password, wrong-password denial, no-password, copy, restricted VLAN30 allow and outside-zone deny passed. Public external share remains ⚪ not implemented. |
| File History | ✅ **PASS / CLOSED** | Multiple real per-file versions retained; history and non-destructive restore accepted. This is not filesystem snapshotting. |
| Trash | ✅ **PASS / CLOSED** | Soft delete, protected unlock, 30-day UI policy, restore and permanent delete passed. Auto-purge worker exists but a literal 30-day wait was not time-waited. |
| Storage & Backup | 🟡 **PARTIAL** | Capacity + Disk Health + RAID standby UI + Backup Agent connection + policy persistence passed. HGST target mount/registration and classifier source fix passed; PR/deployment/Production `DIFFERENT_DEVICE`, real RAID, backup tools, real backup, integrity and restore verification remain. |
| Audit Log | ✅ **PASS / CLOSED** | Production list/filter behavior accepted; result filter defect closed. Result values are All / Success / Denied / Blocked. |
| Access Control | ✅ **PASS / CLOSED** | RBAC/provisioning and page workflow accepted for current scope. |
| Settings | 🟡 **PARTIAL** | Appearance and major Security/Storage subflows pass. SECURITY-2 small defect, Administrator production acceptance and full Backup/RAID integration remain. |

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

### SECURITY-2 remaining defect

The Vault auto-lock timer consumes the account setting correctly in source, but the post-lock copy is still hard-coded:

`Vault re-locked after 10 minutes of inactivity.`

Therefore the current state is:

- timer/settings integration: implemented
- user selected 5 minutes: accepted as a valid stored value
- message after auto-lock: ❌ can still say 10 minutes regardless of actual setting
- requested 1-minute test option: **not implemented yet**

Planned fix:
1. add `1` to frontend choices
2. add `1` to server validation
3. add a **new migration after 007** that changes the PostgreSQL CHECK constraint; do not rewrite deployed migration 007
4. make auto-lock copy dynamic in EN/TH/ZH
5. production-test with a measured 1-minute idle window
6. restore intended production value after test

Current DB/server accepted values remain:
`5 / 10 / 15 / 30 / 60` minutes until that new change is merged/deployed.

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

### Status: ⏳ UI READY / REAL ARRAY NOT CONFIGURED

PR #75 added the telemetry-ready RAID hardware UI and it is deployed.

Current browser state before hardware:
- `Not configured`
- Physical member 1: `Waiting for telemetry`
- Array Core: `Not configured`
- Physical member 2: `Waiting for telemetry`

This is correct and truthful.

### Critical rule

**Do not fake RAID using two partitions/LVs/containers on the same internal SSD.**

The intended demo architecture is:

```text
Internal SSD (primary Data Lake)
        ↓ real backup
USB/External Drive A ─┐
                      ├─ Linux mdadm RAID1 → /dev/md0
USB/External Drive B ─┘
        ↓
/mnt/aegis-backup
```

Before any `mdadm --create`, `wipefs`, partitioning or `mkfs`:
- discover exact model/serial/by-id
- confirm both are separate physical devices
- confirm they are not `/dev/sda`
- receive explicit authorization that both devices may be erased

RAID1 is redundancy, **not backup**.

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
pass 9/9 and the full host backup-agent suite passes 52/52. Pull Request
review/merge, deployment, and real Production `DIFFERENT_DEVICE` acceptance are
still pending.

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

### Overall: 🟡 ALMOST CLOSED

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| SECURITY-1 Protection Defaults | ✅ PASS | Persisted Vault auto-lock + share defaults accepted |
| SECURITY-2 Vault Auto-lock | ❌ small UI-copy defect / 1-min option pending | Timer consumes setting, but success copy hard-codes 10 minutes |
| SECURITY-3 Sessions | ✅ PASS | Chrome + Edge sessions shown simultaneously; THIS DEVICE correct; session controls visible |
| SECURITY-4 Drive Reachability | ✅ PASS | Authenticated Drive API PASS over HTTPS |
| SECURITY-5 Security Activity / Audit | ✅ PASS | Last Vault unlock updated and `VAULT_UNLOCK / OK` appeared in Audit |

### Protection Defaults

Real configurable fields:
- Vault auto-lock
- default share expiry
- default network scope
- require share password

These are per-account server/database settings, not browser-only decoration.

### Session management

Production browser acceptance showed:
- Chrome · Windows = current device
- Edge · Windows = second active session
- individual `Sign out`
- `Sign out other sessions`

The backend contract preserves the caller and revokes other sessions for the same account only.

### Current Drive reachability

`Test current connection` measures:
**this browser → authenticated Drive API over its current connection**.

It is **not** a Twingate connector health check.

### Vault protection / recovery

Truthful architecture:
- Zero-knowledge
- browser/device Argon2id derivation
- server-side vault key = none
- server-readable plaintext = no
- server-assisted recovery = disabled/not supported

Do not add a fake recovery phrase generator.

## 13.4 Twingate telemetry inside Security & Privacy

### Current UI: ⚪ truthful but incomplete measurement

Current Settings correctly says:
- Channel = Twingate
- Connector telemetry = Not measured
- Live connector state = Unavailable

This is **not currently a failure**, because Drive does not yet ingest connector runtime/control-plane telemetry.

### TWIN-0 read-only discovery: ✅ PASS

Production connector:
- name: `twingate-aegis-connector-02`
- image: `twingate/connector:1`
- state: running
- Docker health: healthy
- restart count: 0
- healthcheck configured
- bridge network

### TWIN-1 integration preflight: ✅ PASS

Verified:
- `aegis-telemetry.service` active
- telemetry socket present
- Drive telemetry bind is read-only
- existing disk-health collector pattern available for reuse
- Twingate container has real local Docker health evidence

### TWIN-2 onward: ⏳ PENDING IMPLEMENTATION

Planned design:
- bounded host oneshot collector inspects only fixed connector name
- writes sanitized JSON evidence
- long-running telemetry agent reads only that file
- new versioned Unix-socket route, separate from telemetry V1
- Drive validates fail-closed
- Settings separates:
  - **Local connector runtime health** — measurable
  - **Twingate control-plane status** — still Not measured unless a future authenticated control-plane integration is built

Never:
- mount `/var/run/docker.sock` into Drive
- give browser Docker control
- expose Twingate environment/token
- label local Docker health as `Twingate Online`

Desired future display:

```text
LOCAL CONNECTOR
Runtime state       Running
Docker health       Healthy
Restart count       0
Last measured       <real timestamp>

TWINGATE CONTROL PLANE
Telemetry           Not measured
Live state          Unavailable
```

## 13.5 Storage & Data

### Overall: 🟡 PARTIAL

Accepted:
- real Storage overview
- capacity / used / free / reserve / usable bytes
- Disk Health
- truthful RAID Not configured
- Backup Agent Connected
- Schedule/Retention persistence
- Automatic-schedule configuration persistence

Waiting:
- actual RAID hardware/telemetry
- Backup Target classifier PR review/merge
- controlled classifier deployment with `PrivateDevices=true` preserved
- Production `hgst-usb-1 → DIFFERENT_DEVICE` acceptance
- backup tools
- manual backup
- integrity
- restore verification
- actual scheduled backup execution

## 13.6 Administrator

### Status: 🟡 PRODUCTION PAGE ACCEPTANCE PENDING

The redesign intentionally separates read-only system facts from controls.

Current implemented surfaces include:
- Encryption posture
- Network Zones / share-policy metadata
- Backup Targets / host-owned integration state
- links to Audit and Access Control

Important truth boundaries:
- Vault zero-knowledge encryption is distinct from Data Lake at-rest encryption
- no fake server master-key rotation
- filesystem/LUKS state must not be guessed
- Network Zones are application share-policy metadata; they are not MikroTik/UFW configuration
- Backup Targets must come from the host agent allowlist, not arbitrary browser paths

A dedicated Administrator production acceptance pass is still needed before declaring **all Settings = CLOSED**.

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
- local state observed: running/healthy
- restart count observed: 0
- current Drive UI still does not consume this evidence
- TWIN-2 implementation is required before the UI may display local connector health

## 14.5 Host restart notice

During the 2026-09-05 SSH acceptance session Ubuntu reported:
`System restart required`.

No reboot was performed as part of these acceptance gates.
Treat any future reboot as a separate controlled infrastructure action:
- verify remote access path first
- preserve production rollback/recovery path
- verify all AEGIS services after boot

---

# 15. RAID → Backup pipeline — canonical next sequence

Do this in order.

## RAID-0 — Hardware discovery, read-only

After both external drives are inserted:
- `lsblk`
- model
- serial
- size
- filesystem
- mount points
- transport
- `/dev/disk/by-id`
- `blkid`
- `/proc/mdstat`
- mdadm availability

No write/destructive command.

## RAID-1 — Erase authorization

Explicitly identify both devices and receive confirmation that both may be erased.

## RAID-2 — Create real RAID1

Use two distinct physical devices.
Expected result: Linux md array such as `/dev/md0`.

## RAID-3 — Filesystem + persistent mount

Target mount:
`/mnt/aegis-backup`

Use stable UUID/by-id metadata, not transient `/dev/sdb` assumptions.

## RAID-4 — Failure/recovery acceptance

- healthy 2/2
- controlled member removal → DEGRADED 1/2
- data remains readable
- re-add member → recovering/resyncing
- finish → healthy 2/2

## RAID-5 — Host RAID telemetry

Implement bounded host collection and sanitized telemetry.
The PR #75 UI is ready to consume future data but the current backend still needs real RAID telemetry integration.

## BACKUP-3 — Install tools

Install/verify:
- restic
- pg_dump
- pg_restore

## BACKUP-4 — Dedicated PostgreSQL backup identity

Use dedicated least-privilege backup role and root-owned credential material.
Do not depend permanently on a transient container IP without a stable connection design.

## BACKUP-5 — Register and accept an allowlisted target

HGST target `hgst-usb-1` is registered in the root-owned Backup Agent config.
Its source classifier fix is verified but not yet merged or deployed, so this
gate remains open until Production reports `DIFFERENT_DEVICE` with
`PrivateDevices=true` still enabled.

Accepted classification:
- `DIFFERENT_DEVICE` or `OFF_HOST` = acceptable
- `SAME_FAILURE_DOMAIN`, `UNKNOWN`, or `NOT_MOUNTED` = not acceptable as protected backup

## BACKUP-6 — Browser configuration

Select target, retention and intended schedule through the values published by the agent.

## BACKUP-7 — First real manual backup

Run `Back up now`.
Required lifecycle:
`READY → RUNNING → SUCCESS`.

## BACKUP-8 — Integrity + isolated restore verification

- integrity check = PASS
- restore into safe scratch area
- never overwrite production during acceptance
- restore verification = PASS

## BACKUP-9 — Enable actual schedule

Only after manual backup + integrity + restore pass:
- choose intended schedule
- enable automatic schedule
- observe at least one scheduler-triggered real job

Only then close:
`STORAGE-AUTO-2 = PASS`.

---

# 16. Current known limitations / open defects

| Item | Current classification |
| :--- | :--- |
| Public internet/external share gateway | ⚪ NOT IMPLEMENTED |
| Remote high-bitrate Vault preview | ⚪ remote delivery/network-path limitation; not isolated to Twingate alone |
| Vault auto-lock success text | ❌ hard-coded 10-minute copy; dynamic copy pending |
| 1-minute Vault auto-lock option | ⏳ requested; requires frontend + server + new DB migration |
| RAID hardware | ⏳ not configured |
| RAID host telemetry | ⏳ not implemented/deployed yet |
| Backup target | 🟡 HGST `hgst-usb-1` mounted and registered; source fix PASS, PR/deployment/Production `DIFFERENT_DEVICE` acceptance pending |
| restic | ⏳ missing |
| pg_dump / pg_restore | ⏳ missing |
| Real Backup Job | ⏳ not tested |
| Integrity check | ⏳ not tested |
| Restore verification | ⏳ not tested |
| Real automatic scheduled backup | ⏳ STORAGE-AUTO-2 waiting |
| Twingate local connector telemetry in Drive UI | ⏳ TWIN-2 implementation pending |
| Twingate control-plane telemetry | ⚪ Not measured by design/current architecture |
| Administrator Settings page | 🟡 production acceptance pending |
| Account profile/avatar current-sweep acceptance | 🟡 optional remaining page-level acceptance |
| Protected Trash 30-day wall-clock auto-purge | ⚪ implementation exists; literal 30-day wait not time-waited |

---

# 17. Highest-priority continuation queue

If resuming from a new chat/session, use this order unless hardware availability changes.

1. **SECURITY-2 patch**
   - dynamic Vault auto-lock copy
   - add 1-minute option through all layers
   - new migration after 007
   - tests + PR + deploy + measured 1-minute acceptance

2. **Finish Backup Target classifier gate**
   - create/review/merge `fix/backup-target-private-dev-classification`
   - fast-forward Production main only
   - preserve config, credentials and `PrivateDevices=true`
   - restart only `aegis-backup.service`
   - require `hgst-usb-1 → DIFFERENT_DEVICE`
   - keep `activeTargetId=null`, schedule disabled and `enabled=false` until accepted

3. **Administrator Settings production acceptance**
   - encryption posture truth
   - Network Zones
   - host-owned Backup Target surface
   - Admin links / RBAC visibility

4. **TWIN-2 local connector telemetry implementation**
   - bounded collector
   - sanitized evidence
   - telemetry route
   - Drive validator
   - Settings UI
   - no control-plane overclaim

5. **RAID hardware field work**
   - two external devices
   - read-only discovery
   - explicit erase approval
   - mdadm RAID1
   - failure/resync acceptance
   - RAID telemetry

6. **Backup completion**
   - tools
   - DB backup role
   - allowlisted RAID target
   - manual backup
   - integrity PASS
   - restore verification PASS
   - scheduled-job acceptance

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

At Update 6.1, the following high-level IDEA1 areas are safe to refer to as completed for their recorded acceptance scope:

- Dashboard
- Files
- Private Vault tested scope
- Secure Shares private/internal scope
- File History
- Protected Trash manual workflow
- Audit Log
- Access Control
- Dual Interface Style / Appearance
- Change Password
- Security Protection Defaults
- Session management
- Current Drive reachability
- Security Activity / Audit
- Storage capacity
- Disk Health
- RAID telemetry-ready **UI only**
- Backup Agent **connection only**
- Backup schedule/retention configuration **persistence only**

Do **not** call these finished yet:
- complete Settings page as one whole
- RAID system
- Backup protection
- Backup Job end-to-end
- automatic scheduled backup end-to-end
- Twingate local telemetry UI integration
- Twingate control-plane monitoring
- public external sharing

---

# 21. Resume statement for a future chat

Use the following compact statement when opening a new session:

> IDEA1 Update 6.1 is the current handoff. The deployed IDEA1 application baseline is
> `46573ed8dd17631f9f746de3f9c7a5f71da1a03b` (PR #76); documentation-only PR #77 may place repository `main` ahead of that SHA without requiring a Drive redeploy.
> Ten-screen acceptance is largely closed; Storage & Backup and Settings retain
> open integration work. Backup Agent is already connected over
> `/run/aegis-backup/backup.sock`. HGST target `hgst-usb-1` is mounted and
> registered, but Production still reports `UNKNOWN / physical-device-unresolved`
> under `PrivateDevices=true`. Source commit `a68de6f...` fixes resolution through
> mountinfo `major:minor` and `/sys/dev/block`; tests pass 9/9 focused and 52/52
> full, while PR review/merge, Production deployment, and real
> `DIFFERENT_DEVICE` acceptance remain pending. Backup tools/credentials and the
> first real backup/integrity/restore run remain unverified.
> RAID UI is deployed but no real array exists. TWIN-0/TWIN-1 proved the local
> Twingate connector is running/healthy and the host telemetry architecture is
> ready; TWIN-2 implementation is pending. SECURITY-2 still needs dynamic
> auto-lock copy plus the requested 1-minute option. Administrator Settings still
> needs production acceptance. Follow the RAID→Backup pipeline in this note and
> do not perform destructive disk actions without exact device identity and
> explicit erase approval.

## Related

- [[idea1/idea1-status]]
- [[idea1/idea1-moc]]
- [[concepts/Large_File_Transfer_V2]]
- [[concepts/Honest_Telemetry_and_Unavailable_States]]
- [[90-Status/Open-Items-Backlog]]
