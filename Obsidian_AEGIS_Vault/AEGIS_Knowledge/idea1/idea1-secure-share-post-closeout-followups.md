---
title: IDEA1 Secure Share — Post-Closeout Follow-ups
tags: [aegis, idea1, secure-share, public-share, file-types, large-file, performance, backlog]
type: status
status: planned-followups
created: 2026-09-16
updated: 2026-09-16
owner: kla
edit_policy: owner-writable
---

# IDEA1 Secure Share — Post-Closeout Follow-ups

## 1. Closure boundary

PUBLIC-SHARE-7 remains **CLOSED / ACCEPTED**. PR #141 was human-reviewed and merged into `main` as merge commit `721b797860063729b7c3c280161dcb908d0ff7f5`.

This note does **not** reopen S5.8-S5.12, G6, the Public Share rollout, Cloudflare, Gateway isolation, UI activation, or the accepted external/private lifecycle evidence. It records only new post-closeout acceptance targets and performance questions discovered after closure.

Latest owner-observed Production System Test Phase 1 after the merge is **PASS** for the tested scope:

- login
- Dashboard
- Files listing
- Files upload
- download byte/content match
- `any` share create
- `any` share redeem
- `any` share revoke
- post-revoke denial
- Public Internet scope selectable
- Private Vault page/workflow smoke
- Settings page/workflow smoke

No anomaly was reported in that Phase 1 sweep.

## 2. Secure Share file-type coverage — new acceptance target

### Current source behavior

Secure Share/Public Share redemption is file-type agnostic at the delivery layer. The share route streams the stored file as `application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`; share creation is driven by `fileId`, not by a text-only MIME allow-list.

Therefore this is **not currently classified as a missing implementation for image/video extensions**. The new work is to obtain representative Production acceptance evidence before the Final Project report claims non-text coverage.

### New acceptance ID

`SECURE-SHARE-FILETYPE-1`

State: **PLANNED / NOT YET ACCEPTED**

Minimum representative matrix:

| Class | Example | Required lifecycle |
| :--- | :--- | :--- |
| Image | `.jpg` or `.png` | create share -> redeem -> download -> exact size/hash -> revoke -> post-revoke blocked |
| Video | `.mp4` | create share -> redeem -> download -> exact size/hash -> revoke -> post-revoke blocked |

Optional secondary evidence may include PDF and archive/binary files, but those are not required to establish the image/video requirement.

### Claim boundary

After this matrix passes, the report may state:

> Secure Share is file-type agnostic by design and representative non-text image/video files were successfully shared and downloaded with integrity preservation.

Do **not** claim that every possible file extension in existence was individually tested.

This acceptance is a **download/share lifecycle** test. Inline media preview through the anonymous share page is not part of this requirement and must not be silently added to the scope.

## 3. Files / Private Vault large-transfer boundary — separate from Secure Share

Large-file upload/download/preview performance belongs to the Files and Private Vault transfer subsystem. It is **not a blocker for the already-closed Secure Share rollout** and must remain a separate workstream.

### Fresh owner observation — 11.0 GB Files upload

On 2026-09-16 the Production Files upload UI rejected an approximately **11.0 GB `.mp4`** before transfer with the explicit message:

`Larger than the upload limit this system is configured for — this file was not sent.`

Classification:

- **CONFIRMED configured-size rejection** for that 11.0 GB attempt.
- The file was not sent, so this observation is not evidence of a Twingate throughput failure.
- It is not evidence of a Google/Google Drive limitation.
- It does not prove storage or browser failure.
- The effective Production `MAX_LOGICAL_FILE_BYTES` value was not re-measured by this docs-only task and must not be invented from the screenshot.

### Source limits relevant to later investigation

The current LFT-V2 source separates chunk size from logical file size:

- default `UPLOAD_CHUNK_SIZE_BYTES` = 16 MiB, allowed 8-64 MiB;
- default `MAX_LOGICAL_FILE_BYTES` = 5 GiB;
- source-supported configuration range for one logical file extends up to 32 GiB;
- source comments require additional commit-route timeout budgeting when deployments raise the logical ceiling beyond roughly 8 GiB.

These source capabilities are not the same as Production acceptance. Raising the limit is a future deployment decision and requires storage-capacity, timeout, integrity, interruption, and rollback evidence.

## 4. Transfer performance question — future benchmark before optimization

Owner observation: multi-gigabyte uploads that are within the configured limit can complete but may feel slow. No current evidence isolates the bottleneck to Twingate, Wi-Fi, browser hashing/encryption, server disk I/O, HTTP framing, or another layer.

New backlog ID: `LFT-PERF-1`

State: **PLANNED / NOT A BLOCKER FOR SECURE SHARE CLOSEOUT**

Required benchmark before changing architecture or installing any additional service/plugin:

1. Use the same deterministic file on direct wired LAN, local Wi-Fi, and remote Twingate paths.
2. Record effective upload/download throughput, elapsed time, retry/resume behavior, and failure point.
3. Measure host disk write/read throughput during the transfer.
4. Observe Drive/container CPU and memory during client hashing, upload, commit hashing, and download.
5. Record whether the Twingate path is direct or relayed when that evidence is available; do not infer it from speed alone.
6. Compare chunk size, request concurrency, RTT, and commit duration before proposing tuning.
7. Re-test integrity with SHA-256 after every performance change.

Only after measurement should later work consider options such as chunk-size tuning, safe parallel chunk transfer, direct-LAN routing for on-site users, timeout tuning for larger logical files, or other transport optimizations. Video/image compression is not a generic fix because already-compressed media often gains little and changes file integrity/semantics.

A comparison with Google Drive is not a like-for-like benchmark: hyperscale storage/CDN/backbone capacity, geographic edge placement, protocol tuning, and server resources differ substantially. The useful question for AEGIS is which local layer is the measured bottleneck and what improvement is justified without weakening the security boundary.

## 5. Follow-up task separation

| Work item | Current state | Reopens PUBLIC-SHARE-7? |
| :--- | :--- | :--- |
| PUBLIC-SHARE-7 / S5.8-S5.12 rollout | **CLOSED / ACCEPTED / MERGED** | No — already closed |
| `SECURE-SHARE-FILETYPE-1` image/video representative acceptance | **PLANNED** | No |
| `LFT-PERF-1` upload/download/preview benchmark | **PLANNED** | No |
| 11 GB+ Production logical-file enablement | **NOT AUTHORIZED / FUTURE** | No |
| 20-30 GB real transfer acceptance | **NOT TESTED / NOT CLAIMED** | No |

## 6. Safety / change boundary for this note

This is documentation/backlog reconciliation only.

- `PRODUCTION_MUTATION_PERFORMED=NO`
- `CLOUDFLARE_MUTATION_PERFORMED=NO`
- `RUNTIME_CODE_CHANGED=NO`
- `UPLOAD_LIMIT_CHANGED=NO`
- `SHARE_BEHAVIOR_CHANGED=NO`
- `OLD_FINAL_RECEIPTS_EDITED=NO`

The next executable task, if approved, should be `SECURE-SHARE-FILETYPE-1` using representative image and video files already safe to place in the test account. Performance/large-file tuning should be planned independently after measured benchmarking.