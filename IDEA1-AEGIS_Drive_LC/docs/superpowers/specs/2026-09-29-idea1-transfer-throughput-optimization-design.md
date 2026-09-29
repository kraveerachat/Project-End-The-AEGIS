# AEGIS IDEA1 Transfer Throughput Optimization Design

Status: DIAGNOSIS COMPLETE TO CURRENT GATE / NO_SAFE_APP_FIX_PROVEN
Task: LFT-PERF-1 / PR216
Area / owner: IDEA1 / kla
Production mutation: HUMAN OWNER ONLY / NOT AUTHORIZED
Application mutation: NONE PROVEN / SKIPPED
Root cause: P1_SHARED_PATH_CAPACITY_LIMITER (PROVEN LIVE 100 Mbps ROUTER TRUNK CEILING)
Current production hardware: RB750r2 + TL-SG105E (REPLACEMENT NOT AUTHORIZED)

## 1. Goal

Increase AEGIS IDEA1 upload and download throughput as far as the current client, server, storage, LAN, Internet, and Twingate path can safely sustain, with Remote/Twingate and Direct LAN as the primary optimization targets.

The optimization applies to the shared platform behavior, not to one account. It MUST work for:

- existing administrator accounts;
- existing normal user accounts;
- accounts created in the future;
- Normal Files transfer paths;
- Private Vault transfer paths where the same optimization is compatible with the Vault cryptographic boundary.

No per-user performance override, hard-coded user identity, administrator-only fast path, or migration that leaves future accounts on an older transfer path is allowed.

Media preview responsiveness is a secondary objective. Transfer throughput takes priority.

## 2. Success definition

The implementation is successful only when controlled POST-FIX measurements show a material improvement over the accepted PRE-FIX baselines without weakening integrity, authentication, authorization, encryption, resumability, recovery, or storage correctness.

The platform SHOULD approach the useful capacity of the path available to the user at that time. The design does not promise an arbitrary fixed rate such as 10 MB/s because available Internet capacity, latency, packet loss, Twingate overhead, client capability, server capability, and storage performance vary. A 10 MB/s or higher Remote result is desirable when the measured path can support it, but it is not a correctness contract.

Direct LAN is expected to remain faster than Remote/Twingate when the network path is the limiting factor. A shared application bottleneck that is removed for Remote MUST also be measured on LAN to verify that LAN benefits rather than regresses.

## 3. Accepted PRE-FIX evidence

PR216 already contains the canonical controlled baseline matrix. The important accepted observations are:

- P1 Direct LAN Files upload is approximately 5.06-5.17 MB/s median across 100 MB, 300 MB, and 1 GB fixtures.
- P2 Remote/Twingate Files upload is approximately 2.98-3.08 MB/s median across the same fixtures.
- P1 Direct LAN Files download is approximately 6.7-7.3 MB/s median.
- P2 Remote/Twingate Files download is approximately 4.8-5.1 MB/s median.
- C1 Public Share download is approximately 11.7-13.5 MB/s median and demonstrates that the host/storage/network stack can deliver materially above the authenticated Files path under a different request architecture.
- Twingate therefore contributes observable overhead but is NOT proven to be the sole bottleneck.
- ROOT_CAUSE remains NOT_PROVEN until diagnosis isolates the limiting stage.

Historical observations and raw run labels remain immutable and must not be rewritten.

## 4. Optimization order

Optimization MUST proceed by evidence, in this order.

### 4.1 Upload critical path

Measure and separate:

1. client incremental hashing time;
2. session creation time;
3. per-chunk request transfer time;
4. per-chunk request idle/RTT gap;
5. retry/backoff time;
6. server write time;
7. commit/checksum verification time;
8. storage wait and host resource saturation.

Current Normal Files source sends missing chunks through a sequential awaited loop. This is a high-priority hypothesis because a one-request-at-a-time flow can amplify RTT on Remote paths. It MUST be proven with measurements before mutation.

