---
title: Task Receipt — IDEA1 on-site file/share acceptance
date: 2026-09-02T20:20:00+07:00
owner: kla
area: idea1
branch: docs/idea1-onsite-acceptance-20260902
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 on-site file/share acceptance

## Scope

Record only the production/on-site acceptance evidence collected for IDEA1 AEGIS Drive file handling, Private Vault preview/integrity, and secure-share network scope. This receipt does not change runtime configuration or claim completion for tests that were not directly observed.

## Verified field results

### Direct VLAN30 path

- Laptop Ethernet: `192.168.30.10`
- Gateway: `192.168.30.1`
- AEGIS destination: `192.168.10.10:443`
- `Test-NetConnection`: `InterfaceAlias=Ethernet`, `SourceAddress=192.168.30.10`, `TcpTestSucceeded=True`
- HTTPS health over forced direct interface: HTTP 200
- Result: **PASS**

### Vault high-bitrate preview — START_LIVE.mp4

- Size: approximately 1.1 GB
- Duration: approximately 2 minutes
- First frame: approximately 8 s
- Continuous playback: more than 60 s
- Buffering/stutter during continuous play: none observed
- Seek approximately 0:30 → 1:18: approximately 5 s transition, approximately 3 s loading, then playback resumed
- Virtual media response: HTTP 206
- Ciphertext chunks: HTTP 200, approximately 16.8 MiB
- Result: **PASS on direct VLAN30**

### Vault large-normal preview — 323 MB / 17:48

- First frame: approximately 45–48 s
- Continuous playback 60 s: PASS
- Buffering/stutter: none observed
- Seek 1:09 → 6:30: approximately 1–2 s
- Seek 8:40 → 15:30: approximately 6 s
- Repeated short seeks: PASS
- Result: **FUNCTIONAL PASS with startup-latency note**

### Direct VLAN30 ciphertext throughput

- 1 parallel: 16.00 MiB / 1.57 s = **10.17 MiB/s**
- 2 parallel: 32.00 MiB / 3.04 s = **10.53 MiB/s**
- 4 parallel: 64.00 MiB / 6.12 s = **10.46 MiB/s**

Previous controlled remote-path evidence was approximately 4.65 / 4.22 / 4.26 MiB/s for 1/2/4 parallel fetches. The accepted conclusion is a **remote delivery-environment/network-path limitation**. Twingate alone was not isolated as the sole cause.

### Vault deterministic integrity round trip

- Plaintext size: 2,097,152 bytes
- Expected/pre-upload SHA-256: `91d3beb88a9b2f778a6c44a1c53b63d3c79931845a9aef84b3fb414610bd1938`
- Upload: PASS
- Download/decrypt: PASS
- Recovered size: 2,097,152 bytes
- Recovered SHA-256: exact match
- Result: **VAULT_2MIB_SHA256=PASS**

### Restricted secure share

Configured application network zone:

- `Management VLAN30 = 192.168.30.0/24`

Positive case:

- client source `192.168.30.10`
- same restricted share opened successfully
- file downloaded successfully
- redemption/hit counter incremented
- Result: **VLAN30 ALLOW = PASS**

Negative case:

- temporary local route/hosts override removed
- Twingate path restored
- `aegis.internal = 100.96.97.113`
- Twingate source `100.127.255.172`
- same restricted share returned “This link is restricted … outside that range”
- file download denied
- Result: **OUTSIDE-ZONE DENY = PASS**

## Highlighted acceptance conclusions for report

1. **Secure Share** — highlight because both positive and negative network-policy behavior were demonstrated with the same real link: VLAN30 allowed, outside-zone/Twingate denied.
2. **Private Vault upload/integrity** — highlight because deterministic SHA-256 proves byte-for-byte recovery through browser-side encryption and decryption.
3. **Large encrypted preview** — highlight because the same ~1.1 GB high-bitrate file failed sustained playback on the remote path but passed >60 s without buffering on direct VLAN30; the limitation is therefore classified at the remote delivery/network-path level, not as a demonstrated crypto/preview/local-hardware failure.
4. **Direct throughput** — highlight the measured ~10.4 MiB/s direct result versus ~4.3 MiB/s remote result because it explains the observed playback difference with measured evidence.
5. **Normal file** — existing upload/UI production acceptance remains PASS, but the current deterministic 1 MiB R2 upload→download→SHA-256 round trip is still pending and must not be promoted to PASS.

## Explicit non-claims / remaining item

- Do not claim Twingate alone is the root cause of remote preview performance.
- Do not claim the 323 MB startup delay is caused by MP4 moov placement; that remains a hypothesis only.
- Do not mark the dedicated current-session normal-file R2 round trip PASS until upload, download, and SHA-256 comparison are directly observed.
- For a final >1 GiB storage-handling closure, upload + download + integrity/hash are sufficient storage acceptance criteria; preview is a separate performance capability.
