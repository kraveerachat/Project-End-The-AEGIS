---
title: Task Receipt — IDEA1 on-site file/share acceptance
date: 2026-09-02T20:20:00+07:00
owner: kla
area: idea1
branch: docs/idea1-onsite-acceptance-20260902
status: complete
integration-review: no
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 on-site file/share acceptance

## What changed

- Recorded the on-site IDEA1 acceptance evidence for the direct Management VLAN30 path, Private Vault preview/integrity, and restricted Secure Share network scope.
- Recorded the same-link positive/negative Secure Share result: VLAN30 client allowed and the Twingate/outside-zone path denied.
- Recorded the deterministic 2 MiB Private Vault upload → browser-side decrypt/download → SHA-256 exact-match result.
- Recorded direct-VLAN30 large-video preview behaviour and controlled ciphertext throughput measurements.
- Preserved the normal-file deterministic 1 MiB R2 upload → download → SHA-256 comparison as **pending**; this receipt does not promote unexecuted evidence to PASS.
- No production runtime, Docker, nginx, database, MikroTik, Switch, UFW, Twingate configuration, or Formal Report runtime state was changed by this documentation task.

### Field acceptance results

#### Direct VLAN30 path

- Laptop Ethernet: `192.168.30.10`
- Gateway: `192.168.30.1`
- AEGIS destination: `192.168.10.10:443`
- Direct HTTPS health: HTTP 200
- Result: **PASS**

#### Private Vault high-bitrate preview — START_LIVE.mp4

- Size: approximately 1.1 GB
- Duration: approximately 2 minutes
- First frame: approximately 8 s
- Continuous playback: more than 60 s
- Buffering/stutter during continuous play: none observed
- Seek approximately 0:30 → 1:18: approximately 5 s transition, approximately 3 s loading, then playback resumed
- Virtual media response: HTTP 206
- Ciphertext chunks: HTTP 200, approximately 16.8 MiB
- Result: **PASS on direct VLAN30**

#### Private Vault large-normal preview — approximately 323 MB / 17:48

- First frame: approximately 45–48 s
- Continuous playback 60 s: PASS
- Buffering/stutter: none observed
- Seek 1:09 → 6:30: approximately 1–2 s
- Seek 8:40 → 15:30: approximately 6 s
- Repeated short seeks: PASS
- Result: **FUNCTIONAL PASS with startup-latency note**

#### Direct VLAN30 ciphertext throughput

- 1 parallel: 16.00 MiB / 1.57 s = **10.17 MiB/s**
- 2 parallel: 32.00 MiB / 3.04 s = **10.53 MiB/s**
- 4 parallel: 64.00 MiB / 6.12 s = **10.46 MiB/s**

Previous controlled remote-path evidence was approximately 4.65 / 4.22 / 4.26 MiB/s for 1/2/4 parallel fetches. The accepted conclusion is a **remote delivery-environment/network-path limitation**. Twingate alone was not isolated as the sole cause.

#### Private Vault deterministic integrity round trip

- Plaintext size: 2,097,152 bytes
- Expected/pre-upload SHA-256: `91d3beb88a9b2f778a6c44a1c53b63d3c79931845a9aef84b3fb414610bd1938`
- Vault upload: PASS
- Browser-side download/decrypt: PASS
- Recovered size: 2,097,152 bytes
- Recovered SHA-256: exact match
- Result: **VAULT_2MIB_SHA256=PASS**

#### Restricted Secure Share

Configured network zone:

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
- the same restricted share returned “This link is restricted … outside that range”
- file download denied
- Result: **OUTSIDE-ZONE DENY = PASS**

## Source files changed

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — adds the current on-site file/share acceptance evidence and preserves the normal-file R2 remaining item.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-02_202000_kla_idea1-onsite-file-share-acceptance.md` — this immutable IDEA1 task receipt.

No application source, runtime configuration, database schema, deployment manifest, or infrastructure configuration is changed.

## Verification evidence

- `curl.exe --interface 192.168.30.10 --resolve aegis.internal:443:192.168.10.10 --ssl-revoke-best-effort -sS -D - -o NUL https://aegis.internal/drive/healthz` — **PASS**, HTTP 200 over the direct VLAN30 path.
- `Test-NetConnection aegis.internal -Port 443 -InformationLevel Detailed` — **PASS** on the direct path with `InterfaceAlias=Ethernet`, `SourceAddress=192.168.30.10`, and `TcpTestSucceeded=True`.
- After removing the temporary host route/hosts override and reconnecting Twingate, `Resolve-DnsName aegis.internal -Type A` — **PASS**, resolved to `100.96.97.113`.
- `Test-NetConnection aegis.internal -Port 443 -InformationLevel Detailed` on the restored remote path — **PASS** for AEGIS reachability with `InterfaceAlias=Twingate`, `SourceAddress=100.127.255.172`, and `TcpTestSucceeded=True`; the restricted share itself was then correctly denied as outside the allowed CIDR.
- Browser acceptance — **PASS**: the ~1.1 GB high-bitrate Vault video rendered the first frame in ~8 s and played continuously for more than 60 s without buffering on direct VLAN30; the ~323 MB video also passed sustained playback and seek/resume checks.
- Vault integrity acceptance — **PASS**: 2,097,152-byte plaintext recovered after browser-side decrypt/download with SHA-256 exactly matching `91d3beb88a9b2f778a6c44a1c53b63d3c79931845a9aef84b3fb414610bd1938`.
- Restricted Share acceptance — **PASS**: VLAN30 `192.168.30.10` allowed using the real link; the same link was denied over the outside-zone/Twingate path.
- Controlled ciphertext benchmark — **PASS**: aggregate direct throughput measured 10.17 / 10.53 / 10.46 MiB/s at 1/2/4 parallel fetches.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the current on-site Direct VLAN30, Private Vault, Secure Share, throughput, remote-path limitation, and remaining normal-file R2 evidence.
- Existing Dashboard production closure and earlier Secure Share production evidence remain unchanged; this task supplements them rather than rewriting their history.

## Shared surfaces touched

None — this is an IDEA1-only documentation update. No IDEA2, IDEA3, infrastructure, gateway, Compose, PostgreSQL, shared schema, or other owner-scoped path is changed.

## Integration requests

None — no cross-scope integration review is required because the PR changes only IDEA1-owned canonical documentation plus one IDEA1 task receipt.

## Known limitations

- Do not claim Twingate alone is the root cause of remote high-bitrate preview performance; the evidence supports the broader **remote delivery environment / network path** classification.
- Do not claim the approximately 45–48 s first-frame delay of the ~323 MB video is caused by MP4 `moov` placement; that remains an unproven hypothesis.
- Do not mark the dedicated current-session normal-file deterministic 1 MiB R2 upload → download → SHA-256 round trip PASS until that exact round trip is directly observed.
- If the team wants a separate formal large-file-storage closure for files greater than 1 GiB, the storage acceptance criterion should be upload + download + integrity/hash; preview performance is a separate capability.
- Public External Share remains outside this on-site restricted-share acceptance and is not claimed implemented by this receipt.