If sequential transfer is proven limiting, the preferred implementation is bounded/adaptive parallelism rather than unbounded concurrency. The optimizer may increase useful in-flight work while preserving exact chunk identity, resumability, retry semantics, progress accounting, cancellation, checksum verification, and recovery after browser refresh.

Vault upload already has a bounded concurrency model. Normal Files and Vault SHOULD share the same policy principles where possible, while Vault encryption and zero-knowledge requirements remain authoritative.

### 4.2 Download critical path

Measure and compare the authenticated Files download path, Vault download path, and the already-faster Public Share read path without conflating their security models.

Diagnose:

- response startup latency / TTFB;
- stream backpressure;
- request framing;
- proxy/gateway buffering;
- Range behavior where applicable;
- disk read behavior;
- server CPU and event-loop pressure;
- client-side buffering/decryption for Vault;
- path-specific network overhead.

Optimize the common authenticated read path only where evidence identifies the bottleneck. Do not copy Public Share security semantics into authenticated Files merely because Public Share is faster.

### 4.3 Media preview secondary optimization

Preview is lower priority than upload/download throughput.

For Normal Files, evaluate the existing poster/motion derivative and cache path for avoidable round trips, cold-cache delay, queue delay, and Range inefficiency.

For Private Vault video, preserve the zero-knowledge client-side decryption/range model. If Remote seek/startup suffers from RTT amplification, bounded read-ahead, range coalescing, or equivalent client-side request reduction may be considered only after measurement proves it useful.

Server-side plaintext Vault derivatives are forbidden.

## 5. Platform-wide account scope

Performance behavior MUST be determined by shared application/runtime policy and capability, not account identity.

Authorization continues to decide which objects an account can access. Performance policy MUST NOT special-case administrator identities or existing user IDs.

Tests must include at least:

- administrator account transfer;
- normal user account transfer;
- newly-created user account transfer;
- cross-owner access denial unchanged;
- concurrent transfers from multiple authorized accounts without data mixing or progress/session collision.

Future accounts automatically inherit the same transfer implementation because there is one shared code path and shared bounded policy.

## 6. Safety invariants

The optimization MUST preserve all of the following:

- authentication and authorization boundaries;
- owner isolation;
- Vault zero-knowledge boundary;
- AES-GCM/chunk cryptographic rules for Vault;
- server-side checksum/integrity verification;
- resumable missing-chunk semantics;
- refresh recovery and same-file identity checks;
- cancellation and retry behavior;
- logical file limit/capacity rejection truthfulness;
- no whole-file browser buffering regression;
- no unbounded memory, request, worker, or file-descriptor growth;
- no silent fallback from encrypted Vault transfer to plaintext;
- no Production mutation by an agent.

The logical maximum file-size ceiling is NOT automatically increased by this task. Throughput ceiling and logical file-size ceiling are separate controls. A file-size-limit change requires separate evidence that the current limit itself blocks the intended workload and must stay within the existing supported architecture ceiling.

## 7. Required diagnosis before implementation

Before any optimization patch, collect enough evidence to classify the dominant limiting stage for at least Normal Files upload and download.

A diagnosis must distinguish at minimum:

- RTT / request serialization;
- client CPU/hash/crypto;
- server CPU/event loop;
- storage I/O;
- application stream/backpressure;
- proxy/gateway behavior;
- Twingate/network path overhead.

One-variable experiments are preferred. Do not bundle chunk size, concurrency, proxy settings, and server buffering into one mutation because the result would not identify causality.

### 7.1 Authoritative live diagnosis summary (reconciled with PR #259)

Onsite probes (U2 upload, D1 download) and router/switch telemetry established:
- **P1 Direct LAN:** Bound by physical 100 Mbps inter-VLAN trunk (`RB750r2_ETHER2_LINK=100MBPS_FULL_DUPLEX`, `TP_LINK_PORT1_TRUNK=100MF`). Single and dual streams saturate ~10.1–11.1 MB/s (91–95% of Fast Ethernet goodput).
- **Application Layer:** No upload or download defect proven (`APPLICATION_DEFECT_PROVEN=NO`, `SAFE_APP_LAYER_FIX=NONE_PROVEN`). Task 2 upload concurrency is skipped as unjustified (`TASK2_UPLOAD_CONCURRENCY=SKIPPED_NOT_JUSTIFIED`). Task 5 download optimization has no safe app fix proven (`DOWNLOAD_OPTIMIZATION=NO_SAFE_APP_FIX_PROVEN`).
- **Production Hardware:** Frozen at MikroTik hEX lite RB750r2 + TP-Link TL-SG105E (`CURRENT_PRODUCTION_ARCHITECTURE=RB750r2_PLUS_TL-SG105E`). Hardware replacement, procurement, and cable cutover are NOT authorized (`HARDWARE_REPLACEMENT_AUTHORIZED=NO`). Remediation design in PR #259 is deferred optional future reference (`REPLACEMENT_WORK_STATE=DEFERRED_OPTIONAL_FUTURE_WORK`).
- **Remote Path (P2):** Residual limiter remains OPEN (`REMOTE_RESIDUAL_LIMITER=OPEN`).

## 8. Implementation strategy

Use TDD for every behavior change.

For each proven bottleneck:

1. add a failing test or controlled benchmark assertion that exposes the limiting behavior or safety invariant;
2. verify RED;
3. implement the smallest production change addressing the proven cause;
4. verify GREEN and all relevant regressions;
5. run controlled benchmark comparison;
6. keep the change only if improvement is material and safety invariants remain green.

If three independent optimization attempts fail to improve the same bottleneck, stop patch stacking and reassess the architecture before a fourth attempt.

## 9. Measurement / acceptance matrix

POST-FIX acceptance reuses the same fixture sizes and measurement method as PRE-FIX wherever possible so results remain comparable.

Primary matrix:

- P1 Direct LAN Files upload: 100 MB, 300 MB, 1 GB, three runs each;
- P1 Direct LAN Files download: 100 MB, 300 MB, 1 GB, three runs each;
- P2 Remote/Twingate Files upload: 100 MB, 300 MB, 1 GB, three runs each;
- P2 Remote/Twingate Files download: 100 MB, 300 MB, 1 GB, three runs each.

Supplementary acceptance:

- administrator account;
- normal account;
- newly-created account;
- Vault upload/download representative fixture;
- concurrent multi-account isolation;
- preview cold/warm and video seek/startup samples when preview optimization is changed.

Report median, min, max, mean, failure/retry count, and relevant latency breakdown. Do not claim a path ceiling from one run.

## 10. Decision rules

- Prefer the change with the largest verified throughput gain that preserves invariants and has bounded resource cost.
- Remote improvement is the primary user-value target; LAN must not regress.
- If a shared application bottleneck is fixed, measure both P1 and P2 because both are expected to benefit.
- If Remote remains slower after the shared bottleneck is removed, classify the residual difference separately rather than disguising it as an application failure.
- Do not tune for a benchmark by disabling integrity checks, encryption, auth, recovery, or durability.
- Do not declare Twingate, storage, router, switch, client crypto, or server code the root cause without isolating evidence.

## 11. Production governance

Human Owner performs all Production mutations and final merge actions.

Agents may inspect source, implement/test on development branches, prepare diagnostic commands, analyze Human-run evidence, and prepare rollout instructions.

Forbidden Production actions remain unchanged: no broad Docker prune, no compose down, no broad service recreate, no destructive rollback, no direct edit of Production compose/environment, and no secret output.

## 12. Immediate execution gate

The approved direction is performance-first and platform-wide:

- maximize upload/download throughput safely;
- prioritize Remote/Twingate and Direct LAN;
- apply shared behavior to admin, current users, and future users;
- cover Normal Files and Private Vault;
- improve preview where evidence justifies it, without delaying the main transfer work;
- continue optimization if the first verified improvement leaves a clearly proven application bottleneck.

Implementation may begin only after this written spec is reviewed by the Human Owner, per the project development workflow.
